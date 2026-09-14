import { createHash } from "node:crypto";
import {
  HYPERLIQUID_EXCHANGE_URL,
  HYPERLIQUID_INFO_URL,
  HYPERLIQUID_MIN_NOTIONAL_USDC,
  HYPERLIQUID_SPOT_MAX_DECIMALS,
} from "../config/market";
import { TRADE_LIMIT_USD } from "../config/trading";
import { optionalEnv } from "../config/env";
import type { SpotBalances } from "./balances";
import {
  getHyperliquidAccountAddress,
  signL1Action,
  signingAddressFromKey,
  vaultAddressForRequest,
} from "./hyperliquidSign";
import {
  OrderError,
  roundDown,
  withMarketOrderLock,
  type MarketOrderRequest,
  type PlacedOrder,
} from "./orders";

const LOG_PREFIX = "[Hyperliquid]";
const SPOT_ASSET_OFFSET = 10_000;

export interface HyperliquidSpotMeta {
  coin: string;
  tokenName: string;
  pairLabel: string;
  assetId: number;
  szDecimals: number;
}

interface SpotToken {
  name?: string;
  index?: number;
  szDecimals?: number;
}

interface SpotUniversePair {
  name?: string;
  tokens?: number[];
  index?: number;
}

interface SpotMetaResponse {
  tokens?: SpotToken[];
  universe?: SpotUniversePair[];
}

interface L2Level {
  px?: string;
  sz?: string;
}

interface L2BookResponse {
  levels?: [L2Level[], L2Level[]];
}

interface SpotBalanceRow {
  coin?: string;
  hold?: string;
  total?: string;
}

interface SpotClearinghouseState {
  balances?: SpotBalanceRow[];
}

interface OrderStatusFilled {
  totalSz?: string;
  avgPx?: string;
  oid?: number;
}

interface OrderStatusEntry {
  filled?: OrderStatusFilled;
  resting?: { oid?: number };
  error?: string;
}

interface ExchangeOrderResponse {
  status?: string;
  response?: {
    type?: string;
    data?: {
      statuses?: OrderStatusEntry[];
    };
  };
}

export interface HyperliquidTopOfBook {
  bestBidPrice: number;
  bestBidQty: number;
  bestAskPrice: number;
  bestAskQty: number;
}

let cachedMeta: HyperliquidSpotMeta | null = null;
let lastNonce = 0;

function nextNonce(): number {
  const now = Date.now();
  lastNonce = Math.max(now, lastNonce + 1);
  return lastNonce;
}

function floatToWire(value: number): string {
  const rounded = value.toFixed(8);
  if (Math.abs(Number(rounded) - value) >= 1e-12) {
    throw new OrderError("hyperliquid", `float_to_wire rounding ${value}`);
  }
  let normalized = rounded.replace(/\.?0+$/, "");
  if (normalized === "-0") {
    normalized = "0";
  }
  return normalized;
}

/** Official spot tick: 5 significant figures, at most 8 - szDecimals decimals. */
export function formatHyperliquidPrice(price: number, szDecimals: number): string {
  if (!(price > 0)) {
    throw new OrderError("hyperliquid", "price must be positive");
  }
  const maxDecimals = Math.max(0, HYPERLIQUID_SPOT_MAX_DECIMALS - szDecimals);
  const significant = Number(price.toPrecision(5));
  const wired = Number(significant.toFixed(maxDecimals));
  return floatToWire(wired);
}

export function formatHyperliquidSize(quantityEth: number, szDecimals: number): string {
  return floatToWire(roundDown(quantityEth, szDecimals));
}

export function hyperliquidNotionalMeetsMinimum(
  quantityEth: number,
  price: number,
): boolean {
  if (!(quantityEth > 0) || !(price > 0)) {
    return false;
  }
  return quantityEth * price >= HYPERLIQUID_MIN_NOTIONAL_USDC;
}

export function getHyperliquidMinNotionalUsdc(): number {
  return HYPERLIQUID_MIN_NOTIONAL_USDC;
}

export function hasHyperliquidCredentials(): boolean {
  return Boolean(optionalEnv("HYPERLIQUID_PRIVATE_KEY"));
}

