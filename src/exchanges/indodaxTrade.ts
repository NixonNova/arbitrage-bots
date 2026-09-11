import { createHmac } from "node:crypto";
import { INDODAX_PAIR, INDODAX_PRICE_DECIMALS, INDODAX_QTY_DECIMALS } from "../config/market";
import { requiredEnv } from "../config/env";
import {
  formatDecimal,
  OrderError,
  roundUp,
  withMarketOrderLock,
  type MarketOrderRequest,
  type PlacedOrder,
} from "./orders";
import type { SpotBalances } from "./balances";

const INDODAX_TAPI_V2_URL = "https://api.indodax.com";
const INDODAX_TIME_URL = "https://indodax.com/api/server_time";
const INDODAX_TAPI_V2_SYMBOL = INDODAX_PAIR.replace("_", "");
const TIME_SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** USDT pairs reject MARKET. LIMIT at the quoted bid/ask takes without extra slip. */

let timeOffsetMs = 0;
let lastSyncedAt = 0;
let syncInFlight: Promise<void> | null = null;

interface IndodaxV2AccountResponse {
  balances?: Array<{ asset: string; free: string; locked: string }>;
  code?: number;
  msg?: string;
}

interface IndodaxV2OrderResponse {
  orderId?: number | string;
  order_id?: number | string;
  clientOrderId?: string;
  client_order_id?: string;
  status?: string;
  executedQty?: string | number;
  executed_qty?: string | number;
  origQty?: string | number;
  oriQty?: string | number;
  filledQty?: string | number;
  cummulativeQuoteQty?: string | number;
  cumulativeQuoteQty?: string | number;
  receive_eth?: string | number;
  data?: IndodaxV2OrderResponse;
  order?: IndodaxV2OrderResponse;
  code?: number;
  msg?: string;
}

function getCredentials(): { apiKey: string; apiSecret: string } {
  return {
    apiKey: requiredEnv("INDODAX_API_KEY"),
    apiSecret: requiredEnv("INDODAX_API_SECRET"),
  };
}

