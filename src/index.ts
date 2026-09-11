import "./config/env";
import { TAKER_FEES } from "./config/fees";
import {
  INITIAL_BINANCE_ETH,
  INITIAL_BINANCE_USDT,
  INITIAL_INDODAX_ETH,
  INITIAL_INDODAX_USDT,
  LIVE_TRADING,
  MIN_BALANCE_PCT,
  TRADE_LIMIT_USD,
} from "./config/trading";
import { subscribeBinanceOrderBook } from "./exchanges/binance";
import { logExchangeBalances } from "./exchanges/balances";
import { subscribeIndodaxOrderBook } from "./exchanges/indodax";
import { OrderBookQuote } from "./types/quote";
import {
  assertLiveTradingCredentials,
  tryExecuteOpportunities,
  TradeOpportunity,
} from "./trading/executor";
import {
  formatNotionalSkip,
  getRequiredEth,
  hasSufficientLiquidity,
  hasSufficientTopOfBookNotional,
} from "./trading/liquidity";
import {
  ArbitrageDirection,
  TradeProgressTracker,
} from "./trading/progress";
import { createWalletTracker, WalletTracker } from "./trading/wallet";

interface SpreadResult {
  diff: number;
  diffLabel: string;
  pct: number;
  pctLabel: string;
}

interface ArbitrageOpportunity {
  label: string;
  direction: ArbitrageDirection;
  spread: SpreadResult;
  buyAskPrice: number;
  buyAskQty: number;
  sellBidPrice: number;
  sellBidQty: number;
  buyAskPriceText: string;
  sellBidPriceText: string;
  buyTakerFee: number;
  sellTakerFee: number;
}

const quotes: Record<string, OrderBookQuote> = {};
const tradeProgress = new TradeProgressTracker();
const wallet = createWalletTracker();
let lastSpreadKey = "";
let spreadLogInFlight = false;

function formatSpread(
  sellBid: string,
  buyAsk: string,
  sellTakerFee: number,
  buyTakerFee: number,
): SpreadResult {
  const bidNum = Number(sellBid);
  const askNum = Number(buyAsk);
  const buyCost = askNum * (1 + buyTakerFee);
  const sellProceeds = bidNum * (1 - sellTakerFee);
  const diff = sellProceeds - buyCost;
  const pct = buyCost === 0 ? 0 : (diff / buyCost) * 100;

  return {
    diff,
    diffLabel: diff.toFixed(2),
    pct,
    pctLabel: pct.toFixed(4),
  };
}

function formatSpreadLabel(direction: string, spread: SpreadResult): string {
  const status = spread.diff > 0 ? "PROFIT" : "NO PROFIT";
  return `${direction}: ${spread.diffLabel} (${spread.pctLabel}% after fees) [${status}]`;
}

function buildTradeOpportunity(
  opportunity: ArbitrageOpportunity,
  walletTracker: WalletTracker,
): TradeOpportunity | null {
  const {
    spread,
    buyAskPrice,
    buyAskQty,
    sellBidQty,
    buyTakerFee,
    sellTakerFee,
    sellBidPrice,
    direction,
  } = opportunity;

  if (spread.diff <= 0 || walletTracker.isHalted()) {
    return null;
  }

  if (
    !hasSufficientLiquidity(
      buyAskPrice,
      buyAskQty,
      sellBidPrice,
      sellBidQty,
      TRADE_LIMIT_USD,
    )
  ) {
    return null;
  }

  const tradeSizeEth = getRequiredEth(buyAskPrice, TRADE_LIMIT_USD);
  const settlement = {
    direction,
    tradeSizeEth,
    buyAskPrice,
    sellBidPrice,
    buyTakerFee,
    sellTakerFee,
  };

  if (!walletTracker.canExecute(settlement)) {
    return null;
  }

  return {
    direction,
    profitPerEth: spread.diff,
    profitPct: spread.pct,
    tradeSizeEth,
    tradeNotionalUsd: TRADE_LIMIT_USD,
    buyAskPrice,
    sellBidPrice,
    buyAskQty,
    sellBidQty,
    buyAskPriceText: opportunity.buyAskPriceText,
    sellBidPriceText: opportunity.sellBidPriceText,
    buyTakerFee,
    sellTakerFee,
  };
}

