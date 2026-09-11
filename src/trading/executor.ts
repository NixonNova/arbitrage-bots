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
  buyAskQty: number;
  sellBidQty: number;
  buyAskPriceText: string;
  sellBidPriceText: string;
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
  limitPrice?: number,
  limitPriceText?: string,
): Promise<PlacedOrder> {
  const request = {
    side,
    quantityEth,
    quoteAmountUsdt,
    limitPrice,
    limitPriceText,
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
  first: PlacedOrder,
  secondExchange: ExchangeName,
  secondSide: "BUY" | "SELL",
  detail: string,
): void {
  const reason =
    `unpaired pair: ${first.exchange} ${first.side} filled (order ${first.orderId}, ${first.executedQtyEth.toFixed(8)} ETH) but ${secondExchange} ${secondSide} failed (${detail})`;
  console.error(`[Trade] CRITICAL: ${reason}`);
  wallet.halt(reason);
}

async function executeLivePair(
  opportunity: TradeOpportunity,
  wallet: WalletTracker,
): Promise<void> {
  const legs = DIRECTION_LEGS[opportunity.direction];
  const stamp = Date.now().toString(36);
  const indodaxClientId = `arb1${stamp}`.slice(0, 36);
  const binanceClientId = `arb2${stamp}`.slice(0, 36);

  const indodaxSide: "BUY" | "SELL" =
    legs.buyExchange === "indodax" ? "BUY" : "SELL";
  const binanceSide: "BUY" | "SELL" = indodaxSide === "BUY" ? "SELL" : "BUY";

  const indodaxQty = quantityForExchange("indodax", opportunity.tradeSizeEth);
  const binanceQty = quantityForExchange("binance", opportunity.tradeSizeEth);
  if (!(indodaxQty > 0) || !(binanceQty > 0)) {
    throw new OrderError(
      "indodax",
      `Skipping pair: size ${opportunity.tradeSizeEth} ETH is below lot size`,
    );
  }

  if (indodaxSide === "BUY" && indodaxQty > opportunity.buyAskQty) {
    throw new OrderError(
      "indodax",
      `Skipping buy: qty ${indodaxQty} ETH exceeds best-ask size ${opportunity.buyAskQty}`,
    );
  }
  if (indodaxSide === "SELL" && indodaxQty > opportunity.sellBidQty) {
    throw new OrderError(
      "indodax",
      `Skipping sell: qty ${indodaxQty} ETH exceeds best-bid size ${opportunity.sellBidQty}`,
    );
  }

  console.log(
    `[Trade] Leg 1/2: indodax ${indodaxSide} ${indodaxQty.toFixed(8)} ETH (~$${opportunity.tradeNotionalUsd.toFixed(2)})`,
  );

  const first = await placeMarketOrder(
    "indodax",
    indodaxSide,
    indodaxQty,
    indodaxSide === "BUY" ? opportunity.tradeNotionalUsd : undefined,
    indodaxClientId,
    indodaxSide === "BUY" ? opportunity.buyAskPrice : opportunity.sellBidPrice,
    indodaxSide === "BUY" ? opportunity.buyAskPriceText : opportunity.sellBidPriceText,
  );

  console.log(
    `[Trade] Leg 1 filled: ${first.exchange} order ${first.orderId} qty ${first.executedQtyEth.toFixed(8)} ETH`,
  );

  const filledIndodaxQty = quantityForExchange("indodax", first.executedQtyEth);
  if (!(filledIndodaxQty > 0)) {
    const detail = `Indodax fill ${first.executedQtyEth} ETH is below lot size`;
    haltUnpairedFill(wallet, first, "binance", binanceSide, detail);
    throw new OrderError("indodax", detail);
  }

  const secondQty = quantityForExchange("binance", filledIndodaxQty);
  if (!(secondQty > 0)) {
    const detail = `Indodax fill ${first.executedQtyEth} ETH is below Binance lot size`;
    haltUnpairedFill(wallet, first, "binance", binanceSide, detail);
    throw new OrderError("binance", detail);
  }

  if (binanceSide === "BUY" && secondQty > opportunity.buyAskQty) {
    const detail = `buy qty ${secondQty} ETH exceeds best-ask size ${opportunity.buyAskQty}`;
    haltUnpairedFill(wallet, first, "binance", binanceSide, detail);
    throw new OrderError("binance", detail);
  }
  if (binanceSide === "SELL" && secondQty > opportunity.sellBidQty) {
    const detail = `sell qty ${secondQty} ETH exceeds best-bid size ${opportunity.sellBidQty}`;
    haltUnpairedFill(wallet, first, "binance", binanceSide, detail);
    throw new OrderError("binance", detail);
  }

  console.log(
    `[Trade] Leg 2/2: binance ${binanceSide} ${secondQty.toFixed(8)} ETH`,
  );

  try {
    const second = await placeMarketOrder(
      "binance",
      binanceSide,
      secondQty,
      undefined,
      binanceClientId,
    );
    console.log(
      `[Trade] Leg 2 filled: ${second.exchange} order ${second.orderId} qty ${second.executedQtyEth.toFixed(8)} ETH`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    haltUnpairedFill(wallet, first, "binance", binanceSide, message);
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
