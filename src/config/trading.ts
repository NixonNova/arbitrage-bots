function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Minimum net profit % (after taker fees) required to execute a trade. */
export const MIN_PROFIT_PCT = parseNumber(process.env.MIN_PROFIT_PCT, 0.01);

/** Target notional trade size in USD per execution. */
export const TRADE_LIMIT_USD = parseNumber(process.env.TRADE_LIMIT_USD, 15);

/** Stop trading when any wallet balance falls to this fraction of its initial value. */
export const MIN_BALANCE_PCT = parseNumber(process.env.MIN_BALANCE_PCT, 0.1);

export const INITIAL_BINANCE_BTC = parseNumber(
  process.env.INITIAL_BINANCE_BTC,
  0.006,
);

export const INITIAL_BINANCE_USDT = parseNumber(
  process.env.INITIAL_BINANCE_USDT,
  500,
);

export const INITIAL_INDODAX_BTC = parseNumber(
  process.env.INITIAL_INDODAX_BTC,
  0.006,
);

export const INITIAL_INDODAX_USDT = parseNumber(
  process.env.INITIAL_INDODAX_USDT,
  500,
);
