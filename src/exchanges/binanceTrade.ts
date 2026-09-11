import { createHmac } from "node:crypto";
import {
  BINANCE_MIN_NOTIONAL_USD,
  BINANCE_QTY_DECIMALS,
  BINANCE_SYMBOL,
} from "../config/market";
import { requiredEnv } from "../config/env";
import {
  formatDecimal,
  OrderError,
  withMarketOrderLock,
  type MarketOrderRequest,
  type PlacedOrder,
} from "./orders";
import type { SpotBalances } from "./balances";

const BINANCE_API_URL = "https://api.binance.com";
const USDT_DECIMALS = 2;
const TIME_SYNC_INTERVAL_MS = 30 * 60 * 1000;

let timeOffsetMs = 0;
let lastSyncedAt = 0;
let syncInFlight: Promise<void> | null = null;
let minNotionalUsdt = BINANCE_MIN_NOTIONAL_USD;
let filtersLoaded = false;
let filtersInFlight: Promise<void> | null = null;

interface BinanceBalance {
  asset: string;
  free: string;
  locked: string;
}

interface BinanceAccountResponse {
  balances?: BinanceBalance[];
  code?: number;
  msg?: string;
}

interface BinanceOrderResponse {
  orderId?: number;
  clientOrderId?: string;
  status?: string;
  executedQty?: string;
  origQty?: string;
  cummulativeQuoteQty?: string;
  fills?: Array<{ price?: string; qty?: string }>;
  code?: number;
  msg?: string;
}

function getCredentials(): { apiKey: string; apiSecret: string } {
  return {
    apiKey: requiredEnv("BINANCE_API_KEY"),
    apiSecret: requiredEnv("BINANCE_API_SECRET"),
  };
}

function sign(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

function isTimestampError(message: string): boolean {
  return /timestamp|ahead of the server|recvWindow/i.test(message);
}

async function syncBinanceTime(): Promise<void> {
  const sentAt = Date.now();
  const response = await fetch(`${BINANCE_API_URL}/api/v3/time`);
  const receivedAt = Date.now();
  const payload = (await response.json()) as { serverTime?: number };

  if (!response.ok || typeof payload.serverTime !== "number") {
    throw new OrderError(
      "binance",
      `HTTP ${response.status} fetching server time`,
    );
  }

  const localMid = Math.floor((sentAt + receivedAt) / 2);
  timeOffsetMs = payload.serverTime - localMid;
  lastSyncedAt = receivedAt;
  console.log(`[Binance] Time offset ${timeOffsetMs}ms`);
}

async function ensureBinanceTimeSynced(force = false): Promise<void> {
  if (!force && lastSyncedAt > 0 && Date.now() - lastSyncedAt < TIME_SYNC_INTERVAL_MS) {
    return;
  }

  if (syncInFlight) {
    await syncInFlight;
    if (!force || (lastSyncedAt > 0 && Date.now() - lastSyncedAt < 1_000)) {
      return;
    }
  }

  syncInFlight = syncBinanceTime().finally(() => {
    syncInFlight = null;
  });
  await syncInFlight;
}

function binanceTimestamp(): string {
  return Math.floor(Date.now() + timeOffsetMs).toString();
}

interface BinanceSymbolFilter {
  filterType?: string;
  minNotional?: string;
  applyMinToMarket?: boolean | string;
  stepSize?: string;
}

interface BinanceExchangeInfo {
  symbols?: Array<{
    filters?: BinanceSymbolFilter[];
  }>;
}

async function loadBinanceSymbolFilters(): Promise<void> {
  const response = await fetch(
    `${BINANCE_API_URL}/api/v3/exchangeInfo?symbol=${BINANCE_SYMBOL}`,
  );
  const payload = (await response.json()) as BinanceExchangeInfo;
  if (!response.ok) {
    throw new OrderError(
      "binance",
      `HTTP ${response.status} fetching ${BINANCE_SYMBOL} exchangeInfo`,
    );
  }

  const filters = payload.symbols?.[0]?.filters ?? [];
  const notional = filters.find(
    (filter) =>
      filter.filterType === "NOTIONAL" || filter.filterType === "MIN_NOTIONAL",
  );
  const parsed = Number(notional?.minNotional);
  if (Number.isFinite(parsed) && parsed > 0) {
    minNotionalUsdt = parsed;
  }

  const applyMin =
    notional?.applyMinToMarket === true ||
    notional?.applyMinToMarket === "true";
  filtersLoaded = true;
  console.log(
    `[Binance] ${BINANCE_SYMBOL} minNotional $${minNotionalUsdt.toFixed(2)} (MARKET ${applyMin ? "enforced" : "not enforced"})`,
  );
}

export async function ensureBinanceFilters(): Promise<void> {
  if (filtersLoaded) {
    return;
  }
  if (filtersInFlight) {
    await filtersInFlight;
    return;
  }

  filtersInFlight = loadBinanceSymbolFilters()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `[Binance] exchangeInfo unavailable (${message}); using minNotional $${minNotionalUsdt.toFixed(2)}`,
      );
      filtersLoaded = true;
    })
    .finally(() => {
      filtersInFlight = null;
    });
  await filtersInFlight;
}