export async function resolveHyperliquidSpotMeta(): Promise<HyperliquidSpotMeta> {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" }),
  });
  const payload = (await response.json()) as SpotMetaResponse;
  if (!response.ok) {
    throw new OrderError(
      "hyperliquid",
      `HTTP ${response.status} fetching spotMeta`,
    );
  }

  const tokens = payload.tokens ?? [];
  const universe = payload.universe ?? [];
  const quoteIndex = tokens.find((token) => token.name === "USDC")?.index ?? 0;
  const base =
    tokens.find((token) => token.name === "UETH") ??
    tokens.find((token) => token.name === "ETH");
  if (base?.name === undefined || base.index === undefined) {
    throw new OrderError("hyperliquid", "spotMeta has no UETH or ETH token");
  }

  const pair = universe.find((entry) => {
    const pairTokens = entry.tokens;
    return (
      pairTokens !== undefined &&
      pairTokens[0] === base.index &&
      pairTokens[1] === quoteIndex
    );
  });
  if (pair?.index === undefined) {
    throw new OrderError("hyperliquid", `No ${base.name}/USDC spot pair in universe`);
  }

  const coin =
    pair.name?.includes("/") === true ? pair.name : `@${pair.index}`;
  const szDecimals =
    typeof base.szDecimals === "number" && base.szDecimals >= 0
      ? base.szDecimals
      : 4;

  return {
    coin,
    tokenName: base.name,
    pairLabel: `${base.name}/USDC (${coin})`,
    assetId: SPOT_ASSET_OFFSET + pair.index,
    szDecimals,
  };
}

export async function ensureHyperliquidMeta(): Promise<HyperliquidSpotMeta> {
  if (cachedMeta) {
    return cachedMeta;
  }
  cachedMeta = await resolveHyperliquidSpotMeta();
  console.log(
    `${LOG_PREFIX} ${cachedMeta.pairLabel} asset ${cachedMeta.assetId} szDecimals ${cachedMeta.szDecimals} minNotional $${HYPERLIQUID_MIN_NOTIONAL_USDC.toFixed(2)} USDC`,
  );
  return cachedMeta;
}

export function getHyperliquidSzDecimals(): number {
  return cachedMeta?.szDecimals ?? 4;
}

export async function fetchHyperliquidTopOfBook(): Promise<HyperliquidTopOfBook> {
  const meta = await ensureHyperliquidMeta();
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin: meta.coin }),
  });
  const payload = (await response.json()) as L2BookResponse;
  if (!response.ok) {
    throw new OrderError(
      "hyperliquid",
      `HTTP ${response.status} fetching l2Book`,
    );
  }

  const bid = payload.levels?.[0]?.[0];
  const ask = payload.levels?.[1]?.[0];
  const bestBidPrice = Number(bid?.px ?? 0);
  const bestBidQty = Number(bid?.sz ?? 0);
  const bestAskPrice = Number(ask?.px ?? 0);
  const bestAskQty = Number(ask?.sz ?? 0);
  if (
    !(bestBidPrice > 0) ||
    !(bestBidQty > 0) ||
    !(bestAskPrice > 0) ||
    !(bestAskQty > 0)
  ) {
    throw new OrderError("hyperliquid", "l2Book missing a first bid/ask row");
  }

  return { bestBidPrice, bestBidQty, bestAskPrice, bestAskQty };
}

function availableBalance(row: SpotBalanceRow | undefined): number {
  const total = Number(row?.total ?? 0);
  const hold = Number(row?.hold ?? 0);
  const free = total - hold;
  return Number.isFinite(free) && free > 0 ? free : 0;
}

export async function fetchHyperliquidSpotBalances(): Promise<SpotBalances> {
  if (!hasHyperliquidCredentials() && !optionalEnv("HYPERLIQUID_ACCOUNT_ADDRESS")) {
    throw new OrderError(
      "hyperliquid",
      "set HYPERLIQUID_PRIVATE_KEY or HYPERLIQUID_ACCOUNT_ADDRESS to fetch balances",
    );
  }

  const user = optionalEnv("HYPERLIQUID_ACCOUNT_ADDRESS")
    ? getHyperliquidAccountAddress()
    : hasHyperliquidCredentials()
      ? signingAddressFromKey()
      : getHyperliquidAccountAddress();

  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotClearinghouseState", user }),
  });
  const payload = (await response.json()) as SpotClearinghouseState;
  if (!response.ok || !payload.balances) {
    throw new OrderError(
      "hyperliquid",
      `HTTP ${response.status} fetching spotClearinghouseState`,
    );
  }

  const find = (...names: string[]): SpotBalanceRow | undefined =>
    payload.balances?.find((row) =>
      names.some((name) => (row.coin ?? "").toUpperCase() === name),
    );

  return {
    eth: availableBalance(find("UETH", "ETH")),
    usdt: availableBalance(find("USDC")),
  };
}

