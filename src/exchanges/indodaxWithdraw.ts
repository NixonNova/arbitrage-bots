import { INDODAX_USDT_NETWORK } from "../config/market";
import { formatDecimal, OrderError } from "./orders";
import {
  ensureIndodaxTimeSynced,
  getIndodaxCredentials,
  indodaxTimestamp,
  signIndodaxBody,
} from "./indodaxTrade";

const INDODAX_TAPI_V2_URL = "https://api.indodax.com";
const USDT_DECIMALS = 8;

interface IndodaxWithdrawResponse {
  id?: string | number;
  amount?: string;
  msg?: string;
  code?: number;
}

export async function withdrawIndodaxUsdtBep20(
  amount: number,
  address: string,
  withdrawOrderId: string,
): Promise<{ id: string; amount: number }> {
  if (!(amount > 0)) {
    throw new OrderError("indodax", "USDT withdraw amount must be positive");
  }
  if (!address) {
    throw new OrderError("indodax", "Missing Indodax USDT destination address");
  }

  await ensureIndodaxTimeSynced();
  const { apiKey, apiSecret } = getIndodaxCredentials();
  const body = new URLSearchParams({
    coin: "USDT",
    network: INDODAX_USDT_NETWORK,
    address,
    amount: formatDecimal(amount, USDT_DECIMALS),
    withdrawOrderId,
    withdrawMethod: "address",
    timestamp: indodaxTimestamp(),
    recvWindow: "5000",
  }).toString();

  const response = await fetch(`${INDODAX_TAPI_V2_URL}/api/v2/capital/withdraw/apply`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-APIKEY": apiKey,
      Sign: signIndodaxBody(body, apiSecret),
    },
    body,
  });
  const payload = (await response.json()) as IndodaxWithdrawResponse;
  if (!response.ok || (typeof payload.code === "number" && payload.code !== 0) || payload.id == null) {
    throw new OrderError(
      "indodax",
      payload.msg ?? `HTTP ${response.status} withdrawing USDT on ${INDODAX_USDT_NETWORK}`,
    );
  }

  return { id: String(payload.id), amount };
}
