import { BINANCE_USDT_NETWORK } from "../config/market";
import { formatDecimal, OrderError } from "./orders";
import {
  binanceTimestamp,
  ensureBinanceTimeSynced,
  getBinanceCredentials,
  signBinanceQuery,
} from "./binanceTrade";

const BINANCE_SAPI_URL = "https://api.binance.com";
const USDT_DECIMALS = 8;

interface BinanceWithdrawResponse {
  id?: string;
  code?: number;
  msg?: string;
}

export async function withdrawBinanceUsdtBep20(
  amount: number,
  address: string,
  withdrawOrderId: string,
): Promise<{ id: string; amount: number }> {
  if (!(amount > 0)) {
    throw new OrderError("binance", "USDT withdraw amount must be positive");
  }
  if (!address) {
    throw new OrderError("binance", "Missing Binance USDT destination address");
  }

  await ensureBinanceTimeSynced();
  const { apiKey, apiSecret } = getBinanceCredentials();
  const params = new URLSearchParams({
    coin: "USDT",
    network: BINANCE_USDT_NETWORK,
    address,
    amount: formatDecimal(amount, USDT_DECIMALS),
    walletType: "0",
    withdrawOrderId,
    recvWindow: "5000",
    timestamp: binanceTimestamp(),
  });
  const query = params.toString();
  const signature = signBinanceQuery(query, apiSecret);
  const response = await fetch(
    `${BINANCE_SAPI_URL}/sapi/v1/capital/withdraw/apply?${query}&signature=${signature}`,
    {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": apiKey,
      },
    },
  );
  const payload = (await response.json()) as BinanceWithdrawResponse;
  if (!response.ok || payload.code !== undefined || !payload.id) {
    throw new OrderError(
      "binance",
      payload.msg ?? `HTTP ${response.status} withdrawing USDT on ${BINANCE_USDT_NETWORK}`,
    );
  }

  return { id: payload.id, amount };
}
