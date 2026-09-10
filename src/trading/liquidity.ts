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

export function hasSufficientLiquidity(
  buyAskPrice: number,
  buyAskQty: number,
  sellBidQty: number,
  tradeLimitUsd = TRADE_LIMIT_USD,
): boolean {
  const requiredEth = getRequiredEth(buyAskPrice, tradeLimitUsd);

  if (requiredEth <= 0) {
    return false;
  }

  return buyAskQty >= requiredEth && sellBidQty >= requiredEth;
}
