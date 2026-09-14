import WebSocket from "ws";
import {
  TOKOCRYPTO_SYMBOL,
  TOKOCRYPTO_SYMBOLS_URL,
  TOKOCRYPTO_WS_STREAM,
  TOKOCRYPTO_WS_TYPE1,
  TOKOCRYPTO_WS_TYPE2,
  TOKOCRYPTO_WS_TYPE3,
} from "../config/market";
import { OrderBookQuote } from "../types/quote";
import {
  BINANCE_SERVER_PING_STALE_MS,
  HEALTH_CHECK_INTERVAL_MS,
  ReconnectState,
  clearIntervalSafe,
  clearTimeoutSafe,
  formatCloseReason,
  isHeartbeatStale,
  nextReconnectDelayMs,
  resetReconnectState,
} from "./connection";

const LOG_PREFIX = "[Tokocrypto]";

interface SymbolRow {
  type?: number;
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
}

interface SymbolsResponse {
  code?: number;
  msg?: string;
  data?: {
    list?: SymbolRow[];
  };
}

interface DepthLevels {
  bids?: [string, string][];
  asks?: [string, string][];
}

interface StreamMessage extends DepthLevels {
  stream?: string;
  data?: DepthLevels;
  result?: unknown;
  id?: number;
}

export interface TokocryptoSpotPair {
  symbolType: number;
  wsUrl: string;
  streamName: string;
}

function wsUrlForType(symbolType: number): string {
  if (symbolType === 3) {
    return TOKOCRYPTO_WS_TYPE3;
  }
  if (symbolType === 2) {
    return TOKOCRYPTO_WS_TYPE2;
  }
  return TOKOCRYPTO_WS_TYPE1;
}

export async function resolveEthUsdtPair(): Promise<TokocryptoSpotPair> {
  const response = await fetch(TOKOCRYPTO_SYMBOLS_URL);
  const payload = (await response.json()) as SymbolsResponse;
  if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
    throw new Error(
      payload.msg ?? `HTTP ${response.status} fetching Tokocrypto symbols`,
    );
  }

  const list = payload.data?.list ?? [];
  const row =
    list.find(
      (entry) =>
        (entry.symbol === TOKOCRYPTO_SYMBOL || entry.symbol === "ETHUSDT") &&
        (entry.quoteAsset === undefined || entry.quoteAsset === "USDT"),
    ) ?? list.find((entry) => entry.baseAsset === "ETH" && entry.quoteAsset === "USDT");

  if (row?.type === undefined) {
    throw new Error("common/symbols has no ETH/USDT pair");
  }

  return {
    symbolType: row.type,
    wsUrl: wsUrlForType(row.type),
    streamName: TOKOCRYPTO_WS_STREAM,
  };
}

function readDepth(message: StreamMessage): DepthLevels | undefined {
  if (message.data?.bids && message.data.asks) {
    return message.data;
  }
  if (message.bids && message.asks) {
    return message;
  }
  return undefined;
}

export async function subscribeTokocryptoOrderBook(
  onQuote: (quote: OrderBookQuote) => void,
): Promise<void> {
  let pair: TokocryptoSpotPair;
  try {
    pair = await resolveEthUsdtPair();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${LOG_PREFIX} Symbol lookup failed (${message}); defaulting to type-1 MBX stream`,
    );
    pair = {
      symbolType: 1,
      wsUrl: TOKOCRYPTO_WS_TYPE1,
      streamName: TOKOCRYPTO_WS_STREAM,
    };
  }

  const reconnectState: ReconnectState = { attempt: 0 };
  let healthCheckInterval: ReturnType<typeof setInterval> | undefined;
  let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
  let lastServerPingAt = Date.now();
  let isCurrentSocket = false;

  function cleanupTimers(): void {
    clearIntervalSafe(healthCheckInterval);
    healthCheckInterval = undefined;
    clearTimeoutSafe(reconnectTimeout);
    reconnectTimeout = undefined;
  }

  function scheduleReconnect(reason: string): void {
    cleanupTimers();
    const delayMs = nextReconnectDelayMs(reconnectState);
    console.log(
      `${LOG_PREFIX} ${reason} Reconnecting in ${(delayMs / 1000).toFixed(1)}s...`,
    );
    reconnectTimeout = setTimeout(() => {
      connect();
    }, delayMs);
  }

  function startHealthCheck(socket: WebSocket, active: () => boolean): void {
    healthCheckInterval = setInterval(() => {
      if (!active()) {
        return;
      }

      if (isHeartbeatStale(lastServerPingAt, BINANCE_SERVER_PING_STALE_MS)) {
        console.log(
          `${LOG_PREFIX} No server ping for ${BINANCE_SERVER_PING_STALE_MS / 1000}s, reconnecting...`,
        );
        socket.terminate();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  function connect(): WebSocket {
    isCurrentSocket = false;
    const socket = new WebSocket(pair.wsUrl);

    socket.on("open", () => {
      isCurrentSocket = true;
      resetReconnectState(reconnectState);
      lastServerPingAt = Date.now();
      console.log(
        `${LOG_PREFIX} Connected to ETH/USDT order book (type ${pair.symbolType})`,
      );
      socket.send(
        JSON.stringify({
          method: "SUBSCRIBE",
          params: [pair.streamName],
          id: 1,
        }),
      );
      startHealthCheck(socket, () => isCurrentSocket);
    });

    socket.on("ping", (data) => {
      lastServerPingAt = Date.now();
      socket.pong(data);
    });

    socket.on("message", (raw) => {
      lastServerPingAt = Date.now();
      let message: StreamMessage;
      try {
        message = JSON.parse(raw.toString()) as StreamMessage;
      } catch {
        return;
      }

      if (message.result !== undefined || message.id !== undefined) {
        if (!message.bids && !message.data?.bids) {
          return;
        }
      }

      const depth = readDepth(message);
      const bestBid = depth?.bids?.[0]?.[0];
      const bestBidQty = depth?.bids?.[0]?.[1];
      const bestAsk = depth?.asks?.[0]?.[0];
      const bestAskQty = depth?.asks?.[0]?.[1];
      if (bestBid && bestBidQty && bestAsk && bestAskQty) {
        onQuote({ bestBid, bestBidQty, bestAsk, bestAskQty });
      }
    });

    socket.on("error", (err) => {
      console.error(`${LOG_PREFIX} WebSocket error:`, err.message);
    });

    socket.on("close", (code, reason) => {
      isCurrentSocket = false;
      scheduleReconnect(`Disconnected (${formatCloseReason(code, reason)}).`);
    });

    return socket;
  }

  connect();
}
