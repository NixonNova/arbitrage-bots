import {
  BINANCE_BOOK_TICKER_URL,
  BINANCE_USDCUSDT_SYMBOL,
} from "../config/market";

const LOG_PREFIX = "[USDC]";
const POLL_INTERVAL_MS = 5_000;
const STALE_MS = 30_000;
/** Skip Hyperliquid conversion if mid is more than 20 bps from 1. */
const MAX_DEPEG = 0.002;

interface BookTicker {
  symbol?: string;
  bidPrice?: string;
  askPrice?: string;
}

let usdtPerUsdc: number | null = null;
let lastGoodAt = 0;
let lastSkipReason: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;

export function getUsdtPerUsdc(): number | null {
  if (usdtPerUsdc === null) {
    return null;
  }
  if (Date.now() - lastGoodAt > STALE_MS) {
    return null;
  }
  return usdtPerUsdc;
}

export function usdcUsdtSkipReason(): string | null {
  if (getUsdtPerUsdc() !== null) {
    return null;
  }
  return lastSkipReason ?? "USDCUSDT mid not ready";
}

function setSkip(reason: string): void {
  if (lastSkipReason !== reason) {
    console.log(`${LOG_PREFIX} ${reason}; Hyperliquid spreads paused`);
  }
  lastSkipReason = reason;
  usdtPerUsdc = null;
}

async function refreshUsdcUsdtMid(): Promise<void> {
  const response = await fetch(
    `${BINANCE_BOOK_TICKER_URL}?symbol=${BINANCE_USDCUSDT_SYMBOL}`,
  );
  const payload = (await response.json()) as BookTicker;
  if (!response.ok) {
    setSkip(`HTTP ${response.status} fetching ${BINANCE_USDCUSDT_SYMBOL}`);
    return;
  }

  const bid = Number(payload.bidPrice);
  const ask = Number(payload.askPrice);
  if (!(bid > 0) || !(ask > 0) || ask < bid) {
    setSkip(`${BINANCE_USDCUSDT_SYMBOL} book ticker missing bid/ask`);
    return;
  }

  const mid = (bid + ask) / 2;
  if (Math.abs(mid - 1) > MAX_DEPEG) {
    setSkip(
      `${BINANCE_USDCUSDT_SYMBOL} mid ${mid.toFixed(6)} is more than ${(MAX_DEPEG * 100).toFixed(2)}% from peg`,
    );
    return;
  }

  const wasMissing = usdtPerUsdc === null;
  usdtPerUsdc = mid;
  lastGoodAt = Date.now();
  if (wasMissing || lastSkipReason) {
    console.log(
      `${LOG_PREFIX} ${BINANCE_USDCUSDT_SYMBOL} mid ${mid.toFixed(6)} (bid ${bid} ask ${ask})`,
    );
  }
  lastSkipReason = null;
}

export function startUsdcUsdtPoller(): void {
  if (pollTimer) {
    return;
  }
  void refreshUsdcUsdtMid().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setSkip(`USDCUSDT poll failed (${message})`);
  });
  pollTimer = setInterval(() => {
    void refreshUsdcUsdtMid().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSkip(`USDCUSDT poll failed (${message})`);
    });
  }, POLL_INTERVAL_MS);
}
