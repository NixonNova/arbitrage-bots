import { TAKER_FEES } from "./config/fees";
import {
  INITIAL_BINANCE_BTC,
  INITIAL_BINANCE_USDT,
  INITIAL_INDODAX_BTC,
  INITIAL_INDODAX_USDT,
  MIN_BALANCE_PCT,
  TRADE_LIMIT_USD,
} from "./config/trading";
import { subscribeBinanceOrderBook } from "./exchanges/binance";
import { subscribeIndodaxOrderBook } from "./exchanges/indodax";
import { OrderBookQuote } from "./types/quote";
import { tryExecuteOpportunities, TradeOpportunity } from "./trading/executor";
import {
  getRequiredBtc,
  hasSufficientLiquidity,
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
  buyTakerFee: number;
  sellTakerFee: number;
}

const quotes: Record<string, OrderBookQuote> = {};
const tradeProgress = new TradeProgressTracker();
const wallet = createWalletTracker();
let lastSpreadKey = "";

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
    !hasSufficientLiquidity(buyAskPrice, buyAskQty, sellBidQty, TRADE_LIMIT_USD)
  ) {
    return null;
  }

  const tradeSizeBtc = getRequiredBtc(buyAskPrice, TRADE_LIMIT_USD);
  const settlement = {
    direction,
    tradeSizeBtc,
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
    profitPerBtc: spread.diff,
    profitPct: spread.pct,
    tradeSizeBtc,
    tradeNotionalUsd: TRADE_LIMIT_USD,
    buyAskPrice,
    sellBidPrice,
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

  const requiredBtc = getRequiredBtc(
    opportunity.buyAskPrice,
    TRADE_LIMIT_USD,
  );

  if (requiredBtc <= 0) {
    return `${opportunity.label}: invalid price`;
  }

  if (opportunity.buyAskQty < requiredBtc) {
    return `${opportunity.label}: insufficient ask liquidity`;
  }

  if (opportunity.sellBidQty < requiredBtc) {
    return `${opportunity.label}: insufficient bid liquidity`;
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

  const tradeSizeBtc = getRequiredBtc(opportunity.buyAskPrice, TRADE_LIMIT_USD);
  const reason = walletTracker.getAffordabilityReason({
    direction: opportunity.direction,
    tradeSizeBtc,
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

  const executedLabels = tryExecuteOpportunities(
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
  const haltedSuffix = wallet.isHalted() ? " | [HALTED: low balance]" : "";
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

console.log("Subscribing to Bitcoin order books on Binance and Indodax...");
console.log(
  `Taker fees: Binance ${(TAKER_FEES.binance * 100).toFixed(4)}%, Indodax buy ${(TAKER_FEES.indodax.buy * 100).toFixed(4)}% / sell ${(TAKER_FEES.indodax.sell * 100).toFixed(4)}%`,
);
console.log(`Trade size: $${TRADE_LIMIT_USD.toFixed(2)} per execution`);
console.log(
  `Initial wallet: Binance BTC ${INITIAL_BINANCE_BTC}, USDT ${INITIAL_BINANCE_USDT} | Indodax BTC ${INITIAL_INDODAX_BTC}, USDT ${INITIAL_INDODAX_USDT}`,
);
console.log(
  `Trading stops when any balance falls to ${(MIN_BALANCE_PCT * 100).toFixed(0)}% of initial`,
);
console.log(`[Wallet] ${wallet.formatBalances()}`);

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
let elapsedMinutes = 0;

setInterval(() => {
  elapsedMinutes += 5;
  console.log(`${elapsedMinutes} minutes elapsed`);
}, HEARTBEAT_INTERVAL_MS);
