import WebSocket from "ws";
import { HYPERLIQUID_INFO_URL, HYPERLIQUID_WS_URL } from "../config/market";
import { OrderBookQuote } from "../types/quote";
import {
  HYPERLIQUID_INBOUND_STALE_MS,
  HYPERLIQUID_PING_INTERVAL_MS,
  ReconnectState,
  clearIntervalSafe,
  clearTimeoutSafe,
  formatCloseReason,
  isHeartbeatStale,
  nextReconnectDelayMs,
  resetReconnectState,
} from "./connection";

const LOG_PREFIX = "[Hyperliquid]";

export interface HyperliquidSpotPair {
  coin: string;
  tokenName: string;
  pairLabel: string;
}

interface SpotToken {
  name?: string;
  index?: number;
}

interface SpotUniversePair {
  name?: string;
  tokens?: number[];
  index?: number;
}

interface SpotMeta {
  tokens?: SpotToken[];
  universe?: SpotUniversePair[];
}

interface WsLevel {
  px?: string;
  sz?: string;
}

interface WsMessage {
  channel?: string;
  data?: {
    coin?: string;
    levels?: [WsLevel[], WsLevel[]];
    time?: number;
  };
}

export async function resolveEthSpotPair(): Promise<HyperliquidSpotPair> {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" }),
  });
  const payload = (await response.json()) as SpotMeta;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching spotMeta`);
  }

  const tokens = payload.tokens ?? [];
  const universe = payload.universe ?? [];
  const quoteIndex =
    tokens.find((token) => token.name === "USDC")?.index ?? 0;
  const base =
    tokens.find((token) => token.name === "UETH") ??
    tokens.find((token) => token.name === "ETH");
  if (base?.name === undefined || base.index === undefined) {
    throw new Error("spotMeta has no UETH or ETH token");
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
    throw new Error(`No ${base.name}/USDC spot pair in universe`);
  }

  const coin =
    pair.name?.includes("/") === true ? pair.name : `@${pair.index}`;
  return {
    coin,
    tokenName: base.name,
    pairLabel: `${base.name}/USDC (${coin})`,
  };
}

export async function subscribeHyperliquidOrderBook(
  onQuote: (quote: OrderBookQuote, pair: HyperliquidSpotPair) => void,
): Promise<void> {
  let pair: HyperliquidSpotPair;
  try {
    pair = await resolveEthSpotPair();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Skipping ETH spot book: ${message}`);
    return;
  }

  const reconnectState: ReconnectState = { attempt: 0 };
  let healthCheckInterval: ReturnType<typeof setInterval> | undefined;
  let pingInterval: ReturnType<typeof setInterval> | undefined;
  let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
  let lastInboundAt = Date.now();
  let isCurrentSocket = false;

  function cleanupTimers(): void {
    clearIntervalSafe(healthCheckInterval);
    healthCheckInterval = undefined;
    clearIntervalSafe(pingInterval);
    pingInterval = undefined;
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

  function startHeartbeat(socket: WebSocket, active: () => boolean): void {
    pingInterval = setInterval(() => {
      if (!active() || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ method: "ping" }));
    }, HYPERLIQUID_PING_INTERVAL_MS);

    healthCheckInterval = setInterval(() => {
      if (!active()) {
        return;
      }

      if (isHeartbeatStale(lastInboundAt, HYPERLIQUID_INBOUND_STALE_MS)) {
        console.log(
          `${LOG_PREFIX} No inbound message for ${HYPERLIQUID_INBOUND_STALE_MS / 1000}s, reconnecting...`,
        );
        socket.terminate();
      }
    }, HYPERLIQUID_PING_INTERVAL_MS);
  }

  function connect(): WebSocket {
    isCurrentSocket = false;
    const socket = new WebSocket(HYPERLIQUID_WS_URL);

    socket.on("open", () => {
      isCurrentSocket = true;
      resetReconnectState(reconnectState);
      lastInboundAt = Date.now();
      console.log(`${LOG_PREFIX} Connected to ETH spot ${pair.pairLabel}`);
      socket.send(
        JSON.stringify({
          method: "subscribe",
          subscription: { type: "l2Book", coin: pair.coin, fast: true },
        }),
      );
      startHeartbeat(socket, () => isCurrentSocket);
    });

    socket.on("message", (raw) => {
      lastInboundAt = Date.now();
      let message: WsMessage;
      try {
        message = JSON.parse(raw.toString()) as WsMessage;
      } catch {
        return;
      }

      if (message.channel === "subscriptionResponse") {
        return;
      }
      if (message.channel === "pong") {
        return;
      }
      if (message.channel !== "l2Book") {
        return;
      }

      const bid = message.data?.levels?.[0]?.[0];
      const ask = message.data?.levels?.[1]?.[0];
      const bestBid = bid?.px;
      const bestBidQty = bid?.sz;
      const bestAsk = ask?.px;
      const bestAskQty = ask?.sz;
      if (bestBid && bestBidQty && bestAsk && bestAskQty) {
        onQuote({ bestBid, bestBidQty, bestAsk, bestAskQty }, pair);
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
