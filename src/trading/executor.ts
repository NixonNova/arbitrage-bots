import {
  BINANCE_QTY_DECIMALS,
  INDODAX_QTY_DECIMALS,
} from "../config/market";
import { LIVE_TRADING } from "../config/trading";
import { optionalEnv } from "../config/env";
import { placeBinanceMarketOrder } from "../exchanges/binanceTrade";
import { placeIndodaxMarketOrder } from "../exchanges/indodaxTrade";
import {
  OrderError,
  isMarketOrderInFlight,
  roundDown,
  type ExchangeName,
  type PlacedOrder,
} from "../exchanges/orders";
import {
  ArbitrageDirection,
  createExecutedTrade,
  ExecutedTrade,
  TradeProgressTracker,
} from "./progress";
import { WalletTracker } from "./wallet";

const DIRECTION_LABELS: Record<ArbitrageDirection, string> = {
  "buy-binance-sell-indodax": "Buy Binance / Sell Indodax",
  "buy-indodax-sell-binance": "Buy Indodax / Sell Binance",
};

export interface TradeOpportunity {
  direction: ArbitrageDirection;
  profitPerEth: number;
  profitPct: number;
  tradeSizeEth: number;
  tradeNotionalUsd: number;
  buyAskPrice: number;
  sellBidPrice: number;
  buyTakerFee: number;
  sellTakerFee: number;
}

interface ArbLegs {
  buyExchange: ExchangeName;
  sellExchange: ExchangeName;
}

const DIRECTION_LEGS: Record<ArbitrageDirection, ArbLegs> = {
  "buy-binance-sell-indodax": {
    buyExchange: "binance",
    sellExchange: "indodax",
  },
  "buy-indodax-sell-binance": {
    buyExchange: "indodax",
    sellExchange: "binance",
  },
};

let executionInFlight = false;

export function assertLiveTradingCredentials(): void {
  if (!LIVE_TRADING) {
    return;
  }

  const missing = [
    "BINANCE_API_KEY",
    "BINANCE_API_SECRET",
    "INDODAX_API_KEY",
    "INDODAX_API_SECRET",
  ].filter((name) => !optionalEnv(name));

  if (missing.length > 0) {
    throw new Error(
      `LIVE_TRADING is enabled but missing: ${missing.join(", ")}`,
    );
  }
}

async function placeMarketOrder(
  exchange: ExchangeName,
  side: "BUY" | "SELL",
  quantityEth: number,
  quoteAmountUsdt: number | undefined,
  clientOrderId: string,
): Promise<PlacedOrder> {
  const request = {
    side,
    quantityEth,
    quoteAmountUsdt,
    clientOrderId,
  };

  if (exchange === "binance") {
    return placeBinanceMarketOrder(request);
  }

  return placeIndodaxMarketOrder(request);
}

function quantityForExchange(exchange: ExchangeName, eth: number): number {
  const decimals =
    exchange === "binance" ? BINANCE_QTY_DECIMALS : INDODAX_QTY_DECIMALS;
  return roundDown(eth, decimals);
}

function haltUnpairedFill(
  wallet: WalletTracker,
  buy: PlacedOrder,
  sellExchange: ExchangeName,
  detail: string,
): void {
  const reason =
    `unpaired pair: ${buy.exchange} BUY filled (order ${buy.orderId}, ${buy.executedQtyEth.toFixed(8)} ETH) but ${sellExchange} SELL failed (${detail})`;
  console.error(`[Trade] CRITICAL: ${reason}`);
  wallet.halt(reason);
}