export function getBinanceMinNotionalUsdt(): number {
  return minNotionalUsdt;
}

export function binanceNotionalMeetsMinimum(
  quantityEth: number,
  price: number,
): boolean {
  if (!(quantityEth > 0) || !(price > 0)) {
    return false;
  }
  return quantityEth * price >= minNotionalUsdt;
}

export async function fetchBinanceSpotBalances(): Promise<SpotBalances> {
  await ensureBinanceTimeSynced();

  const load = async (): Promise<SpotBalances> => {
    const { apiKey, apiSecret } = getCredentials();
    const params = new URLSearchParams({
      omitZeroBalances: "true",
      recvWindow: "5000",
      timestamp: binanceTimestamp(),
    });
    const query = params.toString();
    const signature = sign(query, apiSecret);
    const response = await fetch(
      `${BINANCE_API_URL}/api/v3/account?${query}&signature=${signature}`,
      {
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
      },
    );

    const payload = (await response.json()) as BinanceAccountResponse;
    if (!response.ok || payload.code !== undefined || !payload.balances) {
      throw new OrderError(
        "binance",
        payload.msg ?? `HTTP ${response.status} fetching account balances`,
      );
    }

    return {
      eth: findAssetFree(payload.balances, "ETH"),
      usdt: findAssetFree(payload.balances, "USDT"),
    };
  };

  try {
    return await load();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isTimestampError(message)) {
      throw error;
    }

    await ensureBinanceTimeSynced(true);
    return load();
  }
}

function findAssetFree(
  balances: BinanceBalance[],
  asset: string,
): number {
  const match = balances.find((item) => item.asset === asset);
  return Number(match?.free ?? 0);
}

function executedQtyFromBinanceOrder(payload: BinanceOrderResponse): number {
  const direct = Number(payload.executedQty ?? 0);
  if (direct > 0) {
    return direct;
  }

  return (payload.fills ?? []).reduce(
    (sum, fill) => sum + Number(fill.qty ?? 0),
    0,
  );
}

function executedQuoteFromBinanceOrder(payload: BinanceOrderResponse): number {
  const direct = Number(payload.cummulativeQuoteQty ?? 0);
  if (direct > 0) {
    return direct;
  }

  return (payload.fills ?? []).reduce((sum, fill) => {
    const qty = Number(fill.qty ?? 0);
    const price = Number(fill.price ?? 0);
    return sum + qty * price;
  }, 0);
}

export async function placeBinanceMarketOrder(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  return withMarketOrderLock("binance", () => placeBinanceMarketOrderUnlocked(request));
}

async function placeBinanceMarketOrderUnlocked(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  await ensureBinanceTimeSynced();
  await ensureBinanceFilters();

  const place = async (): Promise<{
    response: Response;
    payload: BinanceOrderResponse;
  }> => {
    const { apiKey, apiSecret } = getCredentials();
    const params = new URLSearchParams({
      symbol: BINANCE_SYMBOL,
      side: request.side,
      type: "MARKET",
      newClientOrderId: request.clientOrderId,
      newOrderRespType: "FULL",
      recvWindow: "5000",
      timestamp: binanceTimestamp(),
    });

    if (request.side === "BUY" && request.quoteAmountUsdt && request.quoteAmountUsdt > 0) {
      params.set("quoteOrderQty", formatDecimal(request.quoteAmountUsdt, USDT_DECIMALS));
    } else {
      params.set("quantity", formatDecimal(request.quantityEth, BINANCE_QTY_DECIMALS));
    }

    const body = params.toString();
    const signature = sign(body, apiSecret);
    const response = await fetch(
      `${BINANCE_API_URL}/api/v3/order?${body}&signature=${signature}`,
      {
        method: "POST",
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
      },
    );
    const payload = (await response.json()) as BinanceOrderResponse;
    return { response, payload };
  };

  let { response, payload } = await place();
  const failed =
    !response.ok || payload.code !== undefined || !payload.orderId;
  if (failed && isTimestampError(payload.msg ?? "")) {
    await ensureBinanceTimeSynced(true);
    ({ response, payload } = await place());
  }

  if (!response.ok || payload.code !== undefined || !payload.orderId) {
    throw new OrderError(
      "binance",
      payload.msg ?? `HTTP ${response.status} placing ${request.side} order`,
    );
  }

  const executedQtyEth = executedQtyFromBinanceOrder(payload);
  if (!(executedQtyEth > 0) || payload.status === "REJECTED" || payload.status === "EXPIRED") {
    throw new OrderError(
      "binance",
      `Order ${payload.orderId} did not fill (status=${payload.status ?? "unknown"}, qty=${payload.executedQty ?? "0"})`,
    );
  }

  return {
    exchange: "binance",
    side: request.side,
    orderId: String(payload.orderId),
    clientOrderId: payload.clientOrderId ?? request.clientOrderId,
    status: payload.status ?? "UNKNOWN",
    executedQtyEth,
    executedQuoteUsdt: executedQuoteFromBinanceOrder(payload),
  };
}
