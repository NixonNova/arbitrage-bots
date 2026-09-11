import {
  INITIAL_BINANCE_ETH,
  INITIAL_BINANCE_USDT,
  INITIAL_INDODAX_ETH,
  INITIAL_INDODAX_USDT,
  MIN_BALANCE_PCT,
} from "../config/trading";
import { ArbitrageDirection } from "./progress";

export interface WalletBalances {
  binanceEth: number;
  binanceUsdt: number;
  indodaxEth: number;
  indodaxUsdt: number;
}

export interface TradeSettlement {
  direction: ArbitrageDirection;
  tradeSizeEth: number;
  buyAskPrice: number;
  sellBidPrice: number;
  buyTakerFee: number;
  sellTakerFee: number;
}

const BALANCE_LABELS: Record<keyof WalletBalances, string> = {
  binanceEth: "Binance ETH",
  binanceUsdt: "Binance USDT",
  indodaxEth: "Indodax ETH",
  indodaxUsdt: "Indodax USDT",
};

export class WalletTracker {
  private readonly initial: WalletBalances;
  private current: WalletBalances;
  private halted = false;
  private haltReason: string | null = null;

  constructor(initial: WalletBalances) {
    this.initial = { ...initial };
    this.current = { ...initial };
  }

  isHalted(): boolean {
    return this.halted;
  }

  getHaltReason(): string | null {
    return this.halted ? this.haltReason : null;
  }

  halt(reason: string): void {
    if (this.halted) {
      return;
    }

    this.halted = true;
    this.haltReason = reason;
    console.error(`[Halt] Trading halted: ${reason}`);
    console.error("[Halt] Stopping the bot so this error stays on screen. Restart after you review it.");
    process.exit(1);
  }

  getBalances(): WalletBalances {
    return { ...this.current };
  }

  canExecute(settlement: TradeSettlement): boolean {
    if (this.halted) {
      return false;
    }

    const buyCostUsdt =
      settlement.buyAskPrice *
      settlement.tradeSizeEth *
      (1 + settlement.buyTakerFee);
    const sellEth = settlement.tradeSizeEth;

    if (settlement.direction === "buy-binance-sell-indodax") {
      return (
        this.current.binanceUsdt >= buyCostUsdt &&
        this.current.indodaxEth >= sellEth
      );
    }

    return (
      this.current.indodaxUsdt >= buyCostUsdt &&
      this.current.binanceEth >= sellEth
    );
  }

  getAffordabilityReason(settlement: TradeSettlement): string | null {
    if (this.halted) {
      return `trading halted: ${this.haltReason ?? "unknown reason"}`;
    }

    const buyCostUsdt =
      settlement.buyAskPrice *
      settlement.tradeSizeEth *
      (1 + settlement.buyTakerFee);
    const sellEth = settlement.tradeSizeEth;

    if (settlement.direction === "buy-binance-sell-indodax") {
      if (this.current.binanceUsdt < buyCostUsdt) {
        return "insufficient Binance USDT";
      }
      if (this.current.indodaxEth < sellEth) {
        return "insufficient Indodax ETH";
      }
      return null;
    }

    if (this.current.indodaxUsdt < buyCostUsdt) {
      return "insufficient Indodax USDT";
    }
    if (this.current.binanceEth < sellEth) {
      return "insufficient Binance ETH";
    }

    return null;
  }

  applyTrade(settlement: TradeSettlement): void {
    const buyCostUsdt =
      settlement.buyAskPrice *
      settlement.tradeSizeEth *
      (1 + settlement.buyTakerFee);
    const sellProceedsUsdt =
      settlement.sellBidPrice *
      settlement.tradeSizeEth *
      (1 - settlement.sellTakerFee);
    const tradeEth = settlement.tradeSizeEth;

    if (settlement.direction === "buy-binance-sell-indodax") {
      this.current.binanceUsdt -= buyCostUsdt;
      this.current.binanceEth += tradeEth;
      this.current.indodaxEth -= tradeEth;
      this.current.indodaxUsdt += sellProceedsUsdt;
    } else {
      this.current.indodaxUsdt -= buyCostUsdt;
      this.current.indodaxEth += tradeEth;
      this.current.binanceEth -= tradeEth;
      this.current.binanceUsdt += sellProceedsUsdt;
    }

    this.checkAndHalt();
  }

  private checkAndHalt(): void {
    if (this.halted) {
      return;
    }

    for (const key of Object.keys(this.initial) as (keyof WalletBalances)[]) {
      const initialBalance = this.initial[key];
      if (initialBalance <= 0) {
        continue;
      }

      if (this.current[key] <= initialBalance * MIN_BALANCE_PCT) {
        this.halt(
          `${BALANCE_LABELS[key]} at ${((this.current[key] / initialBalance) * 100).toFixed(2)}% of initial (${this.current[key].toFixed(8)} remaining)`,
        );
        return;
      }
    }
  }

  formatBalances(): string {
    return [
      `Binance ETH ${this.current.binanceEth.toFixed(8)}`,
      `USDT ${this.current.binanceUsdt.toFixed(2)}`,
      `| Indodax ETH ${this.current.indodaxEth.toFixed(8)}`,
      `USDT ${this.current.indodaxUsdt.toFixed(2)}`,
    ].join(" ");
  }
}

export function createWalletTracker(): WalletTracker {
  return new WalletTracker({
    binanceEth: INITIAL_BINANCE_ETH,
    binanceUsdt: INITIAL_BINANCE_USDT,
    indodaxEth: INITIAL_INDODAX_ETH,
    indodaxUsdt: INITIAL_INDODAX_USDT,
  });
}
