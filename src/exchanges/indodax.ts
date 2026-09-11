import WebSocket from "ws";
import { INDODAX_ORDER_BOOK_CHANNEL } from "../config/market";
import { OrderBookQuote } from "../types/quote";
import {
  INDODAX_PING_INTERVAL_MS,
  INDODAX_PING_TIMEOUT_MS,
  ReconnectState,
  clearIntervalSafe,
  clearTimeoutSafe,
  formatCloseReason,
  nextReconnectDelayMs,
  resetReconnectState,
} from "./connection";

const INDODAX_WS_URL = "wss://ws3.indodax.com/ws/";
const INDODAX_STATIC_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE5NDY2MTg0MTV9.UR1lBM6Eqh0yWz-PVirw1uPCxe60FdchR8eNVdsskeo";
const ORDER_BOOK_CHANNEL = INDODAX_ORDER_BOOK_CHANNEL;
const LOG_PREFIX = "[Indodax]";

interface OrderBookLevel {
  price: string;
  eth_volume?: string;
  btc_volume?: string;
  usdt_volume?: string;
  idr_volume?: string;
}

interface OrderBookData {
  pair: string;
  ask: OrderBookLevel[];
  bid: OrderBookLevel[];
}

function parsePositive(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getEthVolume(level: OrderBookLevel | undefined): string | undefined {
  if (!level) {
    return undefined;
  }

  const ethVolume = parsePositive(level.eth_volume);
  if (ethVolume > 0) {
    return level.eth_volume;
  }

  const baseVolume = parsePositive(level.btc_volume);
  if (baseVolume > 0) {
    return level.btc_volume;
  }

  const price = parsePositive(level.price);
  const quoteVolume =
    parsePositive(level.usdt_volume) || parsePositive(level.idr_volume);
  if (price > 0 && quoteVolume > 0) {
    return String(quoteVolume / price);
  }

  return undefined;
}

function parseIndodaxMessages(raw: string): object[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (!trimmed.includes("\n")) {
    return [JSON.parse(trimmed) as object];
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as object);
}

function buildSubscribeMessage(lastOffset: number | null): string {
  const params: {
    channel: string;
    recover?: boolean;
    offset?: number;
  } = {
    channel: ORDER_BOOK_CHANNEL,
  };

  if (lastOffset !== null) {
    params.recover = true;
    params.offset = lastOffset;
  }

  return JSON.stringify({
    method: 1,
    params,
    id: 2,
  });
}

export function subscribeIndodaxOrderBook(
  onQuote: (quote: OrderBookQuote) => void,
): WebSocket {
  const reconnectState: ReconnectState = { attempt: 0 };
  let lastOffset: number | null = null;
  let ws: WebSocket;
  let pingInterval: ReturnType<typeof setInterval> | undefined;
  let pingTimeout: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
  let pingRequestId = 100;
  let pendingPingId: number | null = null;
  let isCurrentSocket = false;

  function cleanupTimers(): void {
    clearIntervalSafe(pingInterval);
    pingInterval = undefined;
    clearTimeoutSafe(pingTimeout);
    pingTimeout = undefined;
    clearTimeoutSafe(reconnectTimeout);
    reconnectTimeout = undefined;
    pendingPingId = null;
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

  function clearPendingPing(): void {
    pendingPingId = null;
    clearTimeoutSafe(pingTimeout);
    pingTimeout = undefined;
  }

  function handlePingTimeout(socket: WebSocket): void {
    if (pendingPingId === null) {
      return;
    }

    console.log(
      `${LOG_PREFIX} Ping ${pendingPingId} timed out after ${INDODAX_PING_TIMEOUT_MS / 1000}s, reconnecting...`,
    );
    clearPendingPing();
    socket.terminate();
  }

  function sendPing(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (pendingPingId !== null) {
      handlePingTimeout(socket);
      return;
    }

    pingRequestId += 1;
    pendingPingId = pingRequestId;
    socket.send(
      JSON.stringify({
        method: 7,
        id: pingRequestId,
      }),
    );

    pingTimeout = setTimeout(() => {
      handlePingTimeout(socket);
    }, INDODAX_PING_TIMEOUT_MS);
  }

  function startPing(socket: WebSocket): void {
    sendPing(socket);
    pingInterval = setInterval(() => {
      sendPing(socket);
    }, INDODAX_PING_INTERVAL_MS);
  }

  function subscribe(socket: WebSocket): void {
    if (lastOffset !== null) {
      console.log(
        `${LOG_PREFIX} Subscribing with recovery from offset ${lastOffset}`,
      );
    } else {
      console.log(`${LOG_PREFIX} Authenticated, subscribing to ETH/USDT order book`);
    }

    socket.send(buildSubscribeMessage(lastOffset));
  }

  function handleOrderBookMessage(message: {
    result?: {
      channel?: string;
      data?: { data: OrderBookData; offset?: number };
    };
  }): void {
    const orderBook = message.result?.data?.data;
    if (!orderBook || message.result?.channel !== ORDER_BOOK_CHANNEL) {
      return;
    }

    const offset = message.result.data?.offset;
    if (offset !== undefined) {
      lastOffset = offset;
    }

    const bestBid = orderBook.bid?.[0]?.price;
    const bestBidQty = getEthVolume(orderBook.bid?.[0]);
    const bestAsk = orderBook.ask?.[0]?.price;
    const bestAskQty = getEthVolume(orderBook.ask?.[0]);

    if (bestBid && bestBidQty && bestAsk && bestAskQty) {
      onQuote({ bestBid, bestBidQty, bestAsk, bestAskQty });
    }
  }

  function connect(): WebSocket {
    isCurrentSocket = false;
    let isReady = false;
    const socket = new WebSocket(INDODAX_WS_URL);

    socket.on("open", () => {
      isCurrentSocket = true;
      resetReconnectState(reconnectState);
      console.log(`${LOG_PREFIX} Connected, authenticating...`);
      socket.send(
        JSON.stringify({
          params: { token: INDODAX_STATIC_TOKEN },
          id: 1,
        }),
      );
    });

    socket.on("message", (raw) => {
      try {
        const payloads = parseIndodaxMessages(raw.toString());

        for (const payload of payloads) {
          const message = payload as {
            id?: number;
            result?: {
              client?: string;
              channel?: string;
              offset?: number;
              data?: { data: OrderBookData; offset?: number };
            };
          };

          if (message.id !== undefined && message.id === pendingPingId) {
            clearPendingPing();
          }

          if (!isReady && message.id === 1 && message.result?.client) {
            isReady = true;
            subscribe(socket);
            startPing(socket);
            continue;
          }

          if (message.id === 2 && message.result?.offset !== undefined) {
            lastOffset = message.result.offset;
          }

          handleOrderBookMessage(message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} Failed to parse message:`, message);
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
