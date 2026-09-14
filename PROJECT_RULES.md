# Project Rules

General rules and reference documentation for the arbitrage bot project.

## Exchanges

This bot operates across multiple exchanges. Always refer to the official API documentation when implementing exchange integrations.

### Exchange #1: Binance

- **Name:** Binance
- **API Documentation:** https://developers.binance.com/en/docs/introduction

### Exchange #2: Indodax

- **Name:** Indodax
- **API Documentation:** https://github.com/btcid/indodax-official-api-docs/tree/master

### Exchange #3: Interactive Brokers (IBKR)

- **Name:** Interactive Brokers
- **API Documentation:** https://www.interactivebrokers.com/campus/ibkr-api-page/twsapi-doc/
- Official client: TWS API Python (`ibapi`), via TWS or IB Gateway

### Exchange #4: Hyperliquid

- **Name:** Hyperliquid
- **API Documentation:** https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
- Info + spot coin IDs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- Spot metadata: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot
- WebSocket: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
- `l2Book` subscribe: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
- Heartbeat: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats
- Exchange (orders): https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
- Signing: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
- Nonces + API wallets: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
- Tick and lot size: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
- Asset IDs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
- Error responses: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses
- Official Python SDK (signing reference): https://github.com/hyperliquid-dex/hyperliquid-python-sdk

### Exchange #5: Tokocrypto

- **Name:** Tokocrypto
- **API Documentation:** https://www.tokocrypto.com/apidocs/#change-log

## Guidelines

- Use only official API endpoints and parameters documented in the links above.
- Keep exchange-specific logic isolated so each integration can be maintained independently.
- Never commit API keys, secrets, or credentials to the repository.