async function executeLivePair(
  opportunity: TradeOpportunity,
  wallet: WalletTracker,
): Promise<{ buy: PlacedOrder; sell: PlacedOrder }> {
  const legs = DIRECTION_LEGS[opportunity.direction];
  const stamp = Date.now().toString(36);
  const buyClientId = `arb1${stamp}`.slice(0, 36);
  const sellClientId = `arb2${stamp}`.slice(0, 36);

  const buyQty = quantityForExchange(legs.buyExchange, opportunity.tradeSizeEth);
  const plannedSellQty = quantityForExchange(legs.sellExchange, buyQty);
  if (!(buyQty > 0)) {
    throw new OrderError(
      legs.buyExchange,
      `Skipping buy: planned size ${opportunity.tradeSizeEth} ETH is below buy lot size`,
    );
  }
  if (!(plannedSellQty > 0)) {
    throw new OrderError(
      legs.sellExchange,
      `Skipping pair: buy qty ${buyQty} ETH is below sell lot size`,
    );
  }

  console.log(
    `[Trade] Leg 1/2: ${legs.buyExchange} BUY ${buyQty.toFixed(8)} ETH (~$${opportunity.tradeNotionalUsd.toFixed(2)})`,
  );

  const buy = await placeMarketOrder(
    legs.buyExchange,
    "BUY",
    buyQty,
    opportunity.tradeNotionalUsd,
    buyClientId,
  );

  console.log(
    `[Trade] Leg 1 filled: ${buy.exchange} order ${buy.orderId} qty ${buy.executedQtyEth.toFixed(8)} ETH`,
  );

  const filledBuyQty = quantityForExchange(legs.buyExchange, buy.executedQtyEth);
  if (!(filledBuyQty > 0)) {
    const detail = `buy fill ${buy.executedQtyEth} ETH is below buy lot size`;
    haltUnpairedFill(wallet, buy, legs.sellExchange, detail);
    throw new OrderError(legs.buyExchange, `Skipping sell: ${detail}`);
  }

  const sellQty = quantityForExchange(legs.sellExchange, filledBuyQty);
  if (!(sellQty > 0)) {
    const detail = `buy fill ${buy.executedQtyEth} ETH is below sell lot size`;
    haltUnpairedFill(wallet, buy, legs.sellExchange, detail);
    throw new OrderError(legs.sellExchange, `Skipping sell: ${detail}`);
  }

  console.log(
    `[Trade] Leg 2/2: ${legs.sellExchange} SELL ${sellQty.toFixed(8)} ETH`,
  );

  try {
    const sell = await placeMarketOrder(
      legs.sellExchange,
      "SELL",
      sellQty,
      undefined,
      sellClientId,
    );
    console.log(
      `[Trade] Leg 2 filled: ${sell.exchange} order ${sell.orderId} qty ${sell.executedQtyEth.toFixed(8)} ETH`,
    );
    return { buy, sell };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    haltUnpairedFill(wallet, buy, legs.sellExchange, message);
    throw error;
  }
}

export async function executeArbitrage(
  opportunity: TradeOpportunity,
  wallet: WalletTracker,
): Promise<ExecutedTrade | null> {
  const result = await executeArbitrageAttempt(opportunity, wallet);
  return result.trade;
}

async function executeArbitrageAttempt(
  opportunity: TradeOpportunity,
  wallet: WalletTracker,
): Promise<{ trade: ExecutedTrade | null; attemptedLive: boolean }> {
  const settlement = {
    direction: opportunity.direction,
    tradeSizeEth: opportunity.tradeSizeEth,
    buyAskPrice: opportunity.buyAskPrice,
    sellBidPrice: opportunity.sellBidPrice,
    buyTakerFee: opportunity.buyTakerFee,
    sellTakerFee: opportunity.sellTakerFee,
  };

  if (!wallet.canExecute(settlement)) {
    return { trade: null, attemptedLive: false };
  }

  console.log(
    `[Trade] Executing ${DIRECTION_LABELS[opportunity.direction]} | $${opportunity.tradeNotionalUsd.toFixed(2)} (${opportunity.tradeSizeEth.toFixed(8)} ETH) | est. profit ${(opportunity.profitPerEth * opportunity.tradeSizeEth).toFixed(4)} USDT (${opportunity.profitPct.toFixed(4)}%)`,
  );

  if (LIVE_TRADING) {
    try {
      await executeLivePair(opportunity, wallet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Trade] Pair aborted: ${message}`);
      return { trade: null, attemptedLive: true };
    }
  } else {
    console.log("[Trade] Simulation only (LIVE_TRADING is off)");
  }

  const trade = createExecutedTrade(
    opportunity.direction,
    opportunity.profitPerEth,
    opportunity.profitPct,
    opportunity.tradeSizeEth,
    opportunity.tradeNotionalUsd,
  );

  wallet.applyTrade(settlement);
  console.log(`[Wallet] ${wallet.formatBalances()}`);

  return { trade, attemptedLive: LIVE_TRADING };
}

export async function tryExecuteOpportunities(
  opportunities: TradeOpportunity[],
  progress: TradeProgressTracker,
  wallet: WalletTracker,
): Promise<string[]> {
  if (wallet.isHalted() || executionInFlight || isMarketOrderInFlight()) {
    return [];
  }

  executionInFlight = true;
  const executedLabels: string[] = [];

  try {
    for (const opportunity of opportunities) {
      if (wallet.isHalted()) {
        break;
      }

      if (isMarketOrderInFlight()) {
        console.log(
          `[Trade] Skipping ${DIRECTION_LABELS[opportunity.direction]}: waiting for an in-flight market order response`,
        );
        break;
      }

      const { trade, attemptedLive } = await executeArbitrageAttempt(
        opportunity,
        wallet,
      );

      if (trade) {
        progress.record(trade);
        executedLabels.push(DIRECTION_LABELS[opportunity.direction]);
      }

      if (attemptedLive) {
        break;
      }
    }
  } finally {
    executionInFlight = false;
  }

  return executedLabels;
}