function getLiquiditySkipReason(
  opportunity: ArbitrageOpportunity,
): string | null {
  if (opportunity.spread.diff <= 0) {
    return null;
  }

  if (
    !hasSufficientTopOfBookNotional(
      opportunity.buyAskPrice,
      opportunity.buyAskQty,
      TRADE_LIMIT_USD,
    )
  ) {
    return formatNotionalSkip(
      opportunity.label,
      "ask",
      opportunity.buyAskPrice,
      opportunity.buyAskQty,
    );
  }

  if (
    !hasSufficientTopOfBookNotional(
      opportunity.sellBidPrice,
      opportunity.sellBidQty,
      TRADE_LIMIT_USD,
    )
  ) {
    return formatNotionalSkip(
      opportunity.label,
      "bid",
      opportunity.sellBidPrice,
      opportunity.sellBidQty,
    );
  }

  return null;
}

function getWalletSkipReason(
  opportunity: ArbitrageOpportunity,
  walletTracker: WalletTracker,
): string | null {
  if (opportunity.spread.diff <= 0) {
    return null;
  }

  const tradeSizeEth = getRequiredEth(opportunity.buyAskPrice, TRADE_LIMIT_USD);
  const reason = walletTracker.getAffordabilityReason({
    direction: opportunity.direction,
    tradeSizeEth,
    buyAskPrice: opportunity.buyAskPrice,
    sellBidPrice: opportunity.sellBidPrice,
    buyTakerFee: opportunity.buyTakerFee,
    sellTakerFee: opportunity.sellTakerFee,
  });

  if (!reason) {
    return null;
  }

  return `${opportunity.label}: ${reason}`;
}

function logSpread(): void {
  if (wallet.isHalted()) {
    return;
  }

  void logSpreadAsync();
}

async function logSpreadAsync(): Promise<void> {
  if (spreadLogInFlight) {
    return;
  }

  spreadLogInFlight = true;

  try {
    await logSpreadLocked();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Spread] Failed to evaluate/execute:", message);
  } finally {
    spreadLogInFlight = false;
  }
}