function cloidFromClientId(clientOrderId: string): string {
  const hex = createHash("sha256").update(clientOrderId).digest("hex").slice(0, 32);
  return `0x${hex}`;
}

export async function placeHyperliquidIocOrder(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  return withMarketOrderLock("hyperliquid", () =>
    placeHyperliquidIocOrderUnlocked(request),
  );
}

async function placeHyperliquidIocOrderUnlocked(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  const meta = await ensureHyperliquidMeta();
  const limitPrice = request.limitPrice ?? 0;
  if (!(limitPrice > 0)) {
    throw new OrderError("hyperliquid", "IOC order requires a first-row price");
  }

  const size = formatHyperliquidSize(request.quantityEth, meta.szDecimals);
  const price = formatHyperliquidPrice(limitPrice, meta.szDecimals);
  const sizeNum = Number(size);
  const priceNum = Number(price);
  if (!(sizeNum > 0)) {
    throw new OrderError(
      "hyperliquid",
      `size ${request.quantityEth} ETH is below szDecimals ${meta.szDecimals}`,
    );
  }
  if (!hyperliquidNotionalMeetsMinimum(sizeNum, priceNum)) {
    throw new OrderError(
      "hyperliquid",
      `notional $${(sizeNum * priceNum).toFixed(2)} < min $${HYPERLIQUID_MIN_NOTIONAL_USDC.toFixed(2)} USDC`,
    );
  }
  if (sizeNum * priceNum < TRADE_LIMIT_USD) {
    throw new OrderError(
      "hyperliquid",
      `notional $${(sizeNum * priceNum).toFixed(2)} < configured $${TRADE_LIMIT_USD.toFixed(2)}`,
    );
  }

  const order = {
    a: meta.assetId,
    b: request.side === "BUY",
    p: price,
    s: size,
    r: false,
    t: { limit: { tif: "Ioc" } },
    c: cloidFromClientId(request.clientOrderId),
  };
  const action = {
    type: "order",
    orders: [order],
    grouping: "na",
  };
  const nonce = nextNonce();
  const vaultAddress = vaultAddressForRequest();
  const signature = signL1Action(action, vaultAddress, nonce);

  const body: Record<string, unknown> = {
    action,
    nonce,
    signature,
  };
  if (vaultAddress) {
    body.vaultAddress = vaultAddress;
  }

  console.log(
    `${LOG_PREFIX} IOC ${request.side} ${size} ${meta.tokenName} @ ${price} USDC (${meta.pairLabel})`,
  );

  const response = await fetch(HYPERLIQUID_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ExchangeOrderResponse;
  if (!response.ok || payload.status !== "ok") {
    throw new OrderError(
      "hyperliquid",
      `HTTP ${response.status} placing ${request.side}: ${JSON.stringify(payload)}`,
    );
  }

  const status = payload.response?.data?.statuses?.[0];
  if (status?.error) {
    throw new OrderError("hyperliquid", status.error);
  }
  if (!status?.filled) {
    throw new OrderError(
      "hyperliquid",
      `IOC did not fill (${JSON.stringify(status ?? payload)})`,
    );
  }

  const executedQtyEth = Number(status.filled.totalSz ?? 0);
  const avgPx = Number(status.filled.avgPx ?? 0);
  if (!(executedQtyEth > 0)) {
    throw new OrderError(
      "hyperliquid",
      `Order ${status.filled.oid} did not fill`,
    );
  }

  return {
    exchange: "hyperliquid",
    side: request.side,
    orderId: String(status.filled.oid ?? ""),
    clientOrderId: request.clientOrderId,
    status: "FILLED",
    executedQtyEth,
    executedQuoteUsdt: executedQtyEth * (avgPx > 0 ? avgPx : priceNum),
  };
}
