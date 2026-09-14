import {
  BINANCE_QTY_DECIMALS,
  HYPERLIQUID_MIN_NOTIONAL_USDC,
  INDODAX_PRICE_DECIMALS,
  INDODAX_QTY_DECIMALS,
} from "../config/market";
import {
  isExchangeLive,
  LIVE_TRADING,
  MAX_UNPAIRED_PAIRS,
  TRADE_LIMIT_USD,
} from "../config/trading";
import { optionalEnv } from "../config/env";
import {
  placeBinanceMarketOrder,
  ensureBinanceFilters,
  binanceNotionalMeetsMinimum,
  getBinanceMinNotionalUsdt,
} from "../exchanges/binanceTrade";
import { fetchIndodaxTopOfBook } from "../exchanges/indodax";
import { placeIndodaxMarketOrder } from "../exchanges/indodaxTrade";
import {
  ensureHyperliquidMeta,
  fetchHyperliquidTopOfBook,
  formatHyperliquidPrice,
  getHyperliquidMinNotionalUsdc,
  getHyperliquidSzDecimals,
  hasHyperliquidCredentials,
  hyperliquidNotionalMeetsMinimum,
  placeHyperliquidIocOrder,
} from "../exchanges/hyperliquidTrade";
import {
  OrderError,
  isMarketOrderInFlight,
  roundDown,
  type ExchangeName,
  type PlacedOrder,
} from "../exchanges/orders";
import {
  createExecutedTrade,
  ExecutedTrade,
  TradeProgressTracker,
} from "./progress";
import { WalletTracker } from "./wallet";
import { recordUnpairedPair } from "./unpaired";
import {
  directionLabel,
  isLiveTradablePair,
  isPaperSimVenue,
  parseDirection,
  type ArbitrageDirection,
} from "./venues";

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

const FIRST_LEG_PRIORITY: ExchangeName[] = [
  "indodax",
  "hyperliquid",
  "binance",
];

function asLiveExchange(venue: string): ExchangeName {
  if (venue === "binance" || venue === "indodax" || venue === "hyperliquid") {
    return venue;
  }
  throw new OrderError("binance", `No live orders for ${venue}`);
}

function pickFirstLeg(left: ExchangeName, right: ExchangeName): ExchangeName {
  return FIRST_LEG_PRIORITY.indexOf(left) <= FIRST_LEG_PRIORITY.indexOf(right)
    ? left
    : right;
}

let executionInFlight = false;

export function assertLiveTradingCredentials(): void {
  if (!LIVE_TRADING) {
    return;
  }

  const required: string[] = [];
  if (isExchangeLive("binance")) {
    required.push("BINANCE_API_KEY", "BINANCE_API_SECRET");
  }
  if (isExchangeLive("indodax")) {
    required.push("INDODAX_API_KEY", "INDODAX_API_SECRET");
  }
  if (isExchangeLive("hyperliquid") && optionalEnv("HYPERLIQUID_PRIVATE_KEY")) {
    required.push("HYPERLIQUID_PRIVATE_KEY");
  }

  const missing = required.filter((name) => !optionalEnv(name));

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
  if (exchange === "hyperliquid") {
    return placeHyperliquidIocOrder(request);
  }

  return placeIndodaxMarketOrder(request);
}

function quantityForExchange(exchange: ExchangeName, eth: number): number {
  const decimals =
    exchange === "binance"
      ? BINANCE_QTY_DECIMALS
      : exchange === "hyperliquid"
        ? getHyperliquidSzDecimals()
        : INDODAX_QTY_DECIMALS;
  return roundDown(eth, decimals);
}

function sameLimitPrice(livePrice: number, plannedPrice: number): boolean {
  return livePrice.toFixed(INDODAX_PRICE_DECIMALS) === plannedPrice.toFixed(INDODAX_PRICE_DECIMALS);
}

function sameHyperliquidPrice(livePrice: number, plannedPrice: number): boolean {
  const szDecimals = getHyperliquidSzDecimals();
  return (
    formatHyperliquidPrice(livePrice, szDecimals) ===
    formatHyperliquidPrice(plannedPrice, szDecimals)
  );
}

