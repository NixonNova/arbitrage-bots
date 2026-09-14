export const HEALTH_CHECK_INTERVAL_MS = 15_000;
export const INDODAX_PING_INTERVAL_MS = 20_000;
export const INDODAX_PING_TIMEOUT_MS = 15_000;
export const BINANCE_SERVER_PING_STALE_MS = 70_000;
/** Official: server closes if the client sends nothing for 60s. */
export const HYPERLIQUID_PING_INTERVAL_MS = 30_000;
export const HYPERLIQUID_INBOUND_STALE_MS = 70_000;

const RECONNECT_DELAYS_MS = [3_000, 5_000, 10_000, 20_000, 60_000];

export interface ReconnectState {
  attempt: number;
}

export function resetReconnectState(state: ReconnectState): void {
  state.attempt = 0;
}

export function nextReconnectDelayMs(state: ReconnectState): number {
  const delay =
    RECONNECT_DELAYS_MS[Math.min(state.attempt, RECONNECT_DELAYS_MS.length - 1)];
  const jitterMs = Math.floor(Math.random() * 1_000);
  state.attempt += 1;
  return delay + jitterMs;
}

export function isHeartbeatStale(
  lastHeartbeatAt: number,
  staleMs: number,
  now = Date.now(),
): boolean {
  return now - lastHeartbeatAt > staleMs;
}

export function formatCloseReason(code: number, reason: Buffer): string {
  const reasonText = reason.length > 0 ? reason.toString("utf8") : "none";
  return `code=${code} reason=${reasonText}`;
}

export function clearIntervalSafe(
  interval: ReturnType<typeof setInterval> | undefined,
): void {
  if (interval !== undefined) {
    clearInterval(interval);
  }
}

export function clearTimeoutSafe(
  timeout: ReturnType<typeof setTimeout> | undefined,
): void {
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
}
