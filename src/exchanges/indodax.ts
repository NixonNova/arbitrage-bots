import WebSocket from "ws";
import { OrderBookQuote } from "../types/quote";

const INDODAX_WS_URL = "wss://ws3.indodax.com/ws/";
const INDODAX_STATIC_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE5NDY2MTg0MTV9.UR1lBM6Eqh0yWz-PVirw1uPCxe60FdchR8eNVdsskeo";
const ORDER_BOOK_CHANNEL = "market:order-book-btcusdt";

interface OrderBookLevel {
  price: string;
  btc_volume?: string;
  usdt_volume?: string;
}

interface OrderBookData {
  pair: string;
  ask: OrderBookLevel[];
  bid: OrderBookLevel[];
}

function getBtcVolume(level: OrderBookLevel | undefined): string | undefined {
  if (!level) {
    return undefined;
  }

  return level.btc_volume;
}

export function subscribeIndodaxOrderBook(
  onQuote: (quote: OrderBookQuote) => void,
): WebSocket {
  const ws = new WebSocket(INDODAX_WS_URL);

  ws.on("open", () => {
    console.log("[Indodax] Connected, authenticating...");
    ws.send(
      JSON.stringify({
        params: { token: INDODAX_STATIC_TOKEN },
        id: 1,
      }),
    );
  });

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as {
      id?: number;
      result?: {
        client?: string;
        channel?: string;
        data?: { data: OrderBookData };
      };
    };

    if (message.id === 1 && message.result?.client) {
      console.log("[Indodax] Authenticated, subscribing to BTC/USDT order book");
      ws.send(
        JSON.stringify({
          method: 1,
          params: { channel: ORDER_BOOK_CHANNEL },
          id: 2,
        }),
      );
      return;
    }

    const orderBook = message.result?.data?.data;
    if (!orderBook || message.result?.channel !== ORDER_BOOK_CHANNEL) {
      return;
    }

    const bestBid = orderBook.bid?.[0]?.price;
    const bestBidQty = getBtcVolume(orderBook.bid?.[0]);
    const bestAsk = orderBook.ask?.[0]?.price;
    const bestAskQty = getBtcVolume(orderBook.ask?.[0]);

    if (bestBid && bestBidQty && bestAsk && bestAskQty) {
      onQuote({ bestBid, bestBidQty, bestAsk, bestAskQty });
    }
  });

  ws.on("error", (err) => {
    console.error("[Indodax] WebSocket error:", err.message);
  });

  ws.on("close", () => {
    console.log("[Indodax] Disconnected, reconnecting in 3s...");
    setTimeout(() => subscribeIndodaxOrderBook(onQuote), 3000);
  });

  return ws;
}
