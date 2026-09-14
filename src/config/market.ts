/** Shared ETH/USDT pair settings for both exchanges. */
export const BASE_ASSET = "ETH";
export const QUOTE_ASSET = "USDT";

export const BINANCE_SYMBOL = "ETHUSDT";
export const BINANCE_WS_URL =
  "wss://stream.binance.com:9443/ws/ethusdt@depth20@100ms";
/** Official Binance USDC/USDT book ticker for Hyperliquid USDC → USDT conversion. */
export const BINANCE_USDCUSDT_SYMBOL = "USDCUSDT";
export const BINANCE_BOOK_TICKER_URL = "https://api.binance.com/api/v3/ticker/bookTicker";

export const INDODAX_PAIR = "eth_usdt";
export const INDODAX_ORDER_BOOK_CHANNEL = "market:order-book-ethusdt";

/** Official Hyperliquid mainnet info, public WebSocket, and signed exchange. */
export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws";
export const HYPERLIQUID_EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
/** Official spot min notional in quote token (USDC). */
export const HYPERLIQUID_MIN_NOTIONAL_USDC = 10;
/** Spot MAX_DECIMALS from official tick-and-lot-size docs. */
export const HYPERLIQUID_SPOT_MAX_DECIMALS = 8;

/** Official Tokocrypto symbols + type-1 (MBX) public market WebSocket. */
export const TOKOCRYPTO_SYMBOLS_URL =
  "https://www.tokocrypto.com/open/v1/common/symbols";
export const TOKOCRYPTO_SYMBOL = "ETH_USDT";
export const TOKOCRYPTO_WS_STREAM = "ethusdt@depth20@100ms";
export const TOKOCRYPTO_WS_TYPE1 = "wss://stream-cloud.tokocrypto.site/stream";
export const TOKOCRYPTO_WS_TYPE2 = "wss://www.tokocrypto.com/stream";
export const TOKOCRYPTO_WS_TYPE3 = "wss://stream-toko.2meta.app/stream";

/** Binance ETHUSDT LOT_SIZE step is typically 0.0001. */
export const BINANCE_QTY_DECIMALS = 4;
/**
 * Fallback if GET /api/v3/exchangeInfo is unavailable.
 * Live ETHUSDT NOTIONAL.minNotional is currently 5 USDT.
 */
export const BINANCE_MIN_NOTIONAL_USD = 5;
/** TAPIv2 rejects ETH amounts with more than 6 fraction digits. */
export const INDODAX_QTY_DECIMALS = 6;
/** ETH/USDT price fraction is also max 6 digits. */
export const INDODAX_PRICE_DECIMALS = 6;

/** Binance wallet API network id for BNB Smart Chain (BEP-20). */
export const BINANCE_USDT_NETWORK = "BSC";
/** Indodax TAPIv2 network id for the same BNB Chain / BEP-20 rail. */
export const INDODAX_USDT_NETWORK = "BEP20";
