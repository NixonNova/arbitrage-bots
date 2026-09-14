import { isExchangeLive } from "../config/trading";
import { optionalEnv } from "../config/env";
import { fetchBinanceSpotBalances } from "./binanceTrade";
import { fetchIndodaxSpotBalances } from "./indodaxTrade";

export interface SpotBalances {
  eth: number;
  usdt: number;
}

export interface BothSpotBalances {
  binance: SpotBalances;
  indodax: SpotBalances;
}

const LIVE_SPOT_VENUES = ["binance", "indodax"] as const;

const SPOT_API_KEYS: Record<(typeof LIVE_SPOT_VENUES)[number], readonly string[]> = {
  binance: ["BINANCE_API_KEY", "BINANCE_API_SECRET"],
  indodax: ["INDODAX_API_KEY", "INDODAX_API_SECRET"],
};

const EMPTY_SPOT: SpotBalances = { eth: 0, usdt: 0 };

export function includedLiveSpotVenues(): Array<(typeof LIVE_SPOT_VENUES)[number]> {
  return LIVE_SPOT_VENUES.filter((venue) => isExchangeLive(venue));
}

export function missingSpotApiKeys(): string[] {
  return includedLiveSpotVenues()
    .flatMap((venue) => SPOT_API_KEYS[venue])
    .filter((name) => !optionalEnv(name));
}

export function formatSpotBalances(balances: SpotBalances): string {
  return `ETH ${balances.eth.toFixed(8)} USDT ${balances.usdt.toFixed(2)}`;
}

export async function fetchBothSpotBalances(): Promise<BothSpotBalances> {
  const missing = missingSpotApiKeys();
  if (missing.length > 0) {
    throw new Error(`missing ${missing.join(", ")}`);
  }

  const includeBinance = isExchangeLive("binance");
  const includeIndodax = isExchangeLive("indodax");
  const [binance, indodax] = await Promise.all([
    includeBinance ? fetchBinanceSpotBalances() : Promise.resolve(EMPTY_SPOT),
    includeIndodax ? fetchIndodaxSpotBalances() : Promise.resolve(EMPTY_SPOT),
  ]);

  return { binance, indodax };
}

export async function logExchangeBalances(): Promise<void> {
  const included = includedLiveSpotVenues();
  if (included.length === 0) {
    return;
  }

  const missing = missingSpotApiKeys();
  if (missing.length > 0) {
    console.log(`[Balance] Skipped: missing ${missing.join(", ")}`);
    return;
  }

  const [binance, indodax] = await Promise.allSettled([
    isExchangeLive("binance")
      ? fetchBinanceSpotBalances()
      : Promise.resolve(EMPTY_SPOT),
    isExchangeLive("indodax")
      ? fetchIndodaxSpotBalances()
      : Promise.resolve(EMPTY_SPOT),
  ]);

  const parts: string[] = [];
  if (isExchangeLive("binance")) {
    parts.push(`Binance ${settledSpotLabel(binance)}`);
  }
  if (isExchangeLive("indodax")) {
    parts.push(`Indodax ${settledSpotLabel(indodax)}`);
  }

  console.log(`[Balance] ${parts.join(" | ")}`);
}

function settledSpotLabel(
  result: PromiseSettledResult<SpotBalances>,
): string {
  if (result.status === "fulfilled") {
    return formatSpotBalances(result.value);
  }
  return `error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
}
