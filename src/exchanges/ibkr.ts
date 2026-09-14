import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  IBKR_CLIENT_ID,
  IBKR_ENABLED,
  IBKR_HOST,
  IBKR_PORT,
  IBKR_PYTHON,
} from "../config/trading";

const LOG_PREFIX = "[IBKR]";
let child: ChildProcess | null = null;

function forward(stream: NodeJS.ReadableStream | null): void {
  if (!stream) {
    return;
  }

  stream.setEncoding("utf8");
  let leftover = "";
  stream.on("data", (chunk: string) => {
    leftover += chunk;
    const lines = leftover.split(/\r?\n/);
    leftover = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trimEnd();
      if (!text) {
        continue;
      }
      console.log(text.startsWith("[IBKR]") ? text : `${LOG_PREFIX} ${text}`);
    }
  });
}

/** Parked: index.ts no longer calls this until a weekday US session. */
export function startIbkrClient(): void {
  if (!IBKR_ENABLED) {
    console.log(`${LOG_PREFIX} Disabled (set IBKR_ENABLED=true)`);
    return;
  }

  const scriptPath = resolve(process.cwd(), "python", "ibkr_client.py");
  console.log(
    `${LOG_PREFIX} Starting official TWS client → ${IBKR_HOST}:${IBKR_PORT} clientId=${IBKR_CLIENT_ID}`,
  );

  child = spawn(IBKR_PYTHON, [scriptPath], {
    env: {
      ...process.env,
      IBKR_HOST,
      IBKR_PORT: String(IBKR_PORT),
      IBKR_CLIENT_ID: String(IBKR_CLIENT_ID),
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  forward(child.stdout);
  forward(child.stderr);

  child.on("error", (error) => {
    console.error(
      `${LOG_PREFIX} Failed to start ${IBKR_PYTHON}: ${error.message}. Install Python and: pip install -r requirements.txt`,
    );
    child = null;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`${LOG_PREFIX} Process stopped (${signal})`);
    } else if (code !== 0 && code !== null) {
      console.error(`${LOG_PREFIX} Process exited ${code}`);
    }
    child = null;
  });

  const stop = (): void => {
    if (!child || child.killed) {
      return;
    }
    child.kill();
  };

  process.on("exit", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
