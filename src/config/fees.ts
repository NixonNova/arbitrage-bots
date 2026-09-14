/**
 * Taker fees only. Arbitrage crosses the book (buy at ask, sell at bid),
 * so both legs are always charged as taker — never maker.
 *
 * Sources:
 * - Binance Regular User spot taker: 0.10%
 *   https://www.binance.com/en/fee/trading
 * - Indodax USDT buy taker all-in fee: 0.2222%
 *   https://help.indodax.com/hc/en-us/articles/55074962933401
 * - Indodax USDT sell taker all-in fee: 0.3248%
 *   https://blog.indodax.com/en_US/pmk-50-2025/
 * - Hyperliquid spot taker (tier 0 base): 0.070%
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
 * - Tokocrypto USDT/crypto all-in taker (buy and sell): 0.4044%
 *   https://support.tokocrypto.com/hc/en-us/articles/46562860238477-Transaction-Fee-Adjustment-in-Relation-to-Exchange-Migration
 *
 * Override via environment variables if your account tier differs.
 */
import "./env";

function parseFeeRate(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const BINANCE_TAKER_FEE = parseFeeRate(
  process.env.BINANCE_TAKER_FEE ??
    process.env.BINANCE_BUY_TAKER_FEE ??
    process.env.BINANCE_SELL_TAKER_FEE,
  0.001,
);

export const TAKER_FEES = {
  binance: BINANCE_TAKER_FEE,
  indodax: {
    buy: parseFeeRate(process.env.INDODAX_BUY_TAKER_FEE, 0.002925),
    sell: parseFeeRate(process.env.INDODAX_SELL_TAKER_FEE, 0.002925),
  },
  hyperliquid: parseFeeRate(process.env.HYPERLIQUID_TAKER_FEE, 0.0007),
  tokocrypto: parseFeeRate(process.env.TOKOCRYPTO_TAKER_FEE, 0.004044),
};
