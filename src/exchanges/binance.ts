import WebSocket from "ws";
import { OrderBookQuote } from "../types/quote";
import { BINANCE_WS_URL } from "../config/market";
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

const LOG_PREFIX = "[Binance]";

export function subscribeBinanceOrderBook(
  onQuote: (quote: OrderBookQuote) => void,
): WebSocket {
  const reconnectState: ReconnectState = { attempt: 0 };
  let ws: WebSocket;
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
      ws = connect();
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
    const socket = new WebSocket(BINANCE_WS_URL);

    socket.on("open", () => {
      isCurrentSocket = true;
      resetReconnectState(reconnectState);
      lastServerPingAt = Date.now();
      console.log(`${LOG_PREFIX} Connected to ETH/USDT order book`);
      startHealthCheck(socket, () => isCurrentSocket);
    });

    socket.on("ping", (data) => {
      lastServerPingAt = Date.now();
      socket.pong(data);
    });

    socket.on("message", (raw) => {
      const data = JSON.parse(raw.toString()) as {
        e?: string;
        bids?: [string, string][];
        asks?: [string, string][];
      };

      if (data.e === "serverShutdown") {
        console.log(`${LOG_PREFIX} Server shutdown notice received, reconnecting...`);
        socket.terminate();
        return;
      }

      const bestBid = data.bids?.[0]?.[0];
      const bestBidQty = data.bids?.[0]?.[1];
      const bestAsk = data.asks?.[0]?.[0];
      const bestAskQty = data.asks?.[0]?.[1];

      if (bestBid && bestBidQty && bestAsk && bestAskQty) {
        onQuote({ bestBid, bestBidQty, bestAsk, bestAskQty });
      }
    });

    socket.on("error", (err) => {
      console.error(`${LOG_PREFIX} WebSocket error:`, err.message);
    });

    socket.on("close", (code, reason) => {
      isCurrentSocket = false;
      scheduleReconnect(
        `Disconnected (${formatCloseReason(code, reason)}).`,
      );
    });

    return socket;
  }

  ws = connect();
  return ws;
}
