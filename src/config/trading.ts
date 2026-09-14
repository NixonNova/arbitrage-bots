import { envFlag } from "./env";
import {
  ALL_VENUE_IDS,
  EXCHANGE_CONFIG_NAMES,
  parseExchangeConfigName,
  type VenueId,
} from "../trading/venues";

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
 * When true, place real orders on included live venues
 * (Binance, Indodax, Hyperliquid). Tokocrypto stays paper-sim.
 */
export const LIVE_TRADING = envFlag("LIVE_TRADING", false);

/**
 * IBKR TWS client — parked until a weekday US session.
 * Keep IBKR_ENABLED=false (or unset). Re-enable startIbkrClient() in index.ts
 * and these env vars together.
 */
export const IBKR_ENABLED = envFlag("IBKR_ENABLED", false);

export const IBKR_HOST = process.env.IBKR_HOST?.trim() || "127.0.0.1";

export const IBKR_PORT = Math.floor(parseNumber(process.env.IBKR_PORT, 7497));

export const IBKR_CLIENT_ID = Math.floor(parseNumber(process.env.IBKR_CLIENT_ID, 1));

export const IBKR_PYTHON = process.env.IBKR_PYTHON?.trim() || "python";

const KNOWN_EXCHANGE_NAMES = ALL_VENUE_IDS.map(
  (id) => EXCHANGE_CONFIG_NAMES[id],
).join(",");

const LIVE_CAPABLE = new Set<VenueId>(["binance", "indodax", "hyperliquid"]);

function parseExchangeList(
  raw: string | undefined,
  envName: string,
  fallback: string | undefined,
): Set<VenueId> {
  const value = raw === undefined ? fallback : raw;
  if (value === undefined) {
    return new Set();
  }

  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const parsed = new Set<VenueId>();
  const unknown: string[] = [];

  for (const token of tokens) {
    const venueId = parseExchangeConfigName(token);
    if (!venueId) {
      unknown.push(token);
      continue;
    }
    parsed.add(venueId);
  }

  if (unknown.length > 0) {
    throw new Error(
      `${envName} has unknown name(s): ${unknown.join(", ")}. Use ${KNOWN_EXCHANGE_NAMES}.`,
    );
  }

  return parsed;
}

function defaultLiveExchangesRaw(): string | undefined {
  if (process.env.EXCHANGES_INCLUDED !== undefined) {
    return process.env.EXCHANGES_INCLUDED;
  }
  return "BINANCE,INDODAX";
}

function defaultSimExchangesRaw(): string {
  if (
    process.env.LIVE_EXCHANGES === undefined &&
    process.env.EXCHANGES_INCLUDED === undefined
  ) {
    return "TOKOCRYPTO,HYPERLIQUID";
  }
  return "";
}

const parsedLive = parseExchangeList(
  process.env.LIVE_EXCHANGES,
  "LIVE_EXCHANGES",
  defaultLiveExchangesRaw(),
);
const parsedSim = parseExchangeList(
  process.env.SIMULATION_EXCHANGES,
  "SIMULATION_EXCHANGES",
  defaultSimExchangesRaw(),
);

const liveNotCapable = [...parsedLive].filter((id) => !LIVE_CAPABLE.has(id));
if (liveNotCapable.length > 0) {
  throw new Error(
    `LIVE_EXCHANGES cannot include ${liveNotCapable
      .map((id) => EXCHANGE_CONFIG_NAMES[id])
      .join(", ")}. Move them to SIMULATION_EXCHANGES.`,
  );
}

/**
 * Real-money venues: scan, trade, and rebalance.
 * Unset falls back to EXCHANGES_INCLUDED, else BINANCE,INDODAX. Empty = none.
 */
export const LIVE_EXCHANGES = parsedLive;

/**
 * Read-only venues: scan and log (including yellow best). No real orders.
 * A name in both lists is treated as live.
 */
export const SIMULATION_EXCHANGES = new Set(
  [...parsedSim].filter((id) => !parsedLive.has(id)),
);

export function isExchangeLive(venueId: VenueId): boolean {
  return LIVE_EXCHANGES.has(venueId);
}

export function isExchangeSim(venueId: VenueId): boolean {
  return SIMULATION_EXCHANGES.has(venueId);
}

/** Live or simulation — subscribe, scan, and log. */
export function isExchangeActive(venueId: VenueId): boolean {
  return isExchangeLive(venueId) || isExchangeSim(venueId);
}

export function isExchangeIncluded(venueId: VenueId): boolean {
  return isExchangeActive(venueId);
}

export function liveExchangeNames(): string[] {
  return ALL_VENUE_IDS.filter((id) => LIVE_EXCHANGES.has(id)).map(
    (id) => EXCHANGE_CONFIG_NAMES[id],
  );
}

export function simulationExchangeNames(): string[] {
  return ALL_VENUE_IDS.filter((id) => SIMULATION_EXCHANGES.has(id)).map(
    (id) => EXCHANGE_CONFIG_NAMES[id],
  );
}

export function includedExchangeNames(): string[] {
  return ALL_VENUE_IDS.filter((id) => isExchangeActive(id)).map(
    (id) => EXCHANGE_CONFIG_NAMES[id],
  );
}

/** Stop trading when any wallet balance falls to this fraction of its initial value. */
export const MIN_BALANCE_PCT = parseNumber(process.env.MIN_BALANCE_PCT, 0.1);

/**
 * USDT rebalance trigger vs that exchange's startup USDT.
 * Separate from MIN_BALANCE_PCT (halt).
 */
export const REBALANCE_USDT_PCT = parseNumber(process.env.REBALANCE_USDT_PCT, 0.25);

/** Skip a USDT transfer smaller than this (covers typical BEP-20 fees). */
export const REBALANCE_MIN_USDT = parseNumber(process.env.REBALANCE_MIN_USDT, 10);

/**
 * Cap each USDT rebalance at this amount. 0 = send the full 50/50 gap.
 * Default $10 so a first live test cannot move more than that.
 */
export const REBALANCE_MAX_USDT = parseNumber(process.env.REBALANCE_MAX_USDT, 10);

/**
 * Halt after this many successful USDT rebalances. 0 = keep rebalancing.
 */
export const MAX_USDT_REBALANCES = Math.floor(
  parseNumber(process.env.MAX_USDT_REBALANCES, 1),
);

/** Destination for USDT sent TO Binance on BNB Chain / BEP-20. */
export const BINANCE_USDT_DEPOSIT_ADDRESS =
  process.env.BINANCE_USDT_DEPOSIT_ADDRESS?.trim() ?? "";

/** Destination for USDT sent TO Indodax on BNB Chain / BEP-20. */
export const INDODAX_USDT_DEPOSIT_ADDRESS =
  process.env.INDODAX_USDT_DEPOSIT_ADDRESS?.trim() ?? "";

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

/** Fallback when Hyperliquid live balances are unavailable. */
export const INITIAL_HYPERLIQUID_ETH = parseNumber(
  process.env.INITIAL_HYPERLIQUID_ETH,
  0.1,
);

export const INITIAL_HYPERLIQUID_USDT = parseNumber(
  process.env.INITIAL_HYPERLIQUID_USDT,
  200,
);

export const INITIAL_TOKOCRYPTO_ETH = parseNumber(
  process.env.INITIAL_TOKOCRYPTO_ETH,
  0.1,
);

export const INITIAL_TOKOCRYPTO_USDT = parseNumber(
  process.env.INITIAL_TOKOCRYPTO_USDT,
  200,
);