function signSha256(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function isTimestampError(message: string): boolean {
  return /timestamp|recvWindow|recv window/i.test(message);
}

function normalizeServerTime(serverTime: number): number {
  return serverTime < 1_000_000_000_000 ? serverTime * 1000 : serverTime;
}

async function syncIndodaxTime(): Promise<void> {
  const sentAt = Date.now();
  const response = await fetch(INDODAX_TIME_URL);
  const receivedAt = Date.now();
  const payload = (await response.json()) as { server_time?: number };

  if (!response.ok || typeof payload.server_time !== "number") {
    throw new OrderError(
      "indodax",
      `HTTP ${response.status} fetching server time`,
    );
  }

  const localMid = Math.floor((sentAt + receivedAt) / 2);
  timeOffsetMs = normalizeServerTime(payload.server_time) - localMid;
  lastSyncedAt = receivedAt;
  console.log(`[Indodax] Time offset ${timeOffsetMs}ms`);
}

async function ensureIndodaxTimeSynced(force = false): Promise<void> {
  if (!force && lastSyncedAt > 0 && Date.now() - lastSyncedAt < TIME_SYNC_INTERVAL_MS) {
    return;
  }

  if (syncInFlight) {
    await syncInFlight;
    if (!force || (lastSyncedAt > 0 && Date.now() - lastSyncedAt < 1_000)) {
      return;
    }
  }

  syncInFlight = syncIndodaxTime().finally(() => {
    syncInFlight = null;
  });
  await syncInFlight;
}

function indodaxTimestamp(): string {
  return Math.floor(Date.now() + timeOffsetMs).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapOrder(payload: IndodaxV2OrderResponse): IndodaxV2OrderResponse {
  if (payload.data && (payload.data.orderId != null || payload.data.order_id != null || payload.data.status)) {
    return payload.data;
  }
  if (payload.order && (payload.order.orderId != null || payload.order.order_id != null || payload.order.status)) {
    return payload.order;
  }
  return payload;
}

function orderIdOf(payload: IndodaxV2OrderResponse): string | undefined {
  const order = unwrapOrder(payload);
  const id = order.orderId ?? order.order_id;
  return id === undefined ? undefined : String(id);
}

function positiveNumber(...values: Array<string | number | undefined>): number {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function normalizeStatus(status: string | undefined): string {
  return (status ?? "").trim().toUpperCase();
}

function isFilledStatus(status: string): boolean {
  return (
    status === "FILLED" ||
    status === "CLOSED" ||
    status === "SELESAI" ||
    status === "DONE"
  );
}

function isRejectedStatus(status: string): boolean {
  return (
    status === "REJECTED" ||
    status === "EXPIRED" ||
    status === "CANCELLED" ||
    status === "CANCELED"
  );
}

function executedQtyOf(payload: IndodaxV2OrderResponse, requestedQty: number): number {
  const order = unwrapOrder(payload);
  const filled = positiveNumber(
    order.executedQty,
    order.executed_qty,
    order.filledQty,
    order.receive_eth,
  );
  if (filled > 0) {
    return filled;
  }

  if (isFilledStatus(normalizeStatus(order.status))) {
    return positiveNumber(order.origQty, order.oriQty, requestedQty);
  }

  return 0;
}

function isIndodaxErrorPayload(
  response: Response,
  payload: IndodaxV2OrderResponse,
): boolean {
  if (!response.ok) {
    return true;
  }
  if (typeof payload.code === "number" && payload.code !== 0) {
    return true;
  }
  return false;
}

async function fetchIndodaxOrderDetail(orderId: string): Promise<IndodaxV2OrderResponse> {
  await ensureIndodaxTimeSynced();
  const { apiKey, apiSecret } = getCredentials();
  const query = new URLSearchParams({
    symbol: INDODAX_TAPI_V2_SYMBOL,
    orderId,
    timestamp: indodaxTimestamp(),
    recvWindow: "5000",
  }).toString();
  const response = await fetch(`${INDODAX_TAPI_V2_URL}/api/v2/order?${query}`, {
    headers: {
      Accept: "application/json",
      "X-APIKEY": apiKey,
      Sign: signSha256(query, apiSecret),
    },
  });
  return unwrapOrder((await response.json()) as IndodaxV2OrderResponse);
}

async function cancelIndodaxOrder(orderId: string): Promise<IndodaxV2OrderResponse> {
  await ensureIndodaxTimeSynced();
  const { apiKey, apiSecret } = getCredentials();
  const query = new URLSearchParams({
    symbol: INDODAX_TAPI_V2_SYMBOL,
    orderId,
    timestamp: indodaxTimestamp(),
    recvWindow: "5000",
  }).toString();
  const response = await fetch(`${INDODAX_TAPI_V2_URL}/api/v2/order?${query}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      "X-APIKEY": apiKey,
      Sign: signSha256(query, apiSecret),
    },
  });
  const payload = unwrapOrder((await response.json()) as IndodaxV2OrderResponse);
  if (isIndodaxErrorPayload(response, payload)) {
    throw new OrderError(
      "indodax",
      payload.msg ?? `HTTP ${response.status} cancelling order ${orderId}`,
    );
  }
  return payload;
}

function isFullyFilled(status: string, executedQtyEth: number, requestedQty: number): boolean {
  if (isFilledStatus(status)) {
    return executedQtyEth > 0;
  }
  return requestedQty > 0 && executedQtyEth >= requestedQty * 0.999;
}

async function resolveIndodaxFill(
  ack: IndodaxV2OrderResponse,
  requestedQty: number,
): Promise<{
  orderId: string;
  status: string;
  executedQtyEth: number;
  executedQuoteUsdt: number;
  clientOrderId?: string;
}> {
  const pollWaitsMs = [0, 250, 500, 1000, 2000, 3000];
  let latest = unwrapOrder(ack);

  for (const waitMs of pollWaitsMs) {
    if (waitMs > 0) {
      await sleep(waitMs);
      const orderId = orderIdOf(latest);
      if (!orderId) {
        break;
      }
      try {
        latest = await fetchIndodaxOrderDetail(orderId);
      } catch {
        continue;
      }
    }

    const status = normalizeStatus(latest.status);
    const executedQtyEth = executedQtyOf(latest, requestedQty);
    if (isRejectedStatus(status)) {
      if (executedQtyEth > 0) {
        return {
          orderId: orderIdOf(latest) ?? "",
          status,
          executedQtyEth,
          executedQuoteUsdt: positiveNumber(
            latest.cummulativeQuoteQty,
            latest.cumulativeQuoteQty,
          ),
          clientOrderId: latest.clientOrderId ?? latest.client_order_id,
        };
      }
      throw new OrderError(
        "indodax",
        `Order ${orderIdOf(latest)} ${status.toLowerCase()}`,
      );
    }

    if (isFullyFilled(status, executedQtyEth, requestedQty)) {
      return {
        orderId: orderIdOf(latest) ?? "",
        status: status || "FILLED",
        executedQtyEth,
        executedQuoteUsdt: positiveNumber(
          latest.cummulativeQuoteQty,
          latest.cumulativeQuoteQty,
        ),
        clientOrderId: latest.clientOrderId ?? latest.client_order_id,
      };
    }
  }

  const orderId = orderIdOf(latest);
  if (orderId) {
    try {
      console.log(
        `[Indodax] Order ${orderId} not fully filled, cancelling remainder`,
      );
      const cancelled = await cancelIndodaxOrder(orderId);
      latest = unwrapOrder(cancelled);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[Indodax] Cancel ${orderId} failed (${message}), re-checking fill`);
    }

    try {
      latest = await fetchIndodaxOrderDetail(orderId);
    } catch {
      // Use cancel/ACK payload already in `latest`.
    }
  }

  const status = normalizeStatus(latest.status);
  const executedQtyEth = executedQtyOf(latest, requestedQty);
  if (isFullyFilled(status, executedQtyEth, requestedQty) || executedQtyEth > 0) {
    return {
      orderId: orderIdOf(latest) ?? orderId ?? "",
      status: status || "PARTIAL",
      executedQtyEth,
      executedQuoteUsdt: positiveNumber(
        latest.cummulativeQuoteQty,
        latest.cumulativeQuoteQty,
      ),
      clientOrderId: latest.clientOrderId ?? latest.client_order_id,
    };
  }

  throw new OrderError(
    "indodax",
    `Order ${orderIdOf(latest)} did not fill (status=${latest.status ?? "unknown"}, qty=${latest.executedQty ?? latest.executed_qty ?? "0"})`,
  );
}

function takerLimitPrice(side: "BUY" | "SELL", request: MarketOrderRequest): string {
  const exact = request.limitPriceText?.trim();
  const referencePrice =
    exact && Number(exact) > 0 ? Number(exact) : (request.limitPrice ?? 0);
  if (!(referencePrice > 0)) {
    throw new OrderError("indodax", "LIMIT order requires a top-of-book price");
  }

  if (side === "BUY") {
    return roundUp(referencePrice, INDODAX_PRICE_DECIMALS).toFixed(
      INDODAX_PRICE_DECIMALS,
    );
  }

  return formatDecimal(referencePrice, INDODAX_PRICE_DECIMALS);
}

async function fetchIndodaxSpotBalancesV2(
  apiKey: string,
  apiSecret: string,
): Promise<SpotBalances> {
  const query = new URLSearchParams({
    omitZeroBalances: "true",
    timestamp: indodaxTimestamp(),
    recvWindow: "5000",
  }).toString();
  const response = await fetch(`${INDODAX_TAPI_V2_URL}/api/v2/account?${query}`, {
    headers: {
      Accept: "application/json",
      "X-APIKEY": apiKey,
      Sign: signSha256(query, apiSecret),
    },
  });

  const payload = (await response.json()) as IndodaxV2AccountResponse;
  if (!response.ok || payload.code !== undefined || !payload.balances) {
    throw new OrderError(
      "indodax",
      payload.msg ?? `HTTP ${response.status} fetching TAPIv2 account balances`,
    );
  }

  const findFree = (asset: string): number => {
    const match = payload.balances?.find(
      (item) => item.asset.toUpperCase() === asset,
    );
    return Number(match?.free ?? 0);
  };

  return {
    eth: findFree("ETH"),
    usdt: findFree("USDT"),
  };
}

export async function fetchIndodaxSpotBalances(): Promise<SpotBalances> {
  const { apiKey, apiSecret } = getCredentials();
  await ensureIndodaxTimeSynced();

  try {
    return await fetchIndodaxSpotBalancesV2(apiKey, apiSecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isTimestampError(message)) {
      throw error;
    }

    await ensureIndodaxTimeSynced(true);
    return fetchIndodaxSpotBalancesV2(apiKey, apiSecret);
  }
}

export async function placeIndodaxMarketOrder(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  return withMarketOrderLock("indodax", () => placeIndodaxMarketOrderUnlocked(request));
}

async function placeIndodaxMarketOrderUnlocked(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  await ensureIndodaxTimeSynced();

  const place = async (): Promise<{
    response: Response;
    payload: IndodaxV2OrderResponse;
  }> => {
    const { apiKey, apiSecret } = getCredentials();
    const limitPrice = takerLimitPrice(request.side, request);
    const params = new URLSearchParams({
      symbol: INDODAX_TAPI_V2_SYMBOL,
      side: request.side,
      type: "LIMIT",
      timeInForce: "GTC",
      quantity: formatDecimal(request.quantityEth, INDODAX_QTY_DECIMALS),
      price: limitPrice,
      newClientOrderId: request.clientOrderId,
      timestamp: indodaxTimestamp(),
      recvWindow: "5000",
    });

    console.log(
      `[Indodax] LIMIT ${request.side} ${formatDecimal(request.quantityEth, INDODAX_QTY_DECIMALS)} ETH @ ${limitPrice} USDT`,
    );

    const body = params.toString();
    const response = await fetch(`${INDODAX_TAPI_V2_URL}/api/v2/order`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-APIKEY": apiKey,
        Sign: signSha256(body, apiSecret),
      },
      body,
    });
    const payload = unwrapOrder((await response.json()) as IndodaxV2OrderResponse);
    return { response, payload };
  };

  let { response, payload } = await place();
  if (isIndodaxErrorPayload(response, payload) && isTimestampError(payload.msg ?? "")) {
    await ensureIndodaxTimeSynced(true);
    ({ response, payload } = await place());
  }
  if (isIndodaxErrorPayload(response, payload) || orderIdOf(payload) === undefined) {
    throw new OrderError(
      "indodax",
      payload.msg ?? `HTTP ${response.status} placing ${request.side} order`,
    );
  }

  console.log(
    `[Indodax] Order ACK ${orderIdOf(payload)} status=${payload.status ?? "unknown"} executedQty=${payload.executedQty ?? payload.executed_qty ?? "n/a"}`,
  );

  const filled = await resolveIndodaxFill(payload, request.quantityEth);
  if (!(filled.executedQtyEth > 0)) {
    throw new OrderError(
      "indodax",
      `Order ${filled.orderId} did not fill (status=${filled.status}, qty=${filled.executedQtyEth})`,
    );
  }

  return {
    exchange: "indodax",
    side: request.side,
    orderId: filled.orderId,
    clientOrderId: filled.clientOrderId ?? request.clientOrderId,
    status: filled.status,
    executedQtyEth: filled.executedQtyEth,
    executedQuoteUsdt: filled.executedQuoteUsdt,
  };
}

