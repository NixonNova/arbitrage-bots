import { TRADE_LIMIT_USD } from "../config/trading";

export function getRequiredBtc(
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
  const requiredBtc = getRequiredBtc(buyAskPrice, tradeLimitUsd);

  if (requiredBtc <= 0) {
    return false;
  }

  return buyAskQty >= requiredBtc && sellBidQty >= requiredBtc;
}
