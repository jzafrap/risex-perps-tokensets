# Architecture

How the app is organized and how data flows. Same shape as the reference project it forks from:
a **serverless and client-only** React SPA that talks directly to RiseX and persists bookkeeping
in the browser — see [`docs/design.md`](./design.md) for the reuse/rewrite decisions behind this.

## Tech stack

| Concern | Choice |
|---------|--------|
| UI | React 19 + Vite 6 + TypeScript (strict) |
| Wallet | wagmi + viem (injected connector: Rabby / MetaMask) |
| RiseX access | Full REST API directly (`fetch`-based, `lib/api.ts`) — not the unofficial `risex-client` SDK; see [`docs/design.md`](./design.md) and `docs/tasks.md` tasks 3/6 for why |
| Server/chain state | TanStack Query |
| Persistence | `localStorage`, scoped by `{network}:{wallet}` |
| Tests | Vitest + Testing Library + jsdom |

## Layers

```
components/  ── React UI (presentation)
     │  hooks/  ── React Query + reactive state (useMarkets, useAgent, useLots, …)
     ▼
lib/         ── pure logic + IO (sizing, sell, execute, lots, pnl, agent, exchange, …)
     ▼
lib/api.ts (fetch) ──► RiseX REST API
```

The **pure logic** in `lib/` (sizing, pricing, P&L, lot updates) has no React or network
dependencies, which is why it is unit-tested directly (130+ tests, see `docs/tasks.md`).

## Module map

### Config
- `config/env.ts` — the single network switch. Every value (API/WS URLs, EIP-712 domain per
  network, router contract address, chain ids) was confirmed with a **live request**, not copied
  from documentation prose — see `docs/tasks.md` tasks 2 and 6 for the corrections that discipline
  caught along the way.

### RiseX access
- `lib/api.ts` — shared `apiGet`/`apiPost` fetch helpers with RiseX's response-envelope/error
  unwrapping, used by both the read and signing layers.
- `lib/risex.ts` — read layer: `getMarkets`, `getNonceState`, `getOrder`, `getOrderbook`,
  `getPosition`, `getBalance`. All confirmed live; the orderbook/position endpoint paths were
  found by reading `risex-client`'s SDK source directly after doc-guessed paths 404'd (task 9).
- `lib/liquidity.ts` — pure spread/depth/volume-tier helpers over an `Orderbook`.
- `lib/balances.ts` — available margin (USDC) for opening/increasing positions.
- `lib/format.ts` — pure display-formatting helpers (no exchange logic).

### Trading (money path)
- `lib/sizing.ts` — buy-side math: equal split, `roundToStep`/`roundToTick` (RiseX's integer
  tick/step model, not Hyperliquid's decimals), the per-market `minOrderSize` guard (replacing
  Hyperliquid's flat $10 minimum — RiseX has no such flat floor), leverage→margin math.
- `lib/sell.ts` — close-side math: percentage-of-remaining sizing, side-aware close pricing (plain
  sell for a long, buy-to-cover for a short), the same per-market minimum-size guard.
- `lib/orderEncoding.ts` — the order/leverage action-hash bit-packing and ABI encoding that feeds
  a signed permit. Ported from `risex-client`'s source and cross-checked byte-for-byte against
  the original `ethers` implementation (task 6) — not reimplemented from a written description,
  since a subtle error here would silently sign the wrong order.
- `lib/exchange.ts` — builds and signs `VerifyWitness` permits (order/leverage nonce convention:
  reuse the account's current bitmap position, roll to a fresh anchor only once exhausted), and
  calls `placeOrder`/`updateLeverage`.
- `lib/execute.ts` — `executeBuy`/`executeShort`/`executeSell` orchestration and money-safety
  ordering. Places every leg as its own independent order — **RiseX has no bulk/atomic order
  endpoint**, confirmed in task 6, which is why there's no Hyperliquid-style "recover fills from a
  thrown batch error" step here.
- `lib/lots.ts` — `BuyRecord`/`BuyLeg` model, fill-outcome parsing, `applySellFills`, persistence.
- `lib/tokensets.ts` — tokenset definitions + persistence (baskets of RiseX market ids).

### Signing
- `lib/agent.ts` — the session-key ("API Wallet") session: in-memory key, reactive store,
  registration (two EIP-712 signatures — see [Security](./security.md)), and active expiry
  polling so the UI doesn't keep showing "approved" past the signed expiration.

### Hooks
`useMarkets`, `useBookLiquidity`, `useAvailableFunds`, `useTokensets`, `useLots`, `useAgent` —
bridge `lib/` to React with caching and reactivity. No `marketType` dimension anywhere (see
below).

### Components
`WalletConnect`, `NetworkBanner`, `AgentApproval`, `TokenPicker`, `LiquidityBadge`,
`TokenLiquidityDetail`, `SelectedBasket`, `TokensetList`, `BuyForm`, `ShortForm`, `SellForm`,
`LeverageSelector`, `PortfolioDashboard`, plus `App.tsx` and `app/providers.tsx` (Wagmi + Query
providers).

## Data flow: a buy

```
BuyForm (amount)
  └─ useAvailableFunds.refetch()     # fresh margin balance
  └─ executeBuy(...)                 # lib/execute
       ├─ planBuy(...)               # lib/sizing — size/guard
       ├─ getAgentAccount()          # lib/agent — trust boundary
       ├─ placeOrder(...) × N legs   # lib/exchange — one independent call per leg
       ├─ getOrder(...)              # lib/risex — fetch confirmed fill price
       ├─ buildLegsFromOutcomes()    # lib/lots — parse fills, never drop a leg
       └─ saveLots(addLot(...))      # localStorage
  └─ refreshLots()                   # useLots re-reads → PortfolioDashboard updates
```

## Perps-only: no MarketType dimension

Unlike the reference project (which supports both spot and perp markets via a `MarketType`
context/tabs), this fork is **perps-only** — RiseX itself has no spot markets live yet. There is
no `marketType` parameter or context anywhere in this codebase: not in `config/env.ts`'s
`storageNamespace`, not in `lib/tokensets.ts`/`lib/lots.ts`'s persistence keys, not threaded
through any component or hook. See [`docs/design.md`](./design.md) for the full removal
rationale.

## Persistence keys

```
risex-tokensets:{network}:{wallet}:tokensets   # tokenset definitions
risex-tokensets:{network}:{wallet}:lots        # buy lots
```

The session key is **never** persisted (memory only).

## Testing strategy

Pure `lib/` logic is unit-tested (sizing, pricing, P&L, lot updates, fill parsing, order
encoding, liquidity, balances — 130+ tests). Orchestration (`executeBuy`/`executeShort`/
`executeSell`) is tested against a mocked exchange client, including money-safety edge cases
(nothing filled, partial fills, leverage-set failure, fill-price-lookup failure). UI was also
browser-verified with a headless Chromium session against a simulated wallet, not just built —
see `docs/tasks.md` task 9.

## Next step

[Security](./security.md) for the signing model, or [`docs/tasks.md`](./tasks.md) for the full
build history and every RiseX-specific decision this fork made along the way.
