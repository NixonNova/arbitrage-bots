export type VenueId = "binance" | "indodax" | "hyperliquid" | "tokocrypto";

export type ArbitrageDirection = `buy-${VenueId}-sell-${VenueId}`;

export const VENUE_LABELS: Record<VenueId, string> = {
  binance: "Binance",
  indodax: "Indodax",
  hyperliquid: "Hyperliquid",
  tokocrypto: "Tokocrypto",
};

/** Names used in LIVE_EXCHANGES and SIMULATION_EXCHANGES. */
export const EXCHANGE_CONFIG_NAMES: Record<VenueId, string> = {
  binance: "BINANCE",
  indodax: "INDODAX",
  hyperliquid: "HYPERLIQUID",
  tokocrypto: "TOKOCRYPTO",
};

const EXCHANGE_CONFIG_NAME_TO_ID: Record<string, VenueId> = {
  BINANCE: "binance",
  INDODAX: "indodax",
  HYPERLIQUID: "hyperliquid",
  TOKOCRYPTO: "tokocrypto",
};

export const ALL_VENUE_IDS = Object.keys(EXCHANGE_CONFIG_NAMES) as VenueId[];

export function parseExchangeConfigName(name: string): VenueId | null {
  return EXCHANGE_CONFIG_NAME_TO_ID[name.trim().toUpperCase()] ?? null;
}

export function makeDirection(
  buyVenue: VenueId,
  sellVenue: VenueId,
): ArbitrageDirection {
  return `buy-${buyVenue}-sell-${sellVenue}`;
}

export function parseDirection(direction: ArbitrageDirection): {
  buyVenue: VenueId;
  sellVenue: VenueId;
} {
  const match = /^buy-(binance|indodax|hyperliquid|tokocrypto)-sell-(binance|indodax|hyperliquid|tokocrypto)$/.exec(
    direction,
  );
  if (!match) {
    throw new Error(`Unknown direction ${direction}`);
  }
  return {
    buyVenue: match[1] as VenueId,
    sellVenue: match[2] as VenueId,
  };
}

export function directionLabel(direction: ArbitrageDirection): string {
  const { buyVenue, sellVenue } = parseDirection(direction);
  return `Buy ${VENUE_LABELS[buyVenue]} / Sell ${VENUE_LABELS[sellVenue]}`;
}

/** Tokocrypto has no live order path. */
export function isPaperSimVenue(venueId: VenueId): boolean {
  return venueId === "tokocrypto";
}

const LIVE_CAPABLE = new Set<VenueId>(["binance", "indodax", "hyperliquid"]);

/** Pair can place real orders if both venues support live trading. */
export function isLiveTradablePair(
  buyVenue: VenueId,
  sellVenue: VenueId,
): boolean {
  if (buyVenue === sellVenue) {
    return false;
  }
  if (isPaperSimVenue(buyVenue) || isPaperSimVenue(sellVenue)) {
    return false;
  }
  return LIVE_CAPABLE.has(buyVenue) && LIVE_CAPABLE.has(sellVenue);
}
