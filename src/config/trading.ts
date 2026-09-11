import { envFlag } from "./env";

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Minimum net profit % (after taker fees) required to execute a trade. */
export const MIN_PROFIT_PCT = parseNumber(process.env.MIN_PROFIT_PCT, 0.02);

/** Target notional trade size in USD per execution. */
export const TRADE_LIMIT_USD = parseNumber(process.env.TRADE_LIMIT_USD, 10);

/** Unpaired fills allowed before the bot fully stops. */
export const MAX_UNPAIRED_PAIRS = Math.floor(
  parseNumber(process.env.MAX_UNPAIRED_PAIRS, 5),
);

/**
 * When true, place real market orders on both exchanges.
 * Requires BINANCE_API_KEY, BINANCE_API_SECRET, INDODAX_API_KEY, INDODAX_API_SECRET.
 */
export const LIVE_TRADING = envFlag("LIVE_TRADING", false);

/** Stop trading when any wallet balance falls to this fraction of its initial value. */
export const MIN_BALANCE_PCT = parseNumber(process.env.MIN_BALANCE_PCT, 0.1);

/** Paper-sim fallback only. Ignored when API keys are present; live Spot balances are used instead. */
export const INITIAL_BINANCE_ETH = parseNumber(
  process.env.INITIAL_BINANCE_ETH,
  0.10445094,
);

export const INITIAL_BINANCE_USDT = parseNumber(
  process.env.INITIAL_BINANCE_USDT,
  189.76422276,
);

export const INITIAL_INDODAX_ETH = parseNumber(
  process.env.INITIAL_INDODAX_ETH,
  0.1,
);

export const INITIAL_INDODAX_USDT = parseNumber(
  process.env.INITIAL_INDODAX_USDT,
  200,
);
