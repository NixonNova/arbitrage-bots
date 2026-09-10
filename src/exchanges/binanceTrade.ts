import { createHmac } from "node:crypto";
import { BINANCE_QTY_DECIMALS, BINANCE_SYMBOL } from "../config/market";
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
  cummulativeQuoteQty?: string;
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

export async function fetchBinanceSpotBalances(): Promise<SpotBalances> {
  const { apiKey, apiSecret } = getCredentials();
  const params = new URLSearchParams({
    omitZeroBalances: "true",
    recvWindow: "5000",
    timestamp: Date.now().toString(),
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
}

function findAssetFree(
  balances: BinanceBalance[],
  asset: string,
): number {
  const match = balances.find((item) => item.asset === asset);
  return Number(match?.free ?? 0);
}

export async function placeBinanceMarketOrder(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  return withMarketOrderLock("binance", () => placeBinanceMarketOrderUnlocked(request));
}

async function placeBinanceMarketOrderUnlocked(
  request: MarketOrderRequest,
): Promise<PlacedOrder> {
  const { apiKey, apiSecret } = getCredentials();
  const params = new URLSearchParams({
    symbol: BINANCE_SYMBOL,
    side: request.side,
    type: "MARKET",
    newClientOrderId: request.clientOrderId,
    newOrderRespType: "FULL",
    recvWindow: "5000",
    timestamp: Date.now().toString(),
  });

  if (request.side === "BUY" && request.quoteAmountUsdt && request.quoteAmountUsdt > 0) {
    params.set("quoteOrderQty", formatDecimal(request.quoteAmountUsdt, USDT_DECIMALS));
  } else {
    params.set("quantity", formatDecimal(request.quantityEth, BINANCE_QTY_DECIMALS));
  }

  const body = params.toString();
  const signature = sign(body, apiSecret);
  const response = await fetch(`${BINANCE_API_URL}/api/v3/order?${body}&signature=${signature}`, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": apiKey,
    },
  });

  const payload = (await response.json()) as BinanceOrderResponse;
  if (!response.ok || payload.code !== undefined || !payload.orderId) {
    throw new OrderError(
      "binance",
      payload.msg ?? `HTTP ${response.status} placing ${request.side} order`,
    );
  }

  const executedQtyEth = Number(payload.executedQty ?? 0);
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
    executedQuoteUsdt: Number(payload.cummulativeQuoteQty ?? 0),
  };
}
