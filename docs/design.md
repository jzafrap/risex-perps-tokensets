# Design — RiseX Perps Tokensets (fork of hyperliquid-altcoin-portfolio)

## Scope

Fork of `C:\code\06.07.2026_hyperliquid_tokensets\hyperliquid-altcoin-portfolio`, retargeted from
Hyperliquid to **RiseX** (perps orderbook DEX on RISE Chain, chain id `4153` mainnet). **Perps only**
— no spot dimension. Goal: create tokensets (baskets of perp markets), open equal-split long/short
positions, close per-lot by percentage, track P&L — to generate real trading activity on RiseX ahead
of a possible airdrop.

RiseX access: user already has mainnet access (invite/access code resolved).

## Why a fork, not new-from-scratch

The reference project's architecture separates pure business logic (`lib/`) from the exchange SDK
and from UI. Verified against the actual source (not just docs) that most of `lib/` has zero
Hyperliquid coupling and ports close to verbatim; only the exchange-integration edge needs a rewrite.
See reuse map below.

## Reuse map

| File | Verdict | Notes |
|---|---|---|
| `lib/pnl.ts` | **Reuse verbatim** | Zero HL-specific code — pure math over `BuyRecord`. |
| `lib/lots.ts` | **Reuse, minus `marketType`** | `BuyLeg`/`BuyRecord`/`applySellFills`/persistence pattern all portable. `buildLegsFromStatuses()` keeps its role, input shape changes to RiseX's fill/ack schema. |
| `lib/tokensets.ts` | **Reuse, minus `marketType`** | Pure CRUD + persistence, no HL coupling. |
| `lib/execute.ts` | **Reuse the control flow** | Plan→guard→sign→place→recover-partial-fills→record pattern, leverage-before-open pattern, and money-safety guarantees all carry over. Rewrite: `placeOrders()` call shape, `TradingClient` type, `statusesFromOrderError()`'s error-path parsing (HL SDK-specific), leverage-set call. `marketType`-gated branches become unconditional. |
| `lib/orders.ts` / `lib/sell.ts` | **Reuse the math, rewrite the wire format** | Equal-split allocation, min-notional guard, "never skip a leg" policy, percentage-of-remaining sell sizing, side-aware close pricing — all portable. Full rewrite: `roundSize` (decimals) → `roundToStep` (RiseX integer step/tick sizing per `market.config.step_size`/`step_price`), `marketablePrice`'s sig-fig/decimals rule → tick-rounding, `OrderObject` HL wire shape → RiseX order shape. |
| `lib/agent.ts` | **Reuse the architecture, rewrite the approval call** | Session-memory-only delegated key, `useSyncExternalStore` singleton, trust-boundary check (`isAgentApprovedFor`) — this is exactly the "API Wallet" pattern RiseX also uses. Rewrite: `approveAgent()`'s HL L1-action call → RiseX's API Wallet creation flow (mechanism TBD, see Open questions). |
| `lib/hyperliquid.ts` → `lib/risex.ts` | **Full rewrite** | `InfoClient`/`ExchangeClient`/`HttpTransport` are HL SDK-specific. New client wraps `risex-client` (community TS SDK: `InfoClient`/`ExchangeClient`/`WebSocketClient`, mirrors the same split) or the Full REST API directly if the SDK proves insufficient for production (docs explicitly flag it as unofficial). |
| `config/env.ts` | **Reuse the pattern, replace the values** | Single-network-switch pattern stays. Replace: `apiUrl`/`wsUrl` → RiseX REST/WS base URLs (developer.rise.trade), `signatureChainId` → RISE Chain id (`4153` mainnet; testnet id to confirm), `webAppUrl` → rise.trade. `storageNamespace` drops the `marketType` param. |
| `package.json` | **Reuse almost entirely** | `react`, `viem`, `wagmi`, `@tanstack/react-query`, `zustand`, `vitest`, `@testing-library/react` all stay (RISE Chain is EVM-compatible — add its chain definition to wagmi config). Remove `@nktkas/hyperliquid`; add `risex-client`. |
| `docs/security.md` | **Reuse the structure, rewrite the content** | Two-key trust model writeup stays as a doc pattern; HL-specific chain ids / approval mechanics get replaced once the API Wallet flow is confirmed. |

## MarketType removal (perps-only simplification)

Strip the `spot | perp` dimension entirely — it currently threads through `markets.ts`, `sell.ts`
(`reduceOnly` conditional → always `true`), `lots.ts`, `tokensets.ts`, `env.ts`
(`storageNamespace`), and `execute.ts` (leverage-gating conditional → unconditional, lot/market-type
mismatch guard → removable, no longer reachable). Net effect: several spot-vs-perp branches collapse
into single unconditional perp paths.

## New integration layer (the actual new work)

1. **`lib/risex.ts`** — client factory analogous to `lib/hyperliquid.ts`: read client (`InfoClient`
   equivalent: markets, orderbook, positions) + signer-bound write client (`ExchangeClient`
   equivalent: `marketBuy`, `closePosition`, leverage/margin-mode calls).
2. **Sizing rewrite** — `roundToStep(size, step_size)` / tick-rounding for price, replacing HL's
   decimals+sig-figs rule. Needs the exact `market.config` shape confirmed from a live markets-list
   call before implementation (not guessed).
3. **API Wallet signing flow** — replaces `approveAgent`. Mechanism (EIP-712 typed action vs. plain
   tx vs. RISE Chain contract call) must be confirmed against the Full API reference
   (developer.rise.trade) or by inspecting the RiseX web app's actual request during task
   implementation — this is the highest-risk unknown in the fork.
4. **wagmi chain config** — add a RISE Chain definition (chain id `4153` mainnet; testnet id to
   confirm) so wallet connection targets the right network.

## Open questions to resolve during tasks/apply (do not guess — verify against developer.rise.trade or live calls)

- Exact API Wallet creation flow and its signing domain/chain id.
- Exact order-placement request/response schema (`marketBuy`/`closePosition` args, nonce scheme —
  docs mention "bitmap nonces" and nanosecond timestamps, not yet confirmed field-by-field).
- Exact `market.config` fields for step/tick conversion.
- Whether `risex-client` (unofficial community SDK) is production-viable, or whether to integrate
  the Full REST API directly (docs explicitly recommend the latter for production).
- Testnet chain id / endpoints, for a testnet-first validation pass mirroring the original project's
  §4.1 policy.

## Testing strategy (unchanged)

Pure `lib/` logic unit-tested (sizing, pricing, P&L, lot updates, fill parsing); `execute.ts`
orchestration tested against a mocked RiseX client. Strict TDD mode is active for this project.

## Non-goals

Spot trading (RiseX docs say "coming soon"; a `SpotManager` contract is deployed on mainnet but not
yet exposed — out of scope until RiseX ships it).
