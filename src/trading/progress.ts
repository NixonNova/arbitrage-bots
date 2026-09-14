import { TRADE_LIMIT_USD } from "../config/trading";
import type { ArbitrageDirection } from "./venues";

export type { ArbitrageDirection };

export interface ExecutedTrade {
  direction: ArbitrageDirection;
  profitUsdt: number;
  profitPct: number;
  tradeSizeEth: number;
  tradeNotionalUsd: number;
  timestamp: Date;
}

export class TradeProgressTracker {
  private trades: ExecutedTrade[] = [];

  record(trade: ExecutedTrade): void {
    this.trades.push(trade);
  }

  getTradeCount(): number {
    return this.trades.length;
  }

  getLastTradeAt(): Date | null {
    if (this.trades.length === 0) {
      return null;
    }
    return this.trades[this.trades.length - 1].timestamp;
  }

  getSummary(): string {
    if (this.trades.length === 0) {
      return "Progress: 0 trades";
    }

    const totalUsdt = this.trades.reduce((sum, trade) => sum + trade.profitUsdt, 0);
    const totalPct = this.trades.reduce((sum, trade) => sum + trade.profitPct, 0);
    const avgPct = totalPct / this.trades.length;

    const usdtLabel = `${totalUsdt >= 0 ? "+" : ""}${totalUsdt.toFixed(2)} USDT`;
    const totalPctLabel = `${totalPct >= 0 ? "+" : ""}${totalPct.toFixed(4)}%`;
    const avgPctLabel = `${avgPct >= 0 ? "+" : ""}${avgPct.toFixed(4)}%`;

    return `${this.trades.length} trades @$${TRADE_LIMIT_USD}, ${usdtLabel}, total ${totalPctLabel} avg ${avgPctLabel}`;
  }
}

export function createExecutedTrade(
  direction: ArbitrageDirection,
  profitPerEth: number,
  profitPct: number,
  tradeSizeEth: number,
  tradeNotionalUsd: number,
): ExecutedTrade {
  return {
    direction,
    profitUsdt: profitPerEth * tradeSizeEth,
    profitPct,
    tradeSizeEth,
    tradeNotionalUsd,
    timestamp: new Date(),
  };
}