async function assertIndodaxFirstRowStillCovers(
  side: "BUY" | "SELL",
  quantityEth: number,
  plannedPrice: number,
): Promise<void> {
  let live;
  try {
    live = await fetchIndodaxTopOfBook();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OrderError("indodax", `Skipping ${side}: last-look depth failed (${message})`);
  }
  const livePrice = side === "BUY" ? live.bestAskPrice : live.bestBidPrice;
  const liveQty = side === "BUY" ? live.bestAskQty : live.bestBidQty;
  const liveNotional = livePrice * liveQty;
  const bookSide = side === "BUY" ? "ask" : "bid";

  console.log(
    `[Indodax] Last look first ${bookSide}: ${liveQty} ETH @ ${livePrice} ($${liveNotional.toFixed(2)})`,
  );

  if (!sameLimitPrice(livePrice, plannedPrice)) {
    throw new OrderError(
      "indodax",
      `Skipping ${side}: first ${bookSide} moved ${plannedPrice} → ${livePrice}`,
    );
  }

  if (liveQty < quantityEth || liveNotional < TRADE_LIMIT_USD) {
    throw new OrderError(
      "indodax",
      `Skipping ${side}: first ${bookSide} now ${liveQty} ETH ($${liveNotional.toFixed(2)}) < ${quantityEth} ETH / $${TRADE_LIMIT_USD.toFixed(2)}`,
    );
  }
}

async function assertHyperliquidFirstRowStillCovers(
  side: "BUY" | "SELL",
  quantityEth: number,
  plannedPrice: number,
): Promise<void> {
  let live;
  try {
    live = await fetchHyperliquidTopOfBook();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OrderError("hyperliquid", `Skipping ${side}: last-look depth failed (${message})`);
  }
  const livePrice = side === "BUY" ? live.bestAskPrice : live.bestBidPrice;
  const liveQty = side === "BUY" ? live.bestAskQty : live.bestBidQty;
  const liveNotional = livePrice * liveQty;
  const bookSide = side === "BUY" ? "ask" : "bid";

  console.log(
    `[Hyperliquid] Last look first ${bookSide}: ${liveQty} ETH @ ${livePrice} ($${liveNotional.toFixed(2)})`,
  );

  if (!sameHyperliquidPrice(livePrice, plannedPrice)) {
    throw new OrderError(
      "hyperliquid",
      `Skipping ${side}: first ${bookSide} moved ${plannedPrice} → ${livePrice}`,
    );
  }

  if (
    liveQty < quantityEth ||
    liveNotional < TRADE_LIMIT_USD ||
    liveNotional < HYPERLIQUID_MIN_NOTIONAL_USDC
  ) {
    throw new OrderError(
      "hyperliquid",
      `Skipping ${side}: first ${bookSide} now ${liveQty} ETH ($${liveNotional.toFixed(2)}) < ${quantityEth} ETH / $${TRADE_LIMIT_USD.toFixed(2)}`,
    );
  }
}

async function assertFirstRowStillCovers(
  exchange: ExchangeName,
  side: "BUY" | "SELL",
  quantityEth: number,
  plannedPrice: number,
): Promise<void> {
  if (exchange === "indodax") {
    await assertIndodaxFirstRowStillCovers(side, quantityEth, plannedPrice);
    return;
  }
  if (exchange === "hyperliquid") {
    await assertHyperliquidFirstRowStillCovers(side, quantityEth, plannedPrice);
  }
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
  const shouldHalt = recordUnpairedPair(reason);
  if (shouldHalt) {
    wallet.halt(
      `unpaired pair limit reached (${MAX_UNPAIRED_PAIRS}): ${reason}`,
    );
  }
}

