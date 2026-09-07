import WebSocket from "ws";
import { OrderBookQuote } from "../types/quote";

const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@depth20@100ms";

export function subscribeBinanceOrderBook(
  onQuote: (quote: OrderBookQuote) => void,
): WebSocket {
  const ws = new WebSocket(BINANCE_WS_URL);

  ws.on("open", () => {
    console.log("[Binance] Connected to BTC/USDT order book");
  });

  ws.on("message", (raw) => {
    const data = JSON.parse(raw.toString()) as {
      bids?: [string, string][];
      asks?: [string, string][];
    };

    const bestBid = data.bids?.[0]?.[0];
    const bestBidQty = data.bids?.[0]?.[1];
    const bestAsk = data.asks?.[0]?.[0];
    const bestAskQty = data.asks?.[0]?.[1];

    if (bestBid && bestBidQty && bestAsk && bestAskQty) {
      onQuote({ bestBid, bestBidQty, bestAsk, bestAskQty });
    }
  });

  ws.on("error", (err) => {
    console.error("[Binance] WebSocket error:", err.message);
  });

  ws.on("close", () => {
    console.log("[Binance] Disconnected, reconnecting in 3s...");
    setTimeout(() => subscribeBinanceOrderBook(onQuote), 3000);
  });

  return ws;
}