/*
 * TAPIv1 (legacy). Left commented because current API keys are TAPIv2.
 *
 * const INDODAX_TAPI_URL = "https://indodax.com/tapi";
 *
 * interface IndodaxInfoResponse {
 *   success?: number;
 *   error?: string;
 *   return?: {
 *     balance?: {
 *       eth?: string | number;
 *       usdt?: string | number;
 *     };
 *   };
 * }
 *
 * interface IndodaxTradeResponse {
 *   success?: number;
 *   error?: string;
 *   return?: {
 *     order_id?: number | string;
 *     client_order_id?: string;
 *     receive_eth?: string;
 *     remain_eth?: string;
 *     spend_usdt?: number | string;
 *     spend_rp?: number | string;
 *   };
 * }
 *
 * function signSha512(body: string, secret: string): string {
 *   return createHmac("sha512", secret).update(body).digest("hex");
 * }
 *
 * async function fetchIndodaxSpotBalancesV1(
 *   apiKey: string,
 *   apiSecret: string,
 * ): Promise<SpotBalances> {
 *   const body = new URLSearchParams({
 *     method: "getInfo",
 *     timestamp: Date.now().toString(),
 *     recvWindow: "5000",
 *   }).toString();
 *
 *   const response = await fetch(INDODAX_TAPI_URL, {
 *     method: "POST",
 *     headers: {
 *       Key: apiKey,
 *       Sign: signSha512(body, apiSecret),
 *       "Content-Type": "application/x-www-form-urlencoded",
 *     },
 *     body,
 *   });
 *
 *   const payload = (await response.json()) as IndodaxInfoResponse;
 *   if (!response.ok || payload.success !== 1 || !payload.return?.balance) {
 *     throw new OrderError(
 *       "indodax",
 *       payload.error ?? `HTTP ${response.status} fetching account balances`,
 *     );
 *   }
 *
 *   return {
 *     eth: Number(payload.return.balance.eth ?? 0),
 *     usdt: Number(payload.return.balance.usdt ?? 0),
 *   };
 * }
 *
 * function isWrongTapiVersion(error: unknown): boolean {
 *   const message = error instanceof Error ? error.message : String(error);
 *   return /api key version|tapi v2|invalid tapi version/i.test(message);
 * }
 *
 * export async function fetchIndodaxSpotBalancesV1Fallback(): Promise<SpotBalances> {
 *   const { apiKey, apiSecret } = getCredentials();
 *   try {
 *     return await fetchIndodaxSpotBalancesV1(apiKey, apiSecret);
 *   } catch (error) {
 *     if (!isWrongTapiVersion(error)) {
 *       throw error;
 *     }
 *
 *     return fetchIndodaxSpotBalancesV2(apiKey, apiSecret);
 *   }
 * }
 *
 * export async function placeIndodaxMarketOrderV1(
 *   request: MarketOrderRequest,
 * ): Promise<PlacedOrder> {
 *   const { apiKey, apiSecret } = getCredentials();
 *   const params = new URLSearchParams({
 *     method: "trade",
 *     timestamp: Date.now().toString(),
 *     recvWindow: "5000",
 *     pair: INDODAX_PAIR,
 *     type: request.side === "BUY" ? "buy" : "sell",
 *     order_type: "market",
 *     client_order_id: request.clientOrderId,
 *   });
 *
 *   if (request.side === "BUY") {
 *     const quoteAmount = request.quoteAmountUsdt ?? 0;
 *     if (!(quoteAmount > 0)) {
 *       throw new OrderError("indodax", "Market buy requires a USDT quote amount");
 *     }
 *     params.set("usdt", formatDecimal(quoteAmount, USDT_DECIMALS));
 *   } else {
 *     params.set("eth", formatDecimal(request.quantityEth, INDODAX_QTY_DECIMALS));
 *   }
 *
 *   const body = params.toString();
 *   const response = await fetch(INDODAX_TAPI_URL, {
 *     method: "POST",
 *     headers: {
 *       Key: apiKey,
 *       Sign: signSha512(body, apiSecret),
 *       "Content-Type": "application/x-www-form-urlencoded",
 *     },
 *     body,
 *   });
 *
 *   const payload = (await response.json()) as IndodaxTradeResponse;
 *   if (!response.ok || payload.success !== 1 || payload.return?.order_id === undefined) {
 *     throw new OrderError(
 *       "indodax",
 *       payload.error ?? `HTTP ${response.status} placing ${request.side} order`,
 *     );
 *   }
 *
 *   const executedQtyEth = Number(payload.return.receive_eth ?? request.quantityEth);
 *   const executedQuoteUsdt = Number(
 *     payload.return.spend_usdt ?? payload.return.spend_rp ?? 0,
 *   );
 *
 *   if (request.side === "BUY" && !(executedQtyEth > 0)) {
 *     throw new OrderError(
 *       "indodax",
 *       `Order ${payload.return.order_id} buy did not return filled ETH quantity`,
 *     );
 *   }
 *
 *   return {
 *     exchange: "indodax",
 *     side: request.side,
 *     orderId: String(payload.return.order_id),
 *     clientOrderId: payload.return.client_order_id ?? request.clientOrderId,
 *     status: "FILLED",
 *     executedQtyEth: request.side === "SELL" ? request.quantityEth : executedQtyEth,
 *     executedQuoteUsdt,
 *   };
 * }
 */
