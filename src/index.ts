import "./config/env";
import { TAKER_FEES } from "./config/fees";
import {
  INITIAL_BINANCE_ETH,
  INITIAL_BINANCE_USDT,
  INITIAL_HYPERLIQUID_ETH,
  INITIAL_HYPERLIQUID_USDT,
  INITIAL_INDODAX_ETH,
  INITIAL_INDODAX_USDT,
  INITIAL_TOKOCRYPTO_ETH,
  INITIAL_TOKOCRYPTO_USDT,
  isExchangeActive,
  isExchangeLive,
  liveExchangeNames,
  LIVE_TRADING,
  simulationExchangeNames,
  MAX_UNPAIRED_PAIRS,
  MAX_USDT_REBALANCES,
  MIN_BALANCE_PCT,
  REBALANCE_MAX_USDT,
  REBALANCE_USDT_PCT,
  TRADE_LIMIT_USD,
} from "./config/trading";
import { subscribeBinanceOrderBook } from "./exchanges/binance";
import {
  fetchBothSpotBalances,
  formatSpotBalances,
  includedLiveSpotVenues,
  logExchangeBalances,
  missingSpotApiKeys,
} from "./exchanges/balances";
import { ensureBinanceFilters } from "./exchanges/binanceTrade";
import {
  ensureHyperliquidMeta,
  fetchHyperliquidSpotBalances,
  hasHyperliquidCredentials,
} from "./exchanges/hyperliquidTrade";
import { optionalEnv } from "./config/env";
// Parked until a weekday US session: import { startIbkrClient } from "./exchanges/ibkr";
import { subscribeIndodaxOrderBook } from "./exchanges/indodax";
import { subscribeHyperliquidOrderBook } from "./exchanges/hyperliquid";
import { subscribeTokocryptoOrderBook } from "./exchanges/tokocrypto";
import { getUsdtPerUsdc, startUsdcUsdtPoller } from "./exchanges/usdcUsdt";
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
import { TradeProgressTracker } from "./trading/progress";
import {
  isLiveTradablePair,
  makeDirection,
  parseDirection,
  type ArbitrageDirection,
  type VenueId,
} from "./trading/venues";
import { tryDummyHyperliquidRebalance, tryRebalanceUsdt } from "./trading/rebalance";
import { createWalletTracker, WalletBalances, WalletTracker } from "./trading/wallet";

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

interface VenueConfig {
  id: VenueId;
  shortName: string;
  executable: boolean;
  buyFee: number;
  sellFee: number;
}

const VENUES: VenueConfig[] = [
  {
    id: "binance",
    shortName: "Bina",
    executable: true,
    buyFee: TAKER_FEES.binance,
    sellFee: TAKER_FEES.binance,
  },
  {
    id: "indodax",
    shortName: "Indo",
    executable: true,
    buyFee: TAKER_FEES.indodax.buy,
    sellFee: TAKER_FEES.indodax.sell,
  },
  {
    id: "hyperliquid",
    shortName: "Hype",
    executable: true,
    buyFee: TAKER_FEES.hyperliquid,
    sellFee: TAKER_FEES.hyperliquid,
  },
  {
    id: "tokocrypto",
    shortName: "Toko",
    executable: true,
    buyFee: TAKER_FEES.tokocrypto,
    sellFee: TAKER_FEES.tokocrypto,
  },
];

const quotes: Partial<Record<VenueId, OrderBookQuote>> = {};
const lastLineByOrigin: Partial<Record<VenueId, string>> = {};
const tradeProgress = new TradeProgressTracker();
let wallet: WalletTracker;
let spreadLogInFlight = false;

function activeVenues(): VenueConfig[] {
  return VENUES.filter((venue) => isExchangeActive(venue.id));
}

function venueById(id: VenueId): VenueConfig {
  const venue = VENUES.find((entry) => entry.id === id);
  if (!venue) {
    throw new Error(`Unknown venue ${id}`);
  }
  return venue;
}

function isLiveDirection(direction: ArbitrageDirection): boolean {
  const { buyVenue, sellVenue } = parseDirection(direction);
  return (
    isExchangeLive(buyVenue) &&
    isExchangeLive(sellVenue) &&
    isLiveTradablePair(buyVenue, sellVenue)
  );
}

const ANSI_EMPHASIS = "\x1b[1;93m";
const ANSI_RESET = "\x1b[0m";

function formatPctSigned(pct: number): string {
  return `${pct > 0 ? "+" : ""}${pct.toFixed(4)}%`;
}

function boldText(text: string): string {
  return `${ANSI_EMPHASIS}${text}${ANSI_RESET}`;
}

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

