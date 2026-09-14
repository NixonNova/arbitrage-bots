"""Official IBKR TWS API client (ibapi). Connection-only for now.

Parked until a weekday US session: src/index.ts no longer starts this process.
"""

from __future__ import annotations

import os
import sys

try:
    from ibapi.client import EClient
    from ibapi.wrapper import EWrapper
except ImportError:
    print(
        "[IBKR] Missing official package ibapi. Run: pip install -r requirements.txt",
        flush=True,
    )
    sys.exit(1)


def log(message: str) -> None:
    print(f"[IBKR] {message}", flush=True)


class IbkrClient(EWrapper, EClient):
    def __init__(self) -> None:
        EClient.__init__(self, self)
        self.next_order_id: int | None = None

    def nextValidId(self, orderId: int) -> None:
        self.next_order_id = orderId
        log(f"Connected to TWS/Gateway. nextValidId={orderId}")
        self.reqManagedAccts()

    def managedAccounts(self, accountsList: str) -> None:
        accounts = [item.strip() for item in accountsList.split(",") if item.strip()]
        masked = [f"…{account[-4:]}" if len(account) > 4 else account for account in accounts]
        log(f"Managed accounts: {len(accounts)} ({', '.join(masked)})")

    def error(
        self,
        reqId: int,
        errorCode: int,
        errorString: str,
        advancedOrderRejectJson: str = "",
    ) -> None:
        if errorCode in (2104, 2106, 2107, 2108, 2158):
            log(f"{errorString}")
            return
        log(f"error reqId={reqId} code={errorCode} {errorString}")

    def connectionClosed(self) -> None:
        log("Connection closed")


def main() -> None:
    host = os.environ.get("IBKR_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.environ.get("IBKR_PORT", "7497"))
    client_id = int(os.environ.get("IBKR_CLIENT_ID", "1"))

    log(f"Connecting to {host}:{port} clientId={client_id}")
    app = IbkrClient()
    app.connect(host, port, clientId=client_id)
    if not app.isConnected():
        log("Failed to connect. Is TWS or IB Gateway running with API sockets enabled?")
        sys.exit(1)

    try:
        app.run()
    except KeyboardInterrupt:
        log("Stopping")
    finally:
        if app.isConnected():
            app.disconnect()


if __name__ == "__main__":
    main()
