export type ExchangeName = "binance" | "indodax";
export type OrderSide = "BUY" | "SELL";

export interface MarketOrderRequest {
  side: OrderSide;
  quantityEth: number;
  quoteAmountUsdt?: number;
  clientOrderId: string;
}

export interface PlacedOrder {
  exchange: ExchangeName;
  side: OrderSide;
  orderId: string;
  clientOrderId: string;
  status: string;
  executedQtyEth: number;
  executedQuoteUsdt: number;
}

export class OrderError extends Error {
  readonly exchange: ExchangeName;

  constructor(exchange: ExchangeName, message: string) {
    super(`[${exchange}] ${message}`);
    this.name = "OrderError";
    this.exchange = exchange;
  }
}

let inFlightExchange: ExchangeName | null = null;

export function isMarketOrderInFlight(): boolean {
  return inFlightExchange !== null;
}

/** Runs one market-order HTTP call at a time. Later calls are skipped until a response arrives. */
export async function withMarketOrderLock<T>(
  exchange: ExchangeName,
  run: () => Promise<T>,
): Promise<T> {
  if (inFlightExchange !== null) {
    throw new OrderError(
      exchange,
      `Skipping order: ${inFlightExchange} market order is still waiting for a response`,
    );
  }

  inFlightExchange = exchange;
  try {
    return await run();
  } finally {
    inFlightExchange = null;
  }
}

export function roundDown(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor + Number.EPSILON) / factor;
}

export function formatDecimal(value: number, decimals: number): string {
  return roundDown(value, decimals).toFixed(decimals);
}