/** Hyperliquid native prices are USDC; convert with Binance USDCUSDT mid. */
function quoteAsUsdt(venueId: VenueId, nativePrice: number): number | null {
  if (venueId !== "hyperliquid") {
    return nativePrice;
  }
  const usdtPerUsdc = getUsdtPerUsdc();
  if (usdtPerUsdc === null || !(nativePrice > 0)) {
    return null;
  }
  return nativePrice * usdtPerUsdc;
}

function buildSideOpportunity(
  buyVenue: VenueConfig,
  sellVenue: VenueConfig,
): ArbitrageOpportunity | null {
  const buyQuote = quotes[buyVenue.id];
  const sellQuote = quotes[sellVenue.id];
  if (!buyQuote || !sellQuote) {
    return null;
  }
  const direction = makeDirection(buyVenue.id, sellVenue.id);
  const buyAskUsdt = quoteAsUsdt(buyVenue.id, Number(buyQuote.bestAsk));
  const sellBidUsdt = quoteAsUsdt(sellVenue.id, Number(sellQuote.bestBid));
  if (buyAskUsdt === null || sellBidUsdt === null) {
    return null;
  }

  return {
    label: `Buy ${buyVenue.shortName} / Sell ${sellVenue.shortName}`,
    direction,
    buyAskPrice: Number(buyQuote.bestAsk),
    buyAskQty: Number(buyQuote.bestAskQty),
    sellBidPrice: Number(sellQuote.bestBid),
    sellBidQty: Number(sellQuote.bestBidQty),
    buyAskPriceText: buyQuote.bestAsk,
    sellBidPriceText: sellQuote.bestBid,
    buyTakerFee: buyVenue.buyFee,
    sellTakerFee: sellVenue.sellFee,
    spread: formatSpread(
      String(sellBidUsdt),
      String(buyAskUsdt),
      sellVenue.sellFee,
      buyVenue.buyFee,
    ),
  };
}

function compareBuyOrigin(origin: VenueConfig, other: VenueConfig): SpreadResult | null {
  const originQuote = quotes[origin.id];
  const otherQuote = quotes[other.id];
  if (!originQuote || !otherQuote) {
    return null;
  }

  const sellBidUsdt = quoteAsUsdt(other.id, Number(otherQuote.bestBid));
  const buyAskUsdt = quoteAsUsdt(origin.id, Number(originQuote.bestAsk));
  if (sellBidUsdt === null || buyAskUsdt === null) {
    return null;
  }

  return formatSpread(
    String(sellBidUsdt),
    String(buyAskUsdt),
    other.sellFee,
    origin.buyFee,
  );
}

function compareSellOrigin(origin: VenueConfig, other: VenueConfig): SpreadResult | null {
  const originQuote = quotes[origin.id];
  const otherQuote = quotes[other.id];
  if (!originQuote || !otherQuote) {
    return null;
  }

  const sellBidUsdt = quoteAsUsdt(origin.id, Number(originQuote.bestBid));
  const buyAskUsdt = quoteAsUsdt(other.id, Number(otherQuote.bestAsk));
  if (sellBidUsdt === null || buyAskUsdt === null) {
    return null;
  }

  return formatSpread(
    String(sellBidUsdt),
    String(buyAskUsdt),
    origin.sellFee,
    other.buyFee,
  );
}

