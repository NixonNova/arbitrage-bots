import {
  INITIAL_BINANCE_BTC,
  INITIAL_BINANCE_USDT,
  INITIAL_INDODAX_BTC,
  INITIAL_INDODAX_USDT,
  MIN_BALANCE_PCT,
} from "../config/trading";
import { ArbitrageDirection } from "./progress";

export interface WalletBalances {
  binanceBtc: number;
  binanceUsdt: number;
  indodaxBtc: number;
  indodaxUsdt: number;
}

export interface TradeSettlement {
  direction: ArbitrageDirection;
  tradeSizeBtc: number;
  buyAskPrice: number;
  sellBidPrice: number;
  buyTakerFee: number;
  sellTakerFee: number;
}

const BALANCE_LABELS: Record<keyof WalletBalances, string> = {
  binanceBtc: "Binance BTC",
  binanceUsdt: "Binance USDT",
  indodaxBtc: "Indodax BTC",
  indodaxUsdt: "Indodax USDT",
};

export class WalletTracker {
  private readonly initial: WalletBalances;
  private current: WalletBalances;
  private halted = false;

  constructor(initial: WalletBalances) {
    this.initial = { ...initial };
    this.current = { ...initial };
  }

  isHalted(): boolean {
    return this.halted;
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
      settlement.tradeSizeBtc *
      (1 + settlement.buyTakerFee);
    const sellBtc = settlement.tradeSizeBtc;

    if (settlement.direction === "buy-binance-sell-indodax") {
      return (
        this.current.binanceUsdt >= buyCostUsdt &&
        this.current.indodaxBtc >= sellBtc
      );
    }

    return (
      this.current.indodaxUsdt >= buyCostUsdt &&
      this.current.binanceBtc >= sellBtc
    );
  }

  getAffordabilityReason(settlement: TradeSettlement): string | null {
    if (this.halted) {
      return "trading halted: balance below 5% threshold";
    }

    const buyCostUsdt =
      settlement.buyAskPrice *
      settlement.tradeSizeBtc *
      (1 + settlement.buyTakerFee);
    const sellBtc = settlement.tradeSizeBtc;

    if (settlement.direction === "buy-binance-sell-indodax") {
      if (this.current.binanceUsdt < buyCostUsdt) {
        return "insufficient Binance USDT";
      }
      if (this.current.indodaxBtc < sellBtc) {
        return "insufficient Indodax BTC";
      }
      return null;
    }

    if (this.current.indodaxUsdt < buyCostUsdt) {
      return "insufficient Indodax USDT";
    }
    if (this.current.binanceBtc < sellBtc) {
      return "insufficient Binance BTC";
    }

    return null;
  }

  applyTrade(settlement: TradeSettlement): void {
    const buyCostUsdt =
      settlement.buyAskPrice *
      settlement.tradeSizeBtc *
      (1 + settlement.buyTakerFee);
    const sellProceedsUsdt =
      settlement.sellBidPrice *
      settlement.tradeSizeBtc *
      (1 - settlement.sellTakerFee);
    const tradeBtc = settlement.tradeSizeBtc;

    if (settlement.direction === "buy-binance-sell-indodax") {
      this.current.binanceUsdt -= buyCostUsdt;
      this.current.binanceBtc += tradeBtc;
      this.current.indodaxBtc -= tradeBtc;
      this.current.indodaxUsdt += sellProceedsUsdt;
    } else {
      this.current.indodaxUsdt -= buyCostUsdt;
      this.current.indodaxBtc += tradeBtc;
      this.current.binanceBtc -= tradeBtc;
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
        this.halted = true;
        console.log(
          `[Wallet] Trading halted: ${BALANCE_LABELS[key]} at ${(this.current[key] / initialBalance * 100).toFixed(2)}% of initial (${this.current[key].toFixed(8)} remaining)`,
        );
        return;
      }
    }
  }

  formatBalances(): string {
    return [
      `Binance BTC ${this.current.binanceBtc.toFixed(8)}`,
      `USDT ${this.current.binanceUsdt.toFixed(2)}`,
      `| Indodax BTC ${this.current.indodaxBtc.toFixed(8)}`,
      `USDT ${this.current.indodaxUsdt.toFixed(2)}`,
    ].join(" ");
  }
}

export function createWalletTracker(): WalletTracker {
  return new WalletTracker({
    binanceBtc: INITIAL_BINANCE_BTC,
    binanceUsdt: INITIAL_BINANCE_USDT,
    indodaxBtc: INITIAL_INDODAX_BTC,
    indodaxUsdt: INITIAL_INDODAX_USDT,
  });
}
