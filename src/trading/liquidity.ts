import { TRADE_LIMIT_USD } from "../config/trading";

export function getRequiredEth(
  buyAskPrice: number,
  tradeLimitUsd = TRADE_LIMIT_USD,
): number {
  if (buyAskPrice <= 0) {
    return 0;
  }

  return tradeLimitUsd / buyAskPrice;
}

/** First-row notional: price × ETH qty (same as the UI USDT column). */
export function topOfBookNotional(price: number, qty: number): number {
  if (!(price > 0) || !(qty > 0)) {
    return 0;
  }

  return price * qty;
}

export function hasSufficientTopOfBookNotional(
  price: number,
  qty: number,
  tradeLimitUsd = TRADE_LIMIT_USD,
): boolean {
  return topOfBookNotional(price, qty) >= tradeLimitUsd;
}

/** Both first rows must cover $10. Never size down or walk to the next row. */
export function hasSufficientLiquidity(
  buyAskPrice: number,
  buyAskQty: number,
  sellBidPrice: number,
  sellBidQty: number,
  tradeLimitUsd = TRADE_LIMIT_USD,
): boolean {
  return (
    hasSufficientTopOfBookNotional(buyAskPrice, buyAskQty, tradeLimitUsd) &&
    hasSufficientTopOfBookNotional(sellBidPrice, sellBidQty, tradeLimitUsd)
  );
}

export function formatNotionalSkip(
  label: string,
  side: "ask" | "bid",
  price: number,
  qty: number,
  tradeLimitUsd = TRADE_LIMIT_USD,
): string {
  const notional = topOfBookNotional(price, qty);
  const qtyLabel = Number.isFinite(qty) ? qty.toFixed(8) : "0";
  const priceLabel = Number.isFinite(price) ? String(price) : "0";
  return `${label}: first ${side} $${notional.toFixed(2)} < $${tradeLimitUsd.toFixed(2)} (${qtyLabel} ETH @ ${priceLabel})`;
}