async function logSpreadLocked(): Promise<void> {
  const binance = quotes.Binance;
  const indodax = quotes.Indodax;
  if (!binance || !indodax) {
    return;
  }

  const candidates: ArbitrageOpportunity[] = [
    {
      label: "Buy Binance / Sell Indodax",
      direction: "buy-binance-sell-indodax",
      buyAskPrice: Number(binance.bestAsk),
      buyAskQty: Number(binance.bestAskQty),
      sellBidPrice: Number(indodax.bestBid),
      sellBidQty: Number(indodax.bestBidQty),
      buyAskPriceText: binance.bestAsk,
      sellBidPriceText: indodax.bestBid,
      buyTakerFee: TAKER_FEES.binance,
      sellTakerFee: TAKER_FEES.indodax.sell,
      spread: formatSpread(
        indodax.bestBid,
        binance.bestAsk,
        TAKER_FEES.indodax.sell,
        TAKER_FEES.binance,
      ),
    },
    {
      label: "Buy Indodax / Sell Binance",
      direction: "buy-indodax-sell-binance",
      buyAskPrice: Number(indodax.bestAsk),
      buyAskQty: Number(indodax.bestAskQty),
      sellBidPrice: Number(binance.bestBid),
      sellBidQty: Number(binance.bestBidQty),
      buyAskPriceText: indodax.bestAsk,
      sellBidPriceText: binance.bestBid,
      buyTakerFee: TAKER_FEES.indodax.buy,
      sellTakerFee: TAKER_FEES.binance,
      spread: formatSpread(
        binance.bestBid,
        indodax.bestAsk,
        TAKER_FEES.binance,
        TAKER_FEES.indodax.buy,
      ),
    },
  ];

  const spreadKey = candidates
    .map((opportunity) => formatSpreadLabel(opportunity.label, opportunity.spread))
    .join(" | ");

  if (spreadKey === lastSpreadKey) {
    return;
  }

  lastSpreadKey = spreadKey;

  const tradeOpportunities = candidates
    .map((opportunity) => buildTradeOpportunity(opportunity, wallet))
    .filter((opportunity): opportunity is TradeOpportunity => opportunity !== null);

  const skippedLabels = [
    ...candidates
      .map(getLiquiditySkipReason)
      .filter((reason): reason is string => reason !== null),
    ...candidates
      .map((opportunity) => getWalletSkipReason(opportunity, wallet))
      .filter((reason): reason is string => reason !== null),
  ];

  const executedLabels = await tryExecuteOpportunities(
    tradeOpportunities,
    tradeProgress,
    wallet,
  );

  const executionSuffix =
    executedLabels.length > 0
      ? ` | [EXECUTED: ${executedLabels.join(", ")}]`
      : "";
  const skippedSuffix =
    skippedLabels.length > 0
      ? ` | [SKIPPED: ${skippedLabels.join(", ")}]`
      : "";
  const haltedSuffix = wallet.isHalted() ? " | [HALTED]" : "";
  const progressSuffix =
    tradeProgress.getTradeCount() > 0
      ? ` | ${tradeProgress.getSummary()}`
      : "";

  console.log(
    `[Spread] ${spreadKey}${executionSuffix}${skippedSuffix}${haltedSuffix}${progressSuffix}`,
  );
}

function quoteChanged(prev: OrderBookQuote, next: OrderBookQuote): boolean {
  return (
    prev.bestBid !== next.bestBid ||
    prev.bestBidQty !== next.bestBidQty ||
    prev.bestAsk !== next.bestAsk ||
    prev.bestAskQty !== next.bestAskQty
  );
}

function logQuotes(exchange: string, quote: OrderBookQuote): void {
  const prev = quotes[exchange];
  if (prev && !quoteChanged(prev, quote)) {
    return;
  }

  quotes[exchange] = quote;
  logSpread();
}

subscribeBinanceOrderBook((quote) => {
  logQuotes("Binance", quote);
});

subscribeIndodaxOrderBook((quote) => {
  logQuotes("Indodax", quote);
});

console.log("Subscribing to Ethereum order books on Binance and Indodax...");
assertLiveTradingCredentials();
console.log(
  LIVE_TRADING
    ? "Live trading: ON — real market orders will be placed"
    : "Live trading: OFF — simulation only (set LIVE_TRADING=true to place real orders)",
);
console.log(
  `Taker fees: Binance ${(TAKER_FEES.binance * 100).toFixed(4)}%, Indodax buy ${(TAKER_FEES.indodax.buy * 100).toFixed(4)}% / sell ${(TAKER_FEES.indodax.sell * 100).toFixed(4)}%`,
);
console.log(`Trade size: $${TRADE_LIMIT_USD.toFixed(2)} per execution`);
console.log(
  `Initial wallet: Binance ETH ${INITIAL_BINANCE_ETH}, USDT ${INITIAL_BINANCE_USDT} | Indodax ETH ${INITIAL_INDODAX_ETH}, USDT ${INITIAL_INDODAX_USDT}`,
);
console.log(
  `Trading stops when any balance falls to ${(MIN_BALANCE_PCT * 100).toFixed(0)}% of initial`,
);
console.log(`[Wallet] ${wallet.formatBalances()}`);
void logExchangeBalances();

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
let elapsedMinutes = 0;

setInterval(() => {
  elapsedMinutes += 5;
  console.log(`${elapsedMinutes} minutes elapsed`);
  void logExchangeBalances();
}, HEARTBEAT_INTERVAL_MS);
