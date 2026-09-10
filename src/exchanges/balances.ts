import { optionalEnv } from "../config/env";
import { fetchBinanceSpotBalances } from "./binanceTrade";
import { fetchIndodaxSpotBalances } from "./indodaxTrade";

export interface SpotBalances {
  eth: number;
  usdt: number;
}

export function formatSpotBalances(balances: SpotBalances): string {
  return `ETH ${balances.eth.toFixed(8)} USDT ${balances.usdt.toFixed(2)}`;
}

export async function logExchangeBalances(): Promise<void> {
  const missing = [
    "BINANCE_API_KEY",
    "BINANCE_API_SECRET",
    "INDODAX_API_KEY",
    "INDODAX_API_SECRET",
  ].filter((name) => !optionalEnv(name));

  if (missing.length > 0) {
    console.log(`[Balance] Skipped: missing ${missing.join(", ")}`);
    return;
  }

  const [binance, indodax] = await Promise.allSettled([
    fetchBinanceSpotBalances(),
    fetchIndodaxSpotBalances(),
  ]);

  const binanceLabel =
    binance.status === "fulfilled"
      ? formatSpotBalances(binance.value)
      : `error: ${binance.reason instanceof Error ? binance.reason.message : String(binance.reason)}`;
  const indodaxLabel =
    indodax.status === "fulfilled"
      ? formatSpotBalances(indodax.value)
      : `error: ${indodax.reason instanceof Error ? indodax.reason.message : String(indodax.reason)}`;

  console.log(`[Balance] Binance ${binanceLabel} | Indodax ${indodaxLabel}`);
}
