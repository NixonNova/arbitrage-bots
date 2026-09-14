import { isExchangeActive, isExchangeLive, MIN_BALANCE_PCT } from "../config/trading";
import { parseDirection, VENUE_LABELS, type ArbitrageDirection, type VenueId } from "./venues";

export interface WalletBalances {
  binanceEth: number;
  binanceUsdt: number;
  indodaxEth: number;
  indodaxUsdt: number;
  hyperliquidEth: number;
  hyperliquidUsdt: number;
  tokocryptoEth: number;
  tokocryptoUsdt: number;
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
  hyperliquidEth: "Hyperliquid ETH",
  hyperliquidUsdt: "Hyperliquid USDC",
  tokocryptoEth: "Tokocrypto ETH",
  tokocryptoUsdt: "Tokocrypto USDT",
};

const LIVE_HALT_KEYS: (keyof WalletBalances)[] = [
  "binanceEth",
  "binanceUsdt",
  "indodaxEth",
  "indodaxUsdt",
  "hyperliquidEth",
  "hyperliquidUsdt",
];

const ETH_KEYS: Record<VenueId, keyof WalletBalances> = {
  binance: "binanceEth",
  indodax: "indodaxEth",
  hyperliquid: "hyperliquidEth",
  tokocrypto: "tokocryptoEth",
};

const USDT_KEYS: Record<VenueId, keyof WalletBalances> = {
  binance: "binanceUsdt",
  indodax: "indodaxUsdt",
  hyperliquid: "hyperliquidUsdt",
  tokocrypto: "tokocryptoUsdt",
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

  getInitialBalances(): WalletBalances {
    return { ...this.initial };
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

    const { buyVenue, sellVenue } = parseDirection(settlement.direction);
    return (
      this.current[USDT_KEYS[buyVenue]] >= buyCostUsdt &&
      this.current[ETH_KEYS[sellVenue]] >= sellEth
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

    const { buyVenue, sellVenue } = parseDirection(settlement.direction);
    if (this.current[USDT_KEYS[buyVenue]] < buyCostUsdt) {
      const quote = buyVenue === "hyperliquid" ? "USDC" : "USDT";
      return `insufficient ${VENUE_LABELS[buyVenue]} ${quote}`;
    }
    if (this.current[ETH_KEYS[sellVenue]] < sellEth) {
      return `insufficient ${VENUE_LABELS[sellVenue]} ETH`;
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

    const { buyVenue, sellVenue } = parseDirection(settlement.direction);
    this.current[USDT_KEYS[buyVenue]] -= buyCostUsdt;
    this.current[ETH_KEYS[buyVenue]] += tradeEth;
    this.current[ETH_KEYS[sellVenue]] -= tradeEth;
    this.current[USDT_KEYS[sellVenue]] += sellProceedsUsdt;

    this.checkAndHalt();
  }

  private checkAndHalt(): void {
    if (this.halted) {
      return;
    }

    for (const key of LIVE_HALT_KEYS) {
      if (key === "binanceEth" || key === "binanceUsdt") {
        if (!isExchangeLive("binance")) {
          continue;
        }
      }
      if (key === "indodaxEth" || key === "indodaxUsdt") {
        if (!isExchangeLive("indodax")) {
          continue;
        }
      }
      if (key === "hyperliquidEth" || key === "hyperliquidUsdt") {
        if (!isExchangeLive("hyperliquid")) {
          continue;
        }
      }
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
    const parts: string[] = [];
    if (isExchangeActive("binance")) {
      parts.push(
        `Binance ETH ${this.current.binanceEth.toFixed(8)} USDT ${this.current.binanceUsdt.toFixed(2)}`,
      );
    }
    if (isExchangeActive("indodax")) {
      parts.push(
        `Indodax ETH ${this.current.indodaxEth.toFixed(8)} USDT ${this.current.indodaxUsdt.toFixed(2)}`,
      );
    }
    if (isExchangeActive("hyperliquid")) {
      const tag = isExchangeLive("hyperliquid") ? "Hyperliquid" : "Hyperliquid (sim)";
      parts.push(
        `${tag} ETH ${this.current.hyperliquidEth.toFixed(8)} USDC ${this.current.hyperliquidUsdt.toFixed(2)}`,
      );
    }
    if (isExchangeActive("tokocrypto")) {
      parts.push(
        `Tokocrypto (sim) ETH ${this.current.tokocryptoEth.toFixed(8)} USDT ${this.current.tokocryptoUsdt.toFixed(2)}`,
      );
    }
    return parts.join(" | ");
  }
}

export function createWalletTracker(initial: WalletBalances): WalletTracker {
  return new WalletTracker(initial);
}
