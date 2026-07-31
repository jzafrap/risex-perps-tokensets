# RiseX Perps Tokensets

Web app to assemble, buy, hold, and sell **baskets of perpetual futures markets
("tokensets")** on [RiseX](https://rise.trade) (a fully on-chain perps exchange on RISE
Chain), using a browser wallet (Rabby / MetaMask) for authentication, with per-market and
per-lot P&L tracking. A perps-only fork of
[hyperliquid-altcoin-portfolio](https://github.com/jzafrap/hyperliquid-altcoin-portfolio).

> **Testnet-first.** The app defaults to RiseX **testnet**. Switching to mainnet is
> explicit (`VITE_RISE_NETWORK=mainnet`) and shown by an always-visible network banner.

## Live

| | |
|---|---|
| 🧪 **Testnet** | **[jzafrap.github.io/risex-perps-tokensets/testnet/](https://jzafrap.github.io/risex-perps-tokensets/testnet/)** — practice with testnet funds, start here |
| ⚠️ **Mainnet** | **[jzafrap.github.io/risex-perps-tokensets/mainnet/](https://jzafrap.github.io/risex-perps-tokensets/mainnet/)** — real funds, real trades |

Both are static builds redeployed automatically on every push to `main` (see
[`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml)); no backend,
no build-time secrets — your wallet's private key never leaves your wallet.

## Status

Implemented, tested (135+ unit/orchestration tests), and browser-verified:

- Environment switch (testnet-first) with a visible network banner
- **Perps only** — no spot dimension (RiseX has no spot markets live yet)
- Wallet connect (Rabby/MetaMask) — no keys stored
- Session-key ("API Wallet") signing: one two-signature approval, in-memory trade-only key,
  with active expiry detection
- Tokenset CRUD, persisted per network + wallet
- Market picker with liquidity indicators (24h volume tier, order-book spread/depth)
- Equal-split market **buy/short** at selectable leverage (min-size guard, IOC)
- Per-lot percentage **sell/cover** (25/50/100%; `reduceOnly`, side-aware) with a leverage
  badge per lot
- Live P&L dashboard (per market, per lot, per-tokenset aggregate) + hide small balances
- Edge-case guards: insufficient funds, price staleness, partial fills, session expiry

**Before trading real money**, read [`docs/security.md`](./docs/security.md)'s "Known
limitations" and "Before mainnet" sections — the signing logic was cross-checked
mathematically against the community `risex-client` SDK's source but has not yet been
validated against a real signed transaction.

## Documentation

| Doc | For |
|-----|-----|
| [Design](./docs/design.md) | Why this is a fork, and what was reused vs. rewritten from Hyperliquid. |
| [Tasks](./docs/tasks.md) | Full build history — every RiseX-specific decision and correction made along the way. |
| [Architecture](./docs/architecture.md) | Code layout and data flow. |
| [Security](./docs/security.md) | Key model, trust boundary, known limitations. |

## Stack

React 19 · Vite · TypeScript · wagmi + viem · RiseX Full REST API (`lib/api.ts`, no SDK
dependency) · TanStack Query · Vitest

## Getting started

```bash
npm install
cp .env.example .env   # defaults to testnet
npm run dev
```

Other scripts:

```bash
npm run typecheck   # tsc -b --noEmit
npm test            # vitest run
npm run build       # tsc -b && vite build
```

## Security posture

- The user's main private key is never requested, stored, or transmitted.
- Trading uses a RiseX session key ("API Wallet"): the main wallet signs one
  `RegisterSigner` message; a delegated, trade-only key (kept **only in session memory**,
  self-signing its own `VerifySigner` message to register) signs orders. No `withdraw`
  method exists in the confirmed API surface it's given access to. See
  [`docs/security.md`](./docs/security.md).
