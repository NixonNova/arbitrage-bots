import {
  ArbitrageDirection,
  createExecutedTrade,
  ExecutedTrade,
  TradeProgressTracker,
} from "./progress";
import { WalletTracker } from "./wallet";

const DIRECTION_LABELS: Record<ArbitrageDirection, string> = {
  "buy-binance-sell-indodax": "Buy Binance / Sell Indodax",
  "buy-indodax-sell-binance": "Buy Indodax / Sell Binance",
};

export interface TradeOpportunity {
  direction: ArbitrageDirection;
  profitPerBtc: number;
  profitPct: number;
  tradeSizeBtc: number;
  tradeNotionalUsd: number;
  buyAskPrice: number;
  sellBidPrice: number;
  buyTakerFee: number;
  sellTakerFee: number;
}

export function executeArbitrage(
  opportunity: TradeOpportunity,
  wallet: WalletTracker,
): ExecutedTrade | null {
  const settlement = {
    direction: opportunity.direction,
    tradeSizeBtc: opportunity.tradeSizeBtc,
    buyAskPrice: opportunity.buyAskPrice,
    sellBidPrice: opportunity.sellBidPrice,
    buyTakerFee: opportunity.buyTakerFee,
    sellTakerFee: opportunity.sellTakerFee,
  };

  if (!wallet.canExecute(settlement)) {
    return null;
  }

  const trade = createExecutedTrade(
    opportunity.direction,
    opportunity.profitPerBtc,
    opportunity.profitPct,
    opportunity.tradeSizeBtc,
    opportunity.tradeNotionalUsd,
  );

  wallet.applyTrade(settlement);

  console.log(
    `[Trade] Executing ${DIRECTION_LABELS[opportunity.direction]} | $${opportunity.tradeNotionalUsd.toFixed(2)} (${opportunity.tradeSizeBtc.toFixed(8)} BTC) | est. profit ${trade.profitUsdt.toFixed(4)} USDT (${opportunity.profitPct.toFixed(4)}%)`,
  );
  console.log(`[Wallet] ${wallet.formatBalances()}`);

  // TODO: place taker buy on source exchange and taker sell on destination exchange.

  return trade;
}

export function tryExecuteOpportunities(
  opportunities: TradeOpportunity[],
  progress: TradeProgressTracker,
  wallet: WalletTracker,
): string[] {
  if (wallet.isHalted()) {
    return [];
  }

  const executedLabels: string[] = [];

  for (const opportunity of opportunities) {
    if (wallet.isHalted()) {
      break;
    }

    const trade = executeArbitrage(opportunity, wallet);
    if (!trade) {
      continue;
    }

    progress.record(trade);
    executedLabels.push(DIRECTION_LABELS[opportunity.direction]);
  }

  return executedLabels;
}
