# Tasks — RiseX Perps Tokensets

Ordered implementation slices, derived from `docs/design.md`. Strict TDD is active: pure `lib/`
logic gets tests written alongside (not after) each task. Money-moving tasks (buy/sell/execute) may
not merge without adversarial review (see design.md's money-safety guarantees, carried over
unchanged).

**Verification correction (found post-task-12, while checking testnet/mainnet parameterization):**
every "`tsc --noEmit` clean" claim recorded in this file across tasks 1–12 was checking **zero
files**. The root `tsconfig.json` uses the standard Vite project-references split (`"files": []`
+ `"references"` to `tsconfig.app.json`/`tsconfig.node.json`); bare `tsc --noEmit` only checks the
root config's own `files`/`include` (empty) and silently exits 0 without `-b`. The real command —
matching `package.json`'s own `"build": "tsc -b && vite build"` — is `tsc -b --noEmit` or `npm run
build`. Running it for the first time surfaced 7 real (if runtime-harmless) type errors in three
test files, now fixed — see the note at the bottom of this file. Every prior task's test-count/
`vitest run` claims are still valid (vitest always ran the full suite correctly); only the
typecheck claims were false confidence.

## 0. Verification spike (blocking — do first, do not guess) — DONE

Findings from `developer.rise.trade` (Full API reference, `/v1` REST):

- [x] **API Wallet flow ≠ Hyperliquid's `approveAgent`.** It's `POST /v1/auth/register-signer`
      and requires **two** EIP-712 signatures, not one:
      1. **Account signature** (`RegisterSigner` struct, signed by the **master wallet**).
      2. **Signer signature** (`VerifySigner` struct, signed by the **new in-memory session key
         itself**), proving it consents to being registered.
      Both use the domain from `GET /v1/auth/eip712-domain`. This means `lib/agent.ts`'s port
      must, on generating the keypair, immediately self-sign a `VerifySigner` struct with it
      **before** prompting the master wallet — a step Hyperliquid's `approveAgent` doesn't have.
      **Correction (task 5): the exact struct fields recorded here from the docs prose were
      wrong.** The docs page summarized them as `RegisterSigner(signer, message, expiration,
      nonce)` / `VerifySigner(account, nonce)` — but reading `risex-client`'s actual source
      (`github.com/SmoothBot/risex-ts`, `src/signing/domain.ts`) during task 5 showed the real
      EIP-712 types are:
      `RegisterSigner(address account, address signer, string message, uint32 expiration, uint48 nonceAnchor, uint8 nonceBitmap)`
      and `VerifySigner(address account, uint48 nonceAnchor, uint8 nonceBitmap)` — no single
      `nonce` field at all; it's split into `nonceAnchor`/`nonceBitmap`, and `RegisterSigner`
      also signs `account`, which the doc prose omitted. Auth ops (register/revoke) use a
      **dedicated nonce convention**: `nonceAnchor = current anchor + 1`, `nonceBitmap = 0` —
      always a fresh anchor, not the account's current bitmap position (that convention is only
      for order/action permits, task 6). **This is now the third doc-prose value on this project
      that turned out wrong** (after the EIP-712 domain name — task 2's correction). Lesson
      applied project-wide: prefer live `curl` or reading actual SDK/contract source over
      doc-page summaries for anything hardcoded into signing code.
      **Provenance caveat**: `risex-client` is explicitly "unofficial, not production ready" per
      its own README — this is the best available evidence, not an official spec. Run one real
      `register-signer` call on testnet and confirm it succeeds before trusting this on mainnet.
- [x] **Order placement still needs a per-order EIP-712 signature** — not a bare session-key
      message. `POST /v1/orders/place` carries a `permit` object (`account`, `signer`,
      `nonce_anchor`, `nonce_bitmap_index`, `deadline`, `signature`) signed by the **registered
      session key** (no wallet popup, since it's an in-memory key — same UX as Hyperliquid, just a
      different payload). Order fields: `market_id`, `size_steps` (uint32), `price_ticks` (uint24,
      max 16777215), `side` (0/1), `order_type` (0=Market/1=Limit), `time_in_force`
      (0=GTC/1=GTT/2=FOK/**3=IOC**), `post_only`, `reduce_only`, `stp_mode`, optional
      `builder_id`/`builder_fee_bps` (see note below). IOC exists, so the equal-split
      marketable-limit-order pattern from the original project still applies almost unchanged —
      only the field names and tick/step units change.
- [x] **Nonces are bitmap-based**, not sequential: `nonce_anchor` (uint48) +
      `nonce_bitmap_index` (0-255), fetched from `GET /v1/nonce-state/{account}`. Needs a small
      "pick a free bitmap slot" helper; `risex-client` claims to handle this automatically —
      verify that claim in task 5/6 before relying on it for money-moving code.
- [x] **`market.config` fields confirmed** via `GET /v1/markets`: `step_size`, `step_price`,
      `min_order_size`, `max_leverage`, `maintenance_margin_factor`, `open_interest_limit`, plus
      live pricing (`mark_price`, `index_price`) and funding (`current_funding_rate`,
      `funding_rate_8h`, `next_funding_time`). Confirms task 4's sizing rewrite is a straight
      step/tick rounding job, no hidden decimals concept.
- [x] **Chain ids**: testnet `chain_id = 11155931` ("Rise Testnet"), mainnet `4153` (from
      `contracts/deployments`, task-0-adjacent research). `GET /v1/system/config` returns RPC
      URLs + contract addresses (Router, Auth, PerpsManager, OrdersManager, CollateralManager,
      FeeManager, MarketsConfig, USDC, Oracle, Stork oracle, Deposit, Multicall3, OperatorHub) but
      **not** the EIP-712 domain — that's the separate `/v1/auth/eip712-domain` call. Testnet
      domain confirmed: `name: "RiseXAuthorization"`, `version: "1"`, `chainId: 11155931`,
      `verifyingContract: 0xe465Cc9318B7b4b616F4604bFC1e4958C32dAb91`. **Mainnet domain values
      not yet confirmed — fetch live from mainnet `/v1/auth/eip712-domain` before writing any
      mainnet signing code, do not reuse the testnet contract address.**
- [x] **Testnet USDC funding is a faucet** (`POST /v1/account/deposit-usdc`, gas-sponsored,
      1000 USDC first-deposit for non-bot wallets). This is **testnet-only** — confirms a
      testnet-first validation pass (§ per the original project's policy) is both possible and
      free. **Mainnet funding path is a separate, real deposit/bridge flow — not yet researched,
      needed before any real airdrop-farming activity; add as its own task before task 8 goes live
      on mainnet.**
- [ ] Decide: integrate `risex-client` (community SDK) or the Full REST API directly. Given the
      permit-signing and bitmap-nonce complexity confirmed above, lean toward the Full API
      directly for the write layer (fewer unverified abstractions over money-moving signing);
      `risex-client` is still fine for the read layer. Revisit once task 5 is underway.

### New finding, not in original scope — surface to user before task 8

RiseX has a **points/epoch system** directly relevant to airdrop farming:
`GET /v1/points/current-epoch`, `GET /v1/points/wallet-points/{wallet}`,
`GET /v1/tiers` (tiers ordered by `min_total_points`). **The exact scoring mechanics (does volume,
open interest, or holding time earn points?) are not documented in the public reference** — only
the tier-threshold shape is. Worth checking the wallet-points response live (once trading starts)
or the app's own UI copy to see what's actually rewarded, since that should shape which of
buy/short/close (task 8) actually matters for the farming goal — no point optimizing for something
that doesn't score.

There's also a **builder/referral fee system** (`builder_id`, `builder_fee_bps` on every order,
`/v1/builders/*` endpoints) — orders can attribute a fee split to a "builder." Irrelevant to
farming directly, but worth leaving `builder_id` unset/default rather than guessing a value.

### Points mechanics confirmed (RISEx "Ignite" Season 1) — changes task 8's design

Source: RiseX's own blog (`blog.risechain.com/rise-points-season-1-ignite-everything-you-need-to-know`),
the only authoritative explanation found (public API docs don't cover this).

Scored factors: **(1)** "intentional, sophisticated trading" — the post explicitly states
**"mechanical or wash-style flow" scores lower**; **(2)** costs incurred (fees, slippage, negative
markouts); **(3)** maker + taker volume; **(4)** **size and duration of open positions** — holding
meaningful size over time is rewarded, not just turnover; **(5)** referrals (10% of referred
users' points). **The exact weighting formula is deliberately unpublished and changes weekly, to
resist gaming.**

**Note — informational only, not enforced by the app**: the app has no automated trading (per
task 8, every open/close is a manual user action, same as the reference project). This points
data is documented here purely so the user can make an informed manual decision about position
size/hold-time when actually trading — the app itself does not optimize, schedule, or nudge
toward any cadence.

## 1. Project scaffold — DONE

- [x] Init Vite + React 19 + TypeScript (strict) project at `risex-perps-tokensets/`; ported
      tsconfig/vitest config from the reference project (it has no ESLint config to port — verified
      directly, none exists there). `npm install`, `npx vitest run` (5/5 passing), and
      `npx vite build` all verified passing.
- [x] `package.json`: ported `react`, `viem`, `wagmi`, `@tanstack/react-query`, `zustand`, `vitest`,
      `@testing-library/react`, `jsdom` at matching major versions; added `risex-client` (real
      published package, confirmed via npm); dropped `@nktkas/hyperliquid`.
- [x] wagmi config (`src/lib/wagmi.ts`): RISE Chain definitions via viem `defineChain` — mainnet
      chain id `4153`, testnet chain id `11155931` ("Rise Testnet"), both confirmed in task 0.
      RPC URLs are explicit `.invalid`-TLD placeholders (not fabricated real-looking values) —
      **still TODO: confirm real RPC URLs from `GET /v1/system/config` before this is usable.**
      Mainnet EIP-712 domain also left unconfirmed on purpose (testnet domain is confirmed; mainnet
      is not — do not assume it mirrors testnet).

## 2. Environment config (`config/env.ts`) — DONE

- [x] Ported the single-network-switch pattern. All values are **live-verified**, not
      doc-copied: `apiUrl` (`https://api.testnet.rise.trade` / `https://api.rise.trade`,
      confirmed via `curl .../v1/system/config`), `wsUrl` (`wss://ws.testnet.rise.trade` /
      `wss://ws.risex.trade` — note mainnet WS is on a **different domain**, `risex.trade` not
      `rise.trade`, per developer.rise.trade's WS connection reference), and `eip712Domain` for
      **both** networks (confirmed via `curl .../v1/auth/eip712-domain`). `storageNamespace` has
      no `marketType` param.
- [x] Defaults to testnet (`resolveNetwork()`); mainnet requires an explicit
      `VITE_RISE_NETWORK=mainnet`. Visible network banner is UI work, deferred to task 9.
- **Correction found while doing this task**: the task-0 spike's recorded testnet EIP-712 domain
  (`name: "RiseXAuthorization"`, `verifyingContract: 0xe465...`) was **wrong** — an artifact of
  an earlier doc-page summarization, not the real API. The live `GET /v1/auth/eip712-domain`
  response is `name: "RISEx"`, `verifyingContract: 0x6DA86F486b5E6536358F5b122dBe184522CA0eE3`.
  Fixed in code and tests. **Lesson: prefer live `curl` over summarized doc fetches for anything
  that will be hardcoded into signing code.**
- Mainnet `eip712Domain` — previously flagged as the highest-risk unconfirmed value — is now
  **confirmed live**: `name: "RISEx"`, `chainId: 4153`,
  `verifyingContract: 0x0D919DAA3f12AE715744Eb648c00066c5DBd66f0`.

## 3. RiseX read layer (`lib/risex.ts` — InfoClient equivalent) — PARTIAL

- [x] `getMarkets()` implemented directly against the Full REST API (not `risex-client` — see
      below), fully live-verified (`curl .../v1/markets`), unit-tested against the real response
      shape (9/9 tests passing, `tsc --noEmit` clean). **Wire-format note confirmed**: every
      numeric-looking market field (`step_size`, `step_price`, `max_leverage`, prices, funding)
      is a **decimal string**, not a JSON number — matters for task 4's sizing module.
- [ ] `getOrderbook(marketId)` / `getPosition(marketId, account)` — **not implemented.** Every
      guessed endpoint shape for orderbook-levels (`market_id`/`id`/`market` query params, a
      `/id/{market_id}/` path form) returned 404, and the docs reference page for it also 404'd.
      Do not guess further — confirm the real shape (RiseX web app's network tab, or a verified
      `risex-client` call) when task 8/9 actually need it, rather than blocking here on it.
- **Decision**: read layer uses the Full REST API directly via a small `apiGet` helper, not
  `risex-client` — every shape implemented so far was verified live, and going direct avoids an
  extra unverified abstraction layer. `risex-client` remains a candidate specifically for the
  signing/write layer (task 5), where it claims to handle bitmap-nonce bookkeeping.

## 4. Sizing module (rewrite of `lib/orders.ts`'s rounding core) — DONE

- [x] `roundToStep(size, stepSize)` and `roundToTick(price, tickSize, roundUp)` implemented in
      `lib/sizing.ts`, unit-tested (17 tests) against both synthetic markets and the confirmed
      live `BTC/USDC` shape from task 3. Includes the same float-noise epsilon guard as the
      original (`0.58` must not truncate to `0.57`).
- [x] Ported `planBuy`'s policy as-is: equal-split allocation, leverage→margin math
      (`requiredMarginUsd = usdcTotal / leverage`), "never skip a leg" re-check after rounding,
      insufficient-funds guard checked against required margin (not raw total).
- **Adapted, not just renamed — the min-notional guard changed shape.** Hyperliquid has one flat
  `$10` minimum notional across every market. RiseX has no such flat USD floor; instead each
  market has its own `min_order_size` (a base-asset SIZE, confirmed in `GET /v1/markets`). So the
  per-leg guard now compares the **rounded size** directly against that market's own
  `minOrderSize`, instead of converting to a dollar notional against a global constant. The
  "never skip a leg, block and prompt a higher total instead" policy itself is unchanged.
- Verified: `npx vitest run` → 26/26 passing; `npx tsc --noEmit` clean.

## 5. Signing layer (`lib/agent.ts` port) — DONE (core), UI copy deferred to task 9

- [x] Ported the architecture verbatim: session-memory-only key (never persisted), `subscribe`/
      `getSnapshot` singleton for `useSyncExternalStore`, `isAgentApprovedFor` trust-boundary
      check (now also expiry-aware — RiseX sessions expire, HL's agent approval didn't have a
      signed expiration), in-flight de-dup keyed by master address, `clearAgent` (local-only,
      does not call RiseX's `revoke-signer` endpoint — same scope as the original).
- [x] Implemented RiseX's session-key registration (`approveAgent()` → `POST
      /v1/auth/register-signer`) per the corrected findings above: two EIP-712 signatures
      (master wallet's `RegisterSigner`, session key's self-signed `VerifySigner`), auth-specific
      nonce convention (`anchor+1`/`bitmap=0`). New shared `lib/api.ts` (`apiGet`/`apiPost`)
      factored out of `lib/risex.ts` for both the read and signing layers. New
      `getNonceState()` added to `lib/risex.ts`.
- [x] 12 unit tests (registration flow, auth-nonce-convention assertion, short-circuit on
      already-approved, concurrent-approval dedup, per-master key regeneration, failure leaves
      session unapproved, `clearAgent`, trust-boundary `getAgentAccount`). `npx vitest run` →
      39/39 passing project-wide; `tsc --noEmit` clean.
- [ ] **Deferred to task 9 (UI)**: the "trade-only, cannot withdraw" claim in the approval UI
      copy. Indirect evidence so far: `risex-client`'s full authenticated write surface (orders,
      cancel, leverage, margin mode, isolated margin, register/revoke-signer) has **no `withdraw`
      method** — but this isn't a confirmed guarantee (the community SDK may simply not
      implement one), so don't assert it in UI copy without checking further at task 9.

## 6. Order wire format + execution orchestration (`lib/execute.ts` port) — DONE (buy/short side)

New files: `lib/orderEncoding.ts`, `lib/exchange.ts`, `lib/execute.ts`; pulled `lib/lots.ts`
forward from task 7 (execute.ts depends on it). 63 new tests, 76/76 passing project-wide,
`tsc --noEmit` clean, `vite build` clean.

- **Architectural finding that changed the whole approach: RiseX has NO bulk/atomic order
  endpoint.** `POST /v1/orders/place` takes exactly one order, confirmed both in the API
  reference and in `risex-client`'s `ExchangeClient.placeOrder` (singular). So there is no
  Hyperliquid-style "batch throws, recover per-leg statuses from the error" pattern to port —
  `statusesFromOrderError()` has no RiseX equivalent because there's no batch call to throw.
  Instead, each tokenset leg is its own independent `placeOrder` call, placed concurrently
  (`Promise.allSettled`), each pre-assigned a distinct nonce slot (`advanceNonce` — bumps
  `current_bitmap_index` by the leg's index; `exchange.ts`'s existing rollover-at-207 logic
  handles the rest) so legs never collide or need a nonce round-trip each.
- [x] Order encoding (`lib/orderEncoding.ts`): the 88-bit order bit-packing + `keccak256`/ABI
  hash construction is security-critical arithmetic — a single bit-shift error would silently
  sign the wrong order. **Not reimplemented from a written description.** Ported line-for-line
  from `risex-client`'s `src/signing/encoder.ts` (read via `gh api repos/SmoothBot/risex-ts/...`),
  translated from `ethers` to `viem`. **Cross-checked, not just trusted**: ran the ORIGINAL
  `ethers`-based logic in a throwaway script (temporary `ethers` devDependency, removed after)
  to produce known hashes for fixed inputs, then asserted the viem port reproduces them
  byte-for-byte in `orderEncoding.test.ts`. Also fixed a real bug caught during this work: the
  first draft used Node's `Buffer` for base64-encoding signatures, which doesn't exist in a
  browser bundle — replaced with `btoa`.
- [x] Permit construction (`lib/exchange.ts`'s `buildPermit`): signs a `VerifyWitness` permit
  with the session key over the action hash. **Uses a DIFFERENT nonce convention than
  `lib/agent.ts`'s registration** — order/action permits reuse the account's CURRENT
  anchor/bitmap position (only rolling to a fresh anchor once bitmap index > 207), unlike
  registration's always-fresh `anchor+1`/`bitmap=0`. Signature is base64-encoded on the wire
  (confirmed from `risex-client`'s source — not hex, which the docs prose didn't specify either
  way). `target` for the permit is RiseX's Router contract address, added to `env.ts` as
  `routerAddress` (confirmed live via `GET /v1/system/config` for both networks).
- [x] Ported the money-safety control flow verbatim: invalid plan or nothing filled → throws
  before any order is placed; once any leg fills → never throws again (returns
  `partial`/`persisted` flags). `persisted: false` path verified with a dedicated test.
- [x] Leverage: `setLeverageForPlan` calls RiseX's leverage-update permit once per **unique
  market** in the plan before placing orders — unconditional now (no more spot/perp gate).
  **Dropped**: the original's `isolatedOnly`/cross-margin-per-asset grouping — RiseX's market
  config (confirmed shape, task 3/4) exposes no such per-asset constraint. Margin mode
  (cross/isolated) is a separate RiseX call (`updateMarginMode`, not yet wired) — left at the
  account's current setting; a UI decision for task 8/9, not folded into every buy.
- [x] Dropped the lot/market-type mismatch guard entirely (unreachable — perps-only).
- **New gap found and handled, not glossed over**: `POST /v1/orders/place`'s own response has
  **no fill-price field** (only `filled_quantity`/`filled_percent`/`message` — confirmed from
  the API reference). The real fill price (`avg_price`) only exists on
  `GET /v1/orders/by-id/{order_id}` (new `lib/risex.ts` function `getOrder` — implemented from
  `developer.rise.trade/reference/getorder.md`'s documented shape, but **not independently
  live-verified with a real order_id**, since that requires an actual funded, signed order).
  `execute.ts` calls `getOrder` as a follow-up after any fill. If that follow-up itself fails,
  the leg is **never zeroed out** (a real fill must never be recorded as if nothing happened) —
  instead it falls back to the submitted limit price (the conservative direction: a marketable
  order's real fill is never worse than its limit) and flags the leg `priceUnconfirmed: true`
  (surfaced as `partial: true`, and meant to be shown as an approximate-cost-basis warning in
  task 9's UI).
- **Remaining for task 8, not done here**: `executeSell` and its `planSell` (sizing-side)
  equivalent — closing positions needs its own sizing port (percentage-of-remaining, side-aware
  close pricing) that hasn't been written yet. Only the open/increase side (`executeBuy`/
  `executeShort`) is done.

## 7. Tokensets + lots + P&L — DONE

- [x] `lib/tokensets.ts` ported. One deliberate naming change beyond dropping `marketType`:
      `tokens: string[]` (spot symbols in the original) → `markets: string[]` (RiseX market ids)
      — this fork's baskets are perp markets, not spot token symbols. 12 tests passing.
- [x] `lib/lots.ts` ported (minus `marketType`), done during task 6 since `execute.ts` depends on
      it directly. `buildLegsFromStatuses()` → `buildLegsFromOutcomes()`: RiseX has no per-order
      status union to pair against (see task 6's "no bulk endpoint" finding) — it pairs plan legs
      with independent `OrderOutcome`s instead (role unchanged). Added a `priceUnconfirmed` flag
      not present in the original (see task 6). 14 tests passing.
- [x] `lib/pnl.ts` ported verbatim — confirmed while porting: **zero Hyperliquid-specific
      assumptions were hiding in it**, exactly as design.md predicted. Only change: the lookup
      key is `marketId` (this fork's `BuyLeg` field), not `token` (a spot symbol in the
      original). 13 tests passing, covering long/short P&L direction, unpriced-leg exclusion,
      dust filtering, mixed long+short aggregation, small-position/staleness guards.

Project-wide: 101/101 tests passing, `tsc --noEmit` clean.

## 8. Buy / Short / Close flows (manual, user-triggered — no automated position creation) — DONE

Same model as the reference project: the app is a manual trading tool. Every open/close is a
user click (`BuyForm`/`ShortForm`/quick-close control), never scheduled or automatic. No bot,
scheduler, or background job opens or closes positions on its own. (UI controls themselves are
task 9 — this task is the underlying logic.)

- [x] Buy (open/increase long): already delivered by task 6's `executeBuy` (equal-split, leverage
      set per market, min-size guard, IOC execution). No new work needed here.
- [x] Short (open/increase short): already delivered by task 6's `executeShort`, same
      money-safety ordering as buy.
- [x] Quick-close (25/50/100%, `reduceOnly`, side-aware): new this task. `lib/sell.ts`'s
      `planSell` (RiseX port of the reference's `sell.ts` — percentage-of-remaining sizing,
      side-aware close pricing: plain sell for a long, buy-to-cover for a short, min-size guard
      adapted to per-market `minOrderSize` same as `sizing.ts`'s buy side) + `lib/execute.ts`'s
      new `executeSell` (same independent-per-leg placement, nonce-advancing, and
      never-lose-a-real-fill patterns as `executeBuy`/`executeShort` — see task 6). Side mapping
      confirmed by test: closing a long submits `Side.Short` (plain sell); closing a short
      (buy-to-cover) submits `Side.Long`.
- 20 new tests (`sell.test.ts` 7 + `execute.test.ts`'s new `executeSell` describe block 6, on
  top of the 7 already there for buy/short). Project-wide: **114/114 tests passing**,
  `tsc --noEmit` clean, `vite build` clean.

## 9. UI — DONE

Delegated the component/hook mapping to an Explore sub-agent first (reading the reference
project's `App.tsx`, all components, all hooks, `app/marketType.tsx`) to get an accurate port
plan before writing anything — see that report's "MarketType strip checklist" for the full
blast radius, applied below.

- [x] New `lib/` support modules needed by the UI (not previously built): `lib/format.ts` (pure
      `Intl.NumberFormat` helpers), `lib/liquidity.ts` (spread/depth/volume-tier — pure, 10 tests),
      `lib/balances.ts` (`getAvailableFunds`, 2 tests).
- [x] **Resolved task 3's old gap while doing this**: reading `risex-client`'s `InfoClient` source
      directly revealed the REAL orderbook/position endpoints — `GET /v1/orderbook?market_id=&limit=`
      and `GET /v1/account/position?market_id=&account=` (query params, not the path-segment/
      `/v1/markets/orderbook-levels` shapes guessed and 404'd in task 3). Both confirmed live.
      Added `getOrderbook`, `getPosition`, `getBalance` to `lib/risex.ts` (8 tests total there now).
- [x] Hooks (`src/hooks/`): `useAgent` (near-verbatim port — builds a chain-agnostic `WalletClient`
      from the connector's EIP-1193 provider at approve-time), `useMarkets`, `useAvailableFunds`,
      `useTokensets`, `useLots`, `useBookLiquidity` (now viable thanks to the resolved orderbook
      endpoint) — all `marketType`-free per the strip checklist.
- [x] Components (`src/components/`): `WalletConnect`, `NetworkBanner` (verbatim, zero exchange
      logic), `AgentApproval` (copy deliberately hedges the "trade-only" claim per task 5's
      unconfirmed-withdraw-capability note), `LiquidityBadge`, `TokenLiquidityDetail`,
      `TokenPicker`, `SelectedBasket`, `LeverageSelector`, `TokensetList` (now mounts `BuyForm`
      AND `ShortForm` unconditionally for every tokenset — previously gated on
      `marketType==="perp"`), `BuyForm`, `ShortForm`, `SellForm`, `PortfolioDashboard` (deleted
      the dead `lot.marketType !== "perp"` guard around the leverage badge — `BuyRecord` has no
      such field in this fork).
- [x] `App.tsx` + `app/providers.tsx` composition (providers already had `MarketTypeProvider`
      dropped from task 1's scaffold). New `index.css` written to match this fork's actual
      component classnames (not a wholesale copy of the reference project's 1034-line stylesheet,
      which maps to a different, larger component set including `BtcChart`/`DataBackup` that
      weren't ported).
- [x] `app/marketType.tsx` and `MarketTypeTabs` — never created in this fork (nothing to delete).
- **Browser-verified, not just typechecked/built** (per the "test UI changes in a browser"
  requirement): started the Vite dev server, drove it headless via a temporary `playwright`
  install (removed after, like task 6's `ethers` cross-check) since `chromium-cli` wasn't
  available. Confirmed: (1) disconnected landing page renders with no console errors; (2)
  connecting a fake EIP-1193 provider (no real wallet extension in this environment) drives the
  app into the full connected UI, which fetches **real live RiseX testnet data** — the market
  list (BTC/USDC, ETH/USDC, etc. with real prices/volume/liquidity badges) rendered correctly;
  (3) selecting a market and naming a tokenset triggered `useBookLiquidity`'s real
  `GET /v1/orderbook` call and rendered actual spread/depth numbers. Did not attempt a real
  buy/short/sell (would require real EIP-712 signing, which the fake provider doesn't implement,
  and real funds) — that remains to be tried by the user with a real wallet.

Project-wide: **130/130 tests passing**, `tsc --noEmit` clean, `vite build` clean.

## 10. Testing — DONE

- [x] Unit tests for sizing, pricing, P&L, lot updates, fill parsing — all already written
      alongside each task per strict TDD (`sizing.test.ts`, `pnl.test.ts`, `lots.test.ts`,
      `orderEncoding.test.ts`, `liquidity.test.ts`, `balances.test.ts`). Nothing new needed here.
- [x] `execute.ts` orchestration tested against a mocked RiseX exchange client: partial-fill and
      nothing-filled scenarios were already covered (tasks 6/8); **leverage-set-failure was the
      one gap this task's checklist called out that wasn't yet covered** — added two tests:
      leverage failing aborts before any order is placed (money-safety: a failed pre-condition
      must not let funds move) and the leverage loop stops at the first failing market rather
      than continuing to the rest. Both passed against the existing implementation on the first
      run — confirming `setLeverageForPlan`'s sequential-`await`-with-no-catch structure already
      had this property, it just wasn't asserted by a test.

Project-wide: **132/132 tests passing**, `tsc --noEmit` clean. (A quantitative coverage report
was not generated — `@vitest/coverage-v8` isn't installed and adding it wasn't judged worth a new
dependency for this pass; the qualitative audit above covers every category task 10 named.)

## 11. Edge cases (do not skip) — DONE

- [x] **Partial fills / no atomicity**: already resolved as a byproduct of task 6's finding —
      RiseX has no bulk order endpoint at all, so there's no atomicity question to answer; each
      leg is its own independent call, and `buildLegsFromOutcomes`/`executeBuy`/`executeShort`/
      `executeSell` never drop a leg regardless of how it resolved. Nothing new needed.
- [x] **Insufficient/stale balance re-check**: already implemented — `BuyForm`/`ShortForm` call
      `refetch()` on `useAvailableFunds` immediately before `executeBuy`/`executeShort`, and
      `sizing.ts`'s `planBuy` guards `requiredMarginUsd` against that fresh value (task 4).
      Confirmed present, nothing new needed.
- [x] **Wallet switched/disconnected mid-flow**: already implemented — `useAgent`'s effect clears
      any session not bound to the newly-connected address, and `agent.ts`'s `approveAgent` has
      a "wallet changed during approval" guard that discards a stale in-flight result (task 5).
      Confirmed present, nothing new needed.
- [x] **API Wallet expiry/revocation detection and re-approval** — **the one real gap found**.
      `isAgentApprovedFor`'s expiry check (task 5) is only consulted at the trust boundary
      (`getAgentAccount`); nothing re-evaluated the clock on its own, so the reactive UI snapshot
      could keep showing "approved" past the signed `expiresAt` until some unrelated state
      change happened to re-publish. Added `lib/agent.ts`'s `expireIfStale(masterAddress)` (3 new
      tests — clears an expired session, leaves a valid one alone, ignores a different master)
      and wired it into `hooks/useAgent.ts` via a 30s polling `useEffect`, so the UI now falls
      back to the approval prompt on its own once a session goes stale.
      **Caught a flawed test while writing this**: the "does not clear a different master's
      session" test initially asserted `isAgentApprovedFor(MASTER)` stayed `true`, but that
      function checks expiry itself — so it returns `false` once the session is expired
      regardless of whether `expireIfStale` touched it, making the assertion meaningless either
      way. Fixed to assert on `getAgentSession() !== null` instead, which actually distinguishes
      "not cleared" from "cleared."
- [x] **Price-feed staleness guard on P&L display** — `pnl.ts`'s `isPriceStale` and
      `PortfolioDashboard`'s staleness banner already existed (task 9), but **`App.tsx` never
      wired real data into it** — it omitted the `pricesUpdatedAt`/`pricesError` props entirely,
      so `PortfolioDashboard` used its defaults (`pricesUpdatedAt = 0`), and `isPriceStale`'s own
      fail-safe rule (`updatedAt <= 0` counts as stale) meant the staleness warning would have
      shown **permanently**, even with fresh data. Fixed: `App.tsx` now destructures
      `dataUpdatedAt`/`isError` from `useMarkets()` (react-query provides both natively) and
      passes them through.

Project-wide: **135/135 tests passing**, `tsc --noEmit` clean.

## 12. Docs — DONE

- [x] `docs/security.md` rewritten: two-key model (wallet vs. session key), the two-signature
      registration flow, the active expiry-polling addition from task 11, the `VerifyWitness`
      order-signing model, and an honest "Known limitations" table that includes the
      `risex-client` provenance caveat and the still-unverified mainnet deposit path. Fixed a
      dangling cross-reference to a `trading-model.md` file that was never created in this fork
      (task 12 only scoped security.md + architecture.md) — pointed it at `tasks.md`/
      `lib/execute.ts` instead of leaving a dead link.
- [x] `docs/architecture.md` rewritten: same layer diagram shape as the reference project, module
      map updated for every new/renamed file (`lib/api.ts`, `lib/orderEncoding.ts`,
      `lib/exchange.ts`, `lib/liquidity.ts`, `lib/balances.ts`, `lib/format.ts`), the no-bulk-order
      finding, and an explicit "Perps-only: no MarketType dimension" section since that's the
      single biggest structural difference from the original.

This closes every task in this file. Project-wide: **135/135 tests passing**, `npm run build`
(the real `tsc -b && vite build`) clean, and the UI was browser-verified (not just built) in
task 9. (The `tsc --noEmit` claim above and throughout this file was checking zero files — see
the correction note at the top and the post-task-12 section below.)

## Review workload note

Tasks 5–6 (signing + order execution) are money-moving and touch the highest-risk unknowns
(task 0). Recommend running these as their own reviewable slice/PR, separate from scaffold (1–4)
and UI (9), so a signing-model mistake doesn't get buried in a large diff.

## Post-task-12: testnet/mainnet parameterization verification (user-requested)

Verified the app is correctly parameterized to run against either network via
`VITE_RISE_NETWORK`, and fixed a real typecheck-tooling gap discovered while doing so.

- **Parameterization confirmed live, not just by code review**: grepped the whole `src/` tree for
  every network-specific literal (chain ids `11155931`/`4153`, contract addresses, `rise.trade`/
  `risechain`/`riselabs` hosts) — they appear ONLY in `config/env.ts` and `lib/wagmi.ts` (plus
  their test files), confirming a single source of truth. Built the app explicitly with
  `VITE_RISE_NETWORK=testnet` and `=mainnet`, served each via `vite preview`, and drove both
  headless (temporary `playwright` install, removed after — same disposable-tool pattern as
  tasks 6/9). Confirmed: correct `NetworkBanner` text per build, **and** actual outgoing HTTP
  requests hit the correct host (`api.testnet.rise.trade` vs `api.rise.trade`) with zero console
  errors. Default (no env var set) still resolves to testnet, per `env.test.ts`.
- **Gap found**: `.env.example` was never created — the scaffold sub-agent (task 1) reported it
  was blocked by a Write-tool permission denial on `.env*` paths, and it stayed missing since.
  Confirmed the same denial still applies. **The user needs to create it manually**:
  ```
  VITE_RISE_NETWORK=testnet
  ```
- **Real bug found and fixed while verifying**: running the *actual* `npm run build` script (not
  my usual `npx tsc --noEmit` check) failed with 7 type errors, despite every prior task in this
  file claiming "`tsc --noEmit` clean." Root cause: `tsconfig.json` has `"files": []` and only
  `"references"` (the standard Vite project-references split) — bare `tsc --noEmit` (no `-b`)
  only checks the root config's own `files`/`include`, which is empty, and **silently exits 0
  having checked nothing** (confirmed via `tsc --noEmit --listFiles` producing zero output).
  Every "tsc clean" claim in tasks 1–12 was false confidence; the `vitest run` test-count claims
  were unaffected (vitest was never subject to this issue). The real errors, all in test files
  and harmless at runtime (JS ignores type annotations) but real static-type bugs: `fetchFn.mock.calls.find(([url]: [string]) => …)`-style destructuring used a tuple type (`[string]`,
  exactly one element) where the actual element type is `any[]` (`mock.calls` are variable-length)
  — fixed by using an array type (`string[]`) instead, in 4 places across `agent.test.ts`/
  `exchange.test.ts`; and two spots in `execute.test.ts` read `placeOrder.mock.calls` directly
  instead of `vi.mocked(placeOrder).mock.calls`, which only type-checks through the mock wrapper.
  Fixed all 7; `npx tsc -b --noEmit` and `npm run build` are now genuinely clean, and all 135
  tests still pass. **Going forward, verify this project with `npm run build` or
  `npx tsc -b --noEmit` — never bare `tsc --noEmit`.**
