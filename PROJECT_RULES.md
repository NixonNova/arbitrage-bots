# Project Rules

General rules and reference documentation for the arbitrage bot project.

## Exchanges

This bot operates across two exchanges. Always refer to the official API documentation when implementing exchange integrations.

### Exchange #1: Binance

- **Name:** Binance
- **API Documentation:** https://developers.binance.com/en/docs/introduction

### Exchange #2: Indodax

- **Name:** Indodax
- **API Documentation:** https://github.com/btcid/indodax-official-api-docs/tree/master

## Guidelines

- Use only official API endpoints and parameters documented in the links above.
- Keep exchange-specific logic isolated so each integration can be maintained independently.
- Never commit API keys, secrets, or credentials to the repository.