async function executeLivePair(
  opportunity: TradeOpportunity,
  wallet: WalletTracker,
): Promise<void> {
  const parsed = parseDirection(opportunity.direction);
  if (!isLiveTradablePair(parsed.buyVenue, parsed.sellVenue)) {
    throw new OrderError("binance", `No live orders for ${directionLabel(opportunity.direction)}`);
  }

  const buy = asLiveExchange(parsed.buyVenue);
  const sell = asLiveExchange(parsed.sellVenue);
  if (buy === "hyperliquid" || sell === "hyperliquid") {
    await ensureHyperliquidMeta();
  }

  const first = pickFirstLeg(buy, sell);
  const second = first === buy ? sell : buy;
  const firstSide: "BUY" | "SELL" = first === buy ? "BUY" : "SELL";
  const secondSide: "BUY" | "SELL" = firstSide === "BUY" ? "SELL" : "BUY";

  const stamp = Date.now().toString(36);
  const firstClientId = `arb1${stamp}`.slice(0, 36);
  const secondClientId = `arb2${stamp}`.slice(0, 36);

  const firstQty = quantityForExchange(first, opportunity.tradeSizeEth);
  const secondQtyPlanned = quantityForExchange(second, opportunity.tradeSizeEth);
  if (!(firstQty > 0) || !(secondQtyPlanned > 0)) {
    throw new OrderError(
      first,
      `Skipping pair: size ${opportunity.tradeSizeEth} ETH is below lot size`,
    );
  }

  if (firstSide === "BUY" && firstQty > opportunity.buyAskQty) {
    throw new OrderError(
      first,
      `Skipping buy: qty ${firstQty} ETH exceeds best-ask size ${opportunity.buyAskQty}`,
    );
  }
  if (firstSide === "SELL" && firstQty > opportunity.sellBidQty) {
    throw new OrderError(
      first,
      `Skipping sell: qty ${firstQty} ETH exceeds best-bid size ${opportunity.sellBidQty}`,
    );
  }

  const plannedFirstPrice =
    firstSide === "BUY" ? opportunity.buyAskPrice : opportunity.sellBidPrice;
  await assertFirstRowStillCovers(first, firstSide, firstQty, plannedFirstPrice);

  console.log(
    `[Trade] Leg 1/2: ${first} ${firstSide} ${firstQty.toFixed(8)} ETH (~$${opportunity.tradeNotionalUsd.toFixed(2)})`,
  );

  const firstFill = await placeMarketOrder(
    first,
    firstSide,
    firstQty,
    firstSide === "BUY" ? opportunity.tradeNotionalUsd : undefined,
    firstClientId,
    firstSide === "BUY" ? opportunity.buyAskPrice : opportunity.sellBidPrice,
    firstSide === "BUY" ? opportunity.buyAskPriceText : opportunity.sellBidPriceText,
  );

  console.log(
    `[Trade] Leg 1 filled: ${firstFill.exchange} order ${firstFill.orderId} qty ${firstFill.executedQtyEth.toFixed(8)} ETH`,
  );

  const filledFirstQty = quantityForExchange(first, firstFill.executedQtyEth);
  if (!(filledFirstQty > 0)) {
    const detail = `${first} fill ${firstFill.executedQtyEth} ETH is below lot size`;
    haltUnpairedFill(wallet, firstFill, second, secondSide, detail);
    throw new OrderError(first, detail);
  }

  const secondQty = quantityForExchange(second, filledFirstQty);
  if (!(secondQty > 0)) {
    const detail = `${first} fill ${firstFill.executedQtyEth} ETH is below ${second} lot size`;
    haltUnpairedFill(wallet, firstFill, second, secondSide, detail);
    throw new OrderError(second, detail);
  }

  const hedgePrice =
    secondSide === "SELL" ? opportunity.sellBidPrice : opportunity.buyAskPrice;
  const hedgeNotional = secondQty * hedgePrice;

  if (second === "binance") {
    await ensureBinanceFilters();
    if (!binanceNotionalMeetsMinimum(secondQty, hedgePrice)) {
      const detail = `Binance ${secondSide} notional $${hedgeNotional.toFixed(2)} < min $${getBinanceMinNotionalUsdt().toFixed(2)} (${secondQty} ETH @ ${hedgePrice})`;
      haltUnpairedFill(wallet, firstFill, second, secondSide, detail);
      throw new OrderError("binance", detail);
    }
  }
  if (second === "hyperliquid") {
    if (
      !hyperliquidNotionalMeetsMinimum(secondQty, hedgePrice) ||
      hedgeNotional < TRADE_LIMIT_USD
    ) {
      const detail = `Hyperliquid ${secondSide} notional $${hedgeNotional.toFixed(2)} < min $${getHyperliquidMinNotionalUsdc().toFixed(2)} (${secondQty} ETH @ ${hedgePrice})`;
      haltUnpairedFill(wallet, firstFill, second, secondSide, detail);
      throw new OrderError("hyperliquid", detail);
    }
    await assertFirstRowStillCovers(second, secondSide, secondQty, hedgePrice);
  }

  if (secondSide === "BUY" && secondQty > opportunity.buyAskQty) {
    const detail = `buy qty ${secondQty} ETH exceeds best-ask size ${opportunity.buyAskQty}`;
    haltUnpairedFill(wallet, firstFill, second, secondSide, detail);
    throw new OrderError(second, detail);
  }
  if (secondSide === "SELL" && secondQty > opportunity.sellBidQty) {
    const detail = `sell qty ${secondQty} ETH exceeds best-bid size ${opportunity.sellBidQty}`;
    haltUnpairedFill(wallet, firstFill, second, secondSide, detail);
    throw new OrderError(second, detail);
  }

  console.log(
    `[Trade] Leg 2/2: ${second} ${secondSide} ${secondQty.toFixed(8)} ETH`,
  );

  try {
    const secondFill = await placeMarketOrder(
      second,
      secondSide,
      secondQty,
      undefined,
      secondClientId,
      second === "hyperliquid" || second === "indodax" ? hedgePrice : undefined,
      second === "indodax"
        ? secondSide === "BUY"
          ? opportunity.buyAskPriceText
          : opportunity.sellBidPriceText
        : undefined,
    );
    console.log(
      `[Trade] Leg 2 filled: ${secondFill.exchange} order ${secondFill.orderId} qty ${secondFill.executedQtyEth.toFixed(8)} ETH`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    haltUnpairedFill(wallet, firstFill, second, secondSide, message);
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

  const { buyVenue, sellVenue } = parseDirection(opportunity.direction);
  const bothListedLive = isExchangeLive(buyVenue) && isExchangeLive(sellVenue);
  const needsHyperliquidKey =
    buyVenue === "hyperliquid" || sellVenue === "hyperliquid";
  const livePair =
    bothListedLive &&
    isLiveTradablePair(buyVenue, sellVenue) &&
    !isPaperSimVenue(buyVenue) &&
    !isPaperSimVenue(sellVenue) &&
    (!needsHyperliquidKey || hasHyperliquidCredentials());
  console.log(
    `[Trade] Executing ${directionLabel(opportunity.direction)} | $${opportunity.tradeNotionalUsd.toFixed(2)} (${opportunity.tradeSizeEth.toFixed(8)} ETH) | est. profit ${(opportunity.profitPerEth * opportunity.tradeSizeEth).toFixed(4)} USDT (${opportunity.profitPct.toFixed(4)}%)`,
  );

  if (LIVE_TRADING && livePair) {
    try {
      await executeLivePair(opportunity, wallet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Trade] Pair aborted: ${message}`);
      return { trade: null, attemptedLive: true };
    }
  } else if (livePair) {
    console.log("[Trade] Simulation only (LIVE_TRADING is off)");
  } else if (needsHyperliquidKey && bothListedLive && !hasHyperliquidCredentials()) {
    console.log(
      `[Trade] Simulation only (${directionLabel(opportunity.direction)} — set HYPERLIQUID_PRIVATE_KEY for live Hyperliquid orders)`,
    );
  } else {
    console.log(
      `[Trade] Simulation only (${directionLabel(opportunity.direction)} — venue is in SIMULATION_EXCHANGES)`,
    );
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

  return { trade, attemptedLive: LIVE_TRADING && livePair };
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
          `[Trade] Skipping ${directionLabel(opportunity.direction)}: waiting for an in-flight market order response`,
        );
        break;
      }

      const { trade, attemptedLive } = await executeArbitrageAttempt(
        opportunity,
        wallet,
      );

      if (trade) {
        progress.record(trade);
        executedLabels.push(directionLabel(opportunity.direction));
      }

      if (trade || attemptedLive) {
        break;
      }
    }
  } finally {
    executionInFlight = false;
  }

  return executedLabels;
}
