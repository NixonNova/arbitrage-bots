/** Shared ETH/USDT pair settings for both exchanges. */
export const BASE_ASSET = "ETH";
export const QUOTE_ASSET = "USDT";

export const BINANCE_SYMBOL = "ETHUSDT";
export const BINANCE_WS_URL =
  "wss://stream.binance.com:9443/ws/ethusdt@depth20@100ms";

export const INDODAX_PAIR = "eth_usdt";
export const INDODAX_ORDER_BOOK_CHANNEL = "market:order-book-ethusdt";

/** Binance ETHUSDT LOT_SIZE step is typically 0.0001. */
export const BINANCE_QTY_DECIMALS = 4;
export const INDODAX_QTY_DECIMALS = 8;
