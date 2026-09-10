import { createHmac } from "node:crypto";
import { INDODAX_PAIR, INDODAX_QTY_DECIMALS } from "../config/market";
import { requiredEnv } from "../config/env";
import {
  formatDecimal,
  OrderError,
  withMarketOrderLock,
  type MarketOrderRequest,
  type PlacedOrder,
} from "./orders";
import type { SpotBalances } from "./balances";

const INDODAX_TAPI_V2_URL = "https://api.indodax.com";
const INDODAX_TAPI_V2_SYMBOL = INDODAX_PAIR.replace("_", "");
const USDT_DECIMALS = 2;

interface IndodaxV2AccountResponse {
  balances?: Array<{ asset: string; free: string; locked: string }>;
  code?: number;
  msg?: string;
}

interface IndodaxV2OrderResponse {
  orderId?: number | string;
  clientOrderId?: string;
  status?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
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

async function fetchIndodaxSpotBalancesV2(
  apiKey: string,
  apiSecret: string,
): Promise<SpotBalances> {
  const query = new URLSearchParams({
    omitZeroBalances: "true",
    timestamp: Date.now().toString(),
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
  return fetchIndodaxSpotBalancesV2(apiKey, apiSecret);
}

export async function placeIndodaxMarketOrder(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  return withMarketOrderLock("indodax", () => placeIndodaxMarketOrderUnlocked(request));
}

async function placeIndodaxMarketOrderUnlocked(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  const { apiKey, apiSecret } = getCredentials();
  const params = new URLSearchParams({
    symbol: INDODAX_TAPI_V2_SYMBOL,
    side: request.side,
    type: "MARKET",
    newClientOrderId: request.clientOrderId,
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  });

  if (request.side === "BUY") {
    const quoteAmount = request.quoteAmountUsdt ?? 0;
    if (!(quoteAmount > 0)) {
      throw new OrderError("indodax", "Market buy requires a USDT quote amount");
    }
    params.set("quoteOrderQty", formatDecimal(quoteAmount, USDT_DECIMALS));
  } else {
    params.set("quantity", formatDecimal(request.quantityEth, INDODAX_QTY_DECIMALS));
  }

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

  const payload = (await response.json()) as IndodaxV2OrderResponse;
  if (!response.ok || payload.code !== undefined || payload.orderId === undefined) {
    throw new OrderError(
      "indodax",
      payload.msg ?? `HTTP ${response.status} placing ${request.side} order`,
    );
  }

  const executedQtyEth = Number(payload.executedQty ?? 0);
  if (!(executedQtyEth > 0) || payload.status === "REJECTED" || payload.status === "EXPIRED") {
    throw new OrderError(
      "indodax",
      `Order ${payload.orderId} did not fill (status=${payload.status ?? "unknown"}, qty=${payload.executedQty ?? "0"})`,
    );
  }

  return {
    exchange: "indodax",
    side: request.side,
    orderId: String(payload.orderId),
    clientOrderId: payload.clientOrderId ?? request.clientOrderId,
    status: payload.status ?? "UNKNOWN",
    executedQtyEth,
    executedQuoteUsdt: Number(payload.cummulativeQuoteQty ?? 0),
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
