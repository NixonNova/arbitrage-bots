import {
  BINANCE_USDT_DEPOSIT_ADDRESS,
  INDODAX_USDT_DEPOSIT_ADDRESS,
  isExchangeLive,
  LIVE_TRADING,
  MAX_USDT_REBALANCES,
  REBALANCE_MAX_USDT,
  REBALANCE_MIN_USDT,
  REBALANCE_USDT_PCT,
} from "../config/trading";
import type { BothSpotBalances, SpotBalances } from "../exchanges/balances";
import { withdrawBinanceUsdtBep20 } from "../exchanges/binanceWithdraw";
import { withdrawIndodaxUsdtBep20 } from "../exchanges/indodaxWithdraw";
import { isMarketOrderInFlight, type ExchangeName } from "../exchanges/orders";
import { WalletTracker } from "./wallet";

export interface UsdtRebalancePlan {
  from: ExchangeName;
  to: ExchangeName;
  amount: number;
  targetBalance: number;
  binanceUsdt: number;
  indodaxUsdt: number;
}

let rebalanceInFlight = false;
let completedRebalances = 0;

function maskAddress(address: string): string {
  if (address.length <= 8) {
    return "(set)";
  }
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function remainingUsdtPct(current: number, initial: number): number {
  if (!(initial > 0)) {
    return 1;
  }
  return current / initial;
}

export function shouldRebalanceUsdt(
  live: BothSpotBalances,
  wallet: WalletTracker,
): boolean {
  const initial = wallet.getInitialBalances();
  return (
    remainingUsdtPct(live.binance.usdt, initial.binanceUsdt) <=
      REBALANCE_USDT_PCT ||
    remainingUsdtPct(live.indodax.usdt, initial.indodaxUsdt) <=
      REBALANCE_USDT_PCT
  );
}

function capRebalanceAmount(surplus: number): number {
  if (REBALANCE_MAX_USDT > 0 && surplus > REBALANCE_MAX_USDT) {
    return REBALANCE_MAX_USDT;
  }
  return surplus;
}

export function planUsdtRebalance(live: BothSpotBalances): UsdtRebalancePlan | null {
  const binanceUsdt = live.binance.usdt;
  const indodaxUsdt = live.indodax.usdt;
  const targetBalance = (binanceUsdt + indodaxUsdt) / 2;

  if (binanceUsdt > targetBalance && binanceUsdt - targetBalance >= REBALANCE_MIN_USDT) {
    return {
      from: "binance",
      to: "indodax",
      amount: capRebalanceAmount(binanceUsdt - targetBalance),
      targetBalance,
      binanceUsdt,
      indodaxUsdt,
    };
  }

  if (indodaxUsdt > targetBalance && indodaxUsdt - targetBalance >= REBALANCE_MIN_USDT) {
    return {
      from: "indodax",
      to: "binance",
      amount: capRebalanceAmount(indodaxUsdt - targetBalance),
      targetBalance,
      binanceUsdt,
      indodaxUsdt,
    };
  }

  return null;
}

function destinationAddress(to: ExchangeName): string {
  return to === "binance"
    ? BINANCE_USDT_DEPOSIT_ADDRESS
    : INDODAX_USDT_DEPOSIT_ADDRESS;
}

/** Log-only 25% trigger for Hyperliquid. No withdraw is sent. */
export function tryDummyHyperliquidRebalance(
  wallet: WalletTracker,
  live: SpotBalances,
): void {
  if (!isExchangeLive("hyperliquid") || wallet.isHalted()) {
    return;
  }

  const initial = wallet.getInitialBalances().hyperliquidUsdt;
  if (!(initial > 0)) {
    return;
  }

  const pct = remainingUsdtPct(live.usdt, initial);
  if (pct > REBALANCE_USDT_PCT) {
    return;
  }

  const target = (live.usdt + initial) / 2;
  const gap = Math.max(0, target - live.usdt);
  console.log(
    `[Rebalance] Hyperliquid USDC $${live.usdt.toFixed(2)} (${(pct * 100).toFixed(1)}% of initial) — dummy only, transfer not wired (gap ~$${gap.toFixed(2)})`,
  );
}

export async function tryRebalanceUsdt(
  wallet: WalletTracker,
  live: BothSpotBalances,
): Promise<void> {
  if (
    !isExchangeLive("binance") ||
    !isExchangeLive("indodax") ||
    wallet.isHalted() ||
    rebalanceInFlight ||
    isMarketOrderInFlight()
  ) {
    return;
  }

  if (!shouldRebalanceUsdt(live, wallet)) {
    return;
  }

  const plan = planUsdtRebalance(live);
  const initial = wallet.getInitialBalances();
  const binancePct = (remainingUsdtPct(live.binance.usdt, initial.binanceUsdt) * 100).toFixed(1);
  const indodaxPct = (remainingUsdtPct(live.indodax.usdt, initial.indodaxUsdt) * 100).toFixed(1);
  console.log(
    `[Rebalance] USDT trigger: Binance $${live.binance.usdt.toFixed(2)} (${binancePct}% of initial) | Indodax $${live.indodax.usdt.toFixed(2)} (${indodaxPct}% of initial)`,
  );

  if (!plan) {
    console.log(
      `[Rebalance] Skip: move would be below $${REBALANCE_MIN_USDT.toFixed(2)} (target $${((live.binance.usdt + live.indodax.usdt) / 2).toFixed(2)})`,
    );
    return;
  }

  const address = destinationAddress(plan.to);
  const uncapped =
    plan.from === "binance"
      ? plan.binanceUsdt - plan.targetBalance
      : plan.indodaxUsdt - plan.targetBalance;
  const capNote =
    REBALANCE_MAX_USDT > 0 && plan.amount < uncapped
      ? `, capped at $${REBALANCE_MAX_USDT.toFixed(2)} (full gap $${uncapped.toFixed(2)})`
      : REBALANCE_MAX_USDT > 0
        ? `, cap $${REBALANCE_MAX_USDT.toFixed(2)}`
        : ", no amount cap";
  console.log(
    `[Rebalance] Move $${plan.amount.toFixed(2)} USDT ${plan.from} → ${plan.to} (target $${plan.targetBalance.toFixed(2)} each, BEP-20${capNote})`,
  );

  if (!address) {
    const key =
      plan.to === "binance"
        ? "BINANCE_USDT_DEPOSIT_ADDRESS"
        : "INDODAX_USDT_DEPOSIT_ADDRESS";
    console.log(`[Rebalance] Skip: set ${key} in .env for the ${plan.to} deposit address`);
    return;
  }

  if (!LIVE_TRADING) {
    console.log(
      `[Rebalance] Simulation only (LIVE_TRADING is off) → ${maskAddress(address)}`,
    );
    return;
  }

  rebalanceInFlight = true;
  const withdrawOrderId = `usdt${Date.now().toString(36)}`.slice(0, 36);
  try {
    const result =
      plan.from === "binance"
        ? await withdrawBinanceUsdtBep20(plan.amount, address, withdrawOrderId)
        : await withdrawIndodaxUsdtBep20(plan.amount, address, withdrawOrderId);
    completedRebalances += 1;
    const limitLabel =
      MAX_USDT_REBALANCES > 0 ? String(MAX_USDT_REBALANCES) : "unlimited";
    console.log(
      `[Rebalance] ${plan.from} USDT withdraw ${result.id} $${plan.amount.toFixed(2)} → ${plan.to} ${maskAddress(address)} (${completedRebalances}/${limitLabel})`,
    );
    if (MAX_USDT_REBALANCES > 0 && completedRebalances >= MAX_USDT_REBALANCES) {
      wallet.halt(
        `USDT rebalance limit reached (${completedRebalances}/${MAX_USDT_REBALANCES})`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Rebalance] Withdraw failed: ${message}`);
  } finally {
    rebalanceInFlight = false;
  }
}
