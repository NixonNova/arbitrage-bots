import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_UNPAIRED_PAIRS } from "../config/trading";

export const UNPAIRED_PAIR_LOG_FILE = "unpaired-pair-trade.txt";

const logPath = resolve(process.cwd(), UNPAIRED_PAIR_LOG_FILE);

let unpairedCount = 0;

export function getUnpairedPairCount(): number {
  return unpairedCount;
}

export function recordUnpairedPair(reason: string): boolean {
  unpairedCount += 1;
  const line = `[${new Date().toISOString()}] unpaired ${unpairedCount}/${MAX_UNPAIRED_PAIRS}: ${reason}`;

  console.error(`[Trade] CRITICAL: ${reason}`);
  console.error(
    `[Trade] Unpaired pair ${unpairedCount}/${MAX_UNPAIRED_PAIRS} logged to ${UNPAIRED_PAIR_LOG_FILE}`,
  );

  try {
    appendFileSync(logPath, `${line}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Trade] Failed to write ${UNPAIRED_PAIR_LOG_FILE}: ${message}`);
  }

  return unpairedCount >= MAX_UNPAIRED_PAIRS;
}