function formatSideParts(
  side: "Buy" | "Sell",
  origin: VenueConfig,
  others: VenueConfig[],
): string[] | null {
  const entries: { other: VenueConfig; spread: SpreadResult }[] = [];
  for (const other of others) {
    const spread =
      side === "Buy"
        ? compareBuyOrigin(origin, other)
        : compareSellOrigin(origin, other);
    if (!spread) {
      continue;
    }
    entries.push({ other, spread });
  }

  if (entries.length === 0) {
    return null;
  }

  const bestPct = Math.max(...entries.map((entry) => entry.spread.pct));
  return entries.map((entry, index) => {
    const nameAndPct = `${entry.other.shortName} ${formatPctSigned(entry.spread.pct)}`;
    const highlighted =
      entry.spread.pct === bestPct ? boldText(nameAndPct) : nameAndPct;
    return index === 0 ? `${side.toUpperCase()} v ${highlighted}` : highlighted;
  });
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

function logSpread(originId: VenueId): void {
  if (!wallet || wallet.isHalted()) {
    return;
  }

  void logSpreadAsync(originId);
}

async function logSpreadAsync(originId: VenueId): Promise<void> {
  if (spreadLogInFlight) {
    return;
  }

  spreadLogInFlight = true;

  try {
    await logSpreadLocked(originId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Spread] Failed to evaluate/execute:", message);
  } finally {
    spreadLogInFlight = false;
  }
}

async function logSpreadLocked(originId: VenueId): Promise<void> {
  const origin = venueById(originId);
  const others = activeVenues().filter(
    (venue) => venue.id !== originId && quotes[venue.id],
  );
  if (others.length === 0) {
    return;
  }

  const buyParts = formatSideParts("Buy", origin, others);
  const sellParts = formatSideParts("Sell", origin, others);
  if (!buyParts || !sellParts) {
    return;
  }

  const line = `[${origin.shortName}] ${buyParts.join(" ")} | ${sellParts.join(" ")}`;
  if (line === lastLineByOrigin[originId]) {
    return;
  }
  lastLineByOrigin[originId] = line;

  const candidates: ArbitrageOpportunity[] = [];
  if (origin.executable && isExchangeLive(origin.id)) {
    for (const other of others.filter(
      (venue) => venue.executable && isExchangeLive(venue.id),
    )) {
      const buyOrigin = buildSideOpportunity(origin, other);
      const sellOrigin = buildSideOpportunity(other, origin);
      if (buyOrigin) {
        candidates.push(buyOrigin);
      }
      if (sellOrigin) {
        candidates.push(sellOrigin);
      }
    }
  }

  const tradeOpportunities = candidates
    .map((opportunity) => buildTradeOpportunity(opportunity, wallet))
    .filter((opportunity): opportunity is TradeOpportunity => opportunity !== null)
    .sort((left, right) => {
      const leftLive = isLiveDirection(left.direction);
      const rightLive = isLiveDirection(right.direction);
      if (leftLive !== rightLive) {
        return leftLive ? -1 : 1;
      }
      return right.profitPct - left.profitPct;
    });

  const skippedLabels = [
    ...candidates
      .map(getLiquiditySkipReason)
      .filter((reason): reason is string => reason !== null),
    ...candidates
      .map((opportunity) => getWalletSkipReason(opportunity, wallet))
      .filter((reason): reason is string => reason !== null),
  ];

  const executedLabels =
    candidates.length > 0
      ? await tryExecuteOpportunities(tradeOpportunities, tradeProgress, wallet)
      : [];

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
    `${line}${executionSuffix}${skippedSuffix}${haltedSuffix}${progressSuffix}`,
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

function logQuotes(venueId: VenueId, quote: OrderBookQuote): void {
  const prev = quotes[venueId];
  if (prev && !quoteChanged(prev, quote)) {
    return;
  }

  quotes[venueId] = quote;
  logSpread(venueId);
}

function tokocryptoPaperBalances(): Pick<
  WalletBalances,
  "tokocryptoEth" | "tokocryptoUsdt"
> {
  return {
    tokocryptoEth: isExchangeActive("tokocrypto") ? INITIAL_TOKOCRYPTO_ETH : 0,
    tokocryptoUsdt: isExchangeActive("tokocrypto") ? INITIAL_TOKOCRYPTO_USDT : 0,
  };
}

function hyperliquidFallbackBalances(): Pick<
  WalletBalances,
  "hyperliquidEth" | "hyperliquidUsdt"
> {
  return {
    hyperliquidEth: isExchangeActive("hyperliquid") ? INITIAL_HYPERLIQUID_ETH : 0,
    hyperliquidUsdt: isExchangeActive("hyperliquid") ? INITIAL_HYPERLIQUID_USDT : 0,
  };
}

function paperSimVenueBalances(): Pick<
  WalletBalances,
  | "hyperliquidEth"
  | "hyperliquidUsdt"
  | "tokocryptoEth"
  | "tokocryptoUsdt"
> {
  return {
    ...hyperliquidFallbackBalances(),
    ...tokocryptoPaperBalances(),
  };
}

async function loadHyperliquidStartupBalances(): Promise<
  Pick<WalletBalances, "hyperliquidEth" | "hyperliquidUsdt">
> {
  if (!isExchangeActive("hyperliquid")) {
    return { hyperliquidEth: 0, hyperliquidUsdt: 0 };
  }
  if (!hasHyperliquidCredentials() && !optionalEnv("HYPERLIQUID_ACCOUNT_ADDRESS")) {
    console.log("[Wallet] Hyperliquid using INITIAL_* fallback (no private key / account address)");
    return hyperliquidFallbackBalances();
  }
  try {
    const live = await fetchHyperliquidSpotBalances();
    return {
      hyperliquidEth: live.eth,
      hyperliquidUsdt: live.usdt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[Wallet] Hyperliquid live balances unavailable (${message}); using INITIAL_*`);
    return hyperliquidFallbackBalances();
  }
}

function envFallbackWalletBalances(): WalletBalances {
  return {
    binanceEth: isExchangeActive("binance") ? INITIAL_BINANCE_ETH : 0,
    binanceUsdt: isExchangeActive("binance") ? INITIAL_BINANCE_USDT : 0,
    indodaxEth: isExchangeActive("indodax") ? INITIAL_INDODAX_ETH : 0,
    indodaxUsdt: isExchangeActive("indodax") ? INITIAL_INDODAX_USDT : 0,
    ...paperSimVenueBalances(),
  };
}

async function loadStartupWalletBalances(): Promise<{
  balances: WalletBalances;
  source: "live" | "env";
}> {
  if (includedLiveSpotVenues().length === 0) {
    const hyperliquid = await loadHyperliquidStartupBalances();
    return {
      balances: {
        ...envFallbackWalletBalances(),
        ...hyperliquid,
      },
      source: "env",
    };
  }

  const missing = missingSpotApiKeys();
  if (missing.length > 0) {
    console.log(
      `[Wallet] No API keys (${missing.join(", ")}); using INITIAL_* env fallback`,
    );
    const hyperliquid = await loadHyperliquidStartupBalances();
    return {
      balances: {
        ...envFallbackWalletBalances(),
        ...hyperliquid,
      },
      source: "env",
    };
  }

  const [{ binance, indodax }, hyperliquid] = await Promise.all([
    fetchBothSpotBalances(),
    loadHyperliquidStartupBalances(),
  ]);
  return {
    source: "live",
    balances: {
      binanceEth: isExchangeLive("binance") ? binance.eth : 0,
      binanceUsdt: isExchangeLive("binance") ? binance.usdt : 0,
      indodaxEth: isExchangeLive("indodax") ? indodax.eth : 0,
      indodaxUsdt: isExchangeLive("indodax") ? indodax.usdt : 0,
      ...hyperliquid,
      ...tokocryptoPaperBalances(),
    },
  };
}

async function start(): Promise<void> {
  const liveNames = liveExchangeNames();
  const simNames = simulationExchangeNames();
  console.log(
    liveNames.length > 0
      ? `Live exchanges: ${liveNames.join(", ")}`
      : "Live exchanges: (none)",
  );
  console.log(
    simNames.length > 0
      ? `Simulation exchanges: ${simNames.join(", ")}`
      : "Simulation exchanges: (none)",
  );

  const liveSpotNames = includedLiveSpotVenues().map((venue) =>
    venue === "binance" ? "Binance" : "Indodax",
  );
  if (liveSpotNames.length > 0) {
    console.log(
      `Fetching Spot ETH/USDT balances from ${liveSpotNames.join(" and ")}...`,
    );
  }
  assertLiveTradingCredentials();
  if (LIVE_TRADING && isExchangeLive("binance")) {
    await ensureBinanceFilters();
  }
  if (isExchangeActive("hyperliquid")) {
    startUsdcUsdtPoller();
    await ensureHyperliquidMeta().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[Hyperliquid] spotMeta unavailable (${message})`);
    });
  }

  const startup = await loadStartupWalletBalances();
  wallet = createWalletTracker(startup.balances);

  console.log(
    LIVE_TRADING
      ? "Live trading: ON — real orders only for LIVE_EXCHANGES"
      : "Live trading: OFF — no real orders (set LIVE_TRADING=true)",
  );
  if (isExchangeLive("hyperliquid")) {
    console.log(
      "Hyperliquid live: UETH/USDC IOC at first row; spreads converted via Binance USDCUSDT mid; 10% halt; 25% rebalance is dummy only",
    );
  } else if (isExchangeActive("hyperliquid")) {
    console.log(
      "Hyperliquid simulation: scan and log only (USDCUSDT conversion on); no live orders",
    );
  }
  if (isExchangeActive("tokocrypto")) {
    console.log("Tokocrypto simulation: scan and log only; no live orders");
  }

  const feeParts: string[] = [];
  if (isExchangeActive("binance")) {
    feeParts.push(`Binance ${(TAKER_FEES.binance * 100).toFixed(4)}%`);
  }
  if (isExchangeActive("indodax")) {
    feeParts.push(
      `Indodax buy ${(TAKER_FEES.indodax.buy * 100).toFixed(4)}% / sell ${(TAKER_FEES.indodax.sell * 100).toFixed(4)}%`,
    );
  }
  if (isExchangeActive("hyperliquid")) {
    feeParts.push(`Hyperliquid spot ${(TAKER_FEES.hyperliquid * 100).toFixed(4)}%`);
  }
  if (isExchangeActive("tokocrypto")) {
    feeParts.push(`Tokocrypto ${(TAKER_FEES.tokocrypto * 100).toFixed(4)}%`);
  }
  if (feeParts.length > 0) {
    console.log(`Taker fees: ${feeParts.join(", ")}`);
  }
  console.log(`Trade size: $${TRADE_LIMIT_USD.toFixed(2)} per execution`);
  console.log(
    `Unpaired pairs: keep running until ${MAX_UNPAIRED_PAIRS} (logged to unpaired-pair-trade.txt)`,
  );
  console.log(
    `[Wallet] initial from ${startup.source}: ${wallet.formatBalances()}`,
  );
  console.log(
    `Trading stops when any balance falls to ${(MIN_BALANCE_PCT * 100).toFixed(0)}% of initial`,
  );
  if (isExchangeLive("binance") && isExchangeLive("indodax")) {
    console.log(
      `USDT rebalance: when either side is at or below ${(REBALANCE_USDT_PCT * 100).toFixed(0)}% of its startup USDT (BEP-20 / BNB Chain); ${REBALANCE_MAX_USDT > 0 ? `cap $${REBALANCE_MAX_USDT.toFixed(2)} per move` : "no amount cap"}; halt after ${MAX_USDT_REBALANCES > 0 ? MAX_USDT_REBALANCES : "unlimited"} successful move${MAX_USDT_REBALANCES === 1 ? "" : "s"}`,
    );
  }

  // Parked until a weekday US session (TWS + NASDAQ UTP quotes).
  // startIbkrClient();

  const bookVenues = activeVenues().map((venue) => venue.shortName);
  if (bookVenues.length > 0) {
    console.log(
      `Subscribing to Ethereum order books: ${bookVenues.join(", ")}...`,
    );
  }

  if (isExchangeActive("binance")) {
    subscribeBinanceOrderBook((quote) => {
      logQuotes("binance", quote);
    });
  }
  if (isExchangeActive("indodax")) {
    subscribeIndodaxOrderBook((quote) => {
      logQuotes("indodax", quote);
    });
  }
  if (isExchangeActive("hyperliquid")) {
    void subscribeHyperliquidOrderBook((quote) => {
      logQuotes("hyperliquid", quote);
    });
  }
  if (isExchangeActive("tokocrypto")) {
    void subscribeTokocryptoOrderBook((quote) => {
      logQuotes("tokocrypto", quote);
    });
  }

  const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
  let elapsedMinutes = 0;
  setInterval(() => {
    elapsedMinutes += 5;
    console.log(formatElapsedLine(elapsedMinutes));
    void runHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

function formatElapsedLine(elapsedMinutes: number): string {
  const lastTradeAt = tradeProgress.getLastTradeAt();
  if (!lastTradeAt) {
    return `${elapsedMinutes} minutes elapsed`;
  }

  const minutesSinceLastTrade = Math.floor(
    (Date.now() - lastTradeAt.getTime()) / 60_000,
  );
  if (minutesSinceLastTrade <= 0) {
    return `${elapsedMinutes} minutes elapsed`;
  }

  return `${elapsedMinutes} minutes elapsed, ${minutesSinceLastTrade} minutes since last trade`;
}

async function runHeartbeat(): Promise<void> {
  if (includedLiveSpotVenues().length > 0) {
    if (missingSpotApiKeys().length > 0) {
      await logExchangeBalances();
    } else {
      try {
        const live = await fetchBothSpotBalances();
        const parts: string[] = [];
        if (isExchangeLive("binance")) {
          parts.push(`Binance ${formatSpotBalances(live.binance)}`);
        }
        if (isExchangeLive("indodax")) {
          parts.push(`Indodax ${formatSpotBalances(live.indodax)}`);
        }
        console.log(`[Balance] ${parts.join(" | ")}`);
        await tryRebalanceUsdt(wallet, live);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[Balance] error: ${message}`);
      }
    }
  }

  if (!isExchangeLive("hyperliquid")) {
    return;
  }
  if (!hasHyperliquidCredentials() && !optionalEnv("HYPERLIQUID_ACCOUNT_ADDRESS")) {
    return;
  }
  try {
    const hyperliquid = await fetchHyperliquidSpotBalances();
    console.log(
      `[Balance] Hyperliquid ETH ${hyperliquid.eth.toFixed(8)} USDC ${hyperliquid.usdt.toFixed(2)}`,
    );
    tryDummyHyperliquidRebalance(wallet, hyperliquid);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[Balance] Hyperliquid error: ${message}`);
  }
}

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Start] Failed to seed wallet from live balances: ${message}`);
  process.exit(1);
});
