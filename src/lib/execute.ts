import type { Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { getAgentAccount } from "./agent";
import { placeOrder, updateLeverage as apiUpdateLeverage } from "./exchange";
import {
  addLot,
  anyLegFilled,
  applySellFills,
  buildLegsFromOutcomes,
  loadLots,
  makeBuyRecord,
  replaceLot,
  saveLots,
  type BuyRecord,
  type OrderOutcome,
  type SellFill,
} from "./lots";
import { OrderType, Side, StpMode, TimeInForce, type OrderParams } from "./orderEncoding";
import { getNonceState, getOrder, type NonceState } from "./risex";
import { planSell, type SellPlan } from "./sell";
import { planBuy, type BuyPlan, type SizingMarketInput } from "./sizing";

/**
 * Execution orchestration — RiseX port of the reference project's
 * `lib/execute.ts` (docs/design.md, docs/tasks.md task 6).
 *
 * Ported verbatim: the money-safety ordering (invalid plan or nothing filled
 * → throw before anything executes; once any leg fills → never throw again,
 * report via `partial`/`persisted` flags instead), and per-asset leverage
 * being set before opening (now unconditional — no more spot/perp gate, and
 * no `isolatedOnly`/cross-margin-per-asset grouping: RiseX's market config
 * exposes no such constraint, so leverage is just set once per unique market
 * in the plan; margin mode (cross/isolated) is a separate, not-yet-wired
 * concern for task 8/9's UI, left at the account's current setting).
 *
 * Rewritten (RiseX has no bulk/atomic order endpoint — confirmed, see
 * `lib/lots.ts`'s `OrderOutcome` doc comment): each leg is placed as its own
 * independent `placeOrder` call. There is no "recover fills from a thrown
 * batch error" step because there is no batch call to throw. Legs are placed
 * concurrently, each with a distinct, pre-advanced nonce slot (see
 * `advanceNonce`) so they never collide or need a network round-trip each.
 */

export interface FailedLeg {
  marketId: string;
  symbol: string;
  error: string;
}

export interface ExecuteBuyArgs {
  masterAddress: Address;
  tokensetId: string;
  tokensetName: string;
  /** Resolved markets for the tokenset's tokens, in basket order. */
  markets: SizingMarketInput[];
  usdcTotal: number;
  slippage?: number;
  /** Current available funds (margin) — re-checked here. */
  availableUsdc?: number;
  /** Leverage (per asset's maxLeverage); defaults to 1. */
  leverage?: number;
}

export interface ExecuteBuyResult {
  plan: BuyPlan;
  record: BuyRecord;
  /** True if some legs filled and others did not, or a leg under-filled. */
  partial: boolean;
  /** False if the order filled but the lot could not be persisted. */
  persisted: boolean;
  /** Legs that did not buy, with reasons — surfaced as a warning. */
  failed: FailedLeg[];
}

/** Stable-ish unique id, resilient to environments without crypto.randomUUID. */
function safeId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (uuid) return uuid.call(globalThis.crypto);
  return `lot-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** Advance a nonce-state snapshot by `n` bitmap slots so concurrently-placed
 * legs each get a distinct nonce without a network round-trip or collision.
 * `exchange.ts`'s `buildPermit` independently applies the anchor-rollover
 * rule (bitmap > 207) to each advanced slot. */
function advanceNonce(nonce: NonceState, by: number): NonceState {
  return { nonce_anchor: nonce.nonce_anchor, current_bitmap_index: nonce.current_bitmap_index + by };
}

/** RiseX rate-limits `/v1/account/leverage` to 1 request/second (confirmed
 * live: "rate limited: 1 request per second for update_leverage" when a
 * tokenset with 2+ markets set leverage back-to-back). Not documented
 * anywhere in advance — found the same way as the two encoding bugs, by a
 * real error during live testing. This margin (1100ms) is a guess at a safe
 * gap, not a confirmed exact window; tighten only if verified. */
const LEVERAGE_CALL_MIN_GAP_MS = 1100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Set leverage for every unique market in the plan before opening. Shared by
 * buy and short — leverage is a risk setting keyed by market, not direction.
 * Calls are throttled sequentially (see `LEVERAGE_CALL_MIN_GAP_MS`) since
 * RiseX rate-limits this specific action tighter than its general REST limit. */
async function setLeverageForPlan(
  plan: BuyPlan,
  leverage: number,
  signerAccount: PrivateKeyAccount,
  masterAddress: Address,
): Promise<void> {
  const uniqueMarketIds = [...new Set(plan.legs.map((l) => l.marketId))];
  for (let i = 0; i < uniqueMarketIds.length; i++) {
    if (i > 0) await sleep(LEVERAGE_CALL_MIN_GAP_MS);
    await apiUpdateLeverage(Number(uniqueMarketIds[i]), leverage, signerAccount, masterAddress);
  }
}

/** Place every leg's order independently (no batch endpoint exists) and
 * resolve each into an `OrderOutcome`, fetching the confirmed fill price via
 * `getOrder` for anything that filled (`placeOrder`'s own response has no
 * price field — see `lib/risex.ts`'s `getOrder` doc comment). */
async function placeLegOrders(
  plan: BuyPlan,
  side: "long" | "short",
  signerAccount: PrivateKeyAccount,
  masterAddress: Address,
): Promise<OrderOutcome[]> {
  const baseNonce = await getNonceState(masterAddress);

  const settled = await Promise.allSettled(
    plan.legs.map((leg, i) => {
      const orderParams: OrderParams = {
        market_id: Number(leg.marketId),
        size_steps: Math.round(leg.size / leg.stepSize),
        price_ticks: Math.round(leg.limitPrice / leg.tickSize),
        side: side === "long" ? Side.Long : Side.Short,
        order_type: OrderType.Market,
        time_in_force: TimeInForce.ImmediateOrCancel,
        post_only: false,
        reduce_only: false,
        stp_mode: StpMode.ExpireTaker,
        ttl_units: 0,
      };
      return placeOrder(orderParams, signerAccount, masterAddress, advanceNonce(baseNonce, i));
    }),
  );

  return Promise.all(
    settled.map(async (result, i): Promise<OrderOutcome> => {
      if (result.status === "rejected") {
        const reason = result.reason;
        return {
          filledQuantity: 0,
          avgFillPrice: 0,
          error: reason instanceof Error ? reason.message : String(reason),
        };
      }

      const response = result.value;
      const filledQuantity = Number(response.filled_quantity || "0") / 1e18;
      if (!(filledQuantity > 0)) {
        return { filledQuantity: 0, avgFillPrice: 0, error: response.message ?? "not filled" };
      }

      // A real fill occurred — never zero it out, even if the price lookup fails.
      try {
        const order = await getOrder(response.order_id);
        return { filledQuantity, avgFillPrice: Number(order.avg_price) };
      } catch {
        // Conservative fallback: the submitted limit price never understates
        // cost for a marketable order (a real buy fill is ≤ limit; a real
        // sell/short fill is ≥ limit), so using it as a stand-in is the safe
        // direction, not a guess presented as fact — flagged via priceUnconfirmed.
        return {
          filledQuantity,
          avgFillPrice: plan.legs[i].limitPrice,
          priceUnconfirmed: true,
        };
      }
    }),
  );
}

/**
 * Open or increase a position for a tokenset: plan → guard → per-market
 * leverage → independent IOC orders signed by the session key → record the
 * lot. Shared by `executeBuy` (side="long") and `executeShort` (side="short").
 *
 * Failure-mode ordering (money safety):
 * - Invalid plan or no fill at all → throw BEFORE anything executes (safe to retry).
 * - Once ANY leg fills → never throw: return the recorded lot with
 *   `partial`/`persisted` flags so a real fill is never mistaken for "nothing
 *   happened" (which would invite a double-spend retry).
 */
async function openPosition(args: ExecuteBuyArgs, side: "long" | "short"): Promise<ExecuteBuyResult> {
  const {
    masterAddress,
    tokensetId,
    tokensetName,
    markets,
    usdcTotal,
    slippage,
    availableUsdc,
    leverage = 1,
  } = args;

  const plan = planBuy(markets, usdcTotal, slippage, availableUsdc, leverage, side);
  if (!plan.ok) throw new Error(plan.errors.join("; "));

  // Trust boundary: verifies an approved session key is bound to this exact master.
  const signerAccount = getAgentAccount(masterAddress);

  await setLeverageForPlan(plan, leverage, signerAccount, masterAddress);

  const outcomes = await placeLegOrders(plan, side, signerAccount, masterAddress);
  const legs = buildLegsFromOutcomes(plan, outcomes);

  if (!anyLegFilled(legs)) {
    const firstError = legs.find((l) => l.error)?.error;
    const verb = side === "long" ? "Buy" : "Short";
    throw new Error(`${verb} did not fill${firstError ? `: ${firstError}` : ""}`);
  }

  const filledLegs = legs.filter((l) => l.qtyBought > 0);
  const failed: FailedLeg[] = legs
    .filter((l) => l.qtyBought <= 0)
    .map((l) => ({ marketId: l.marketId, symbol: l.symbol, error: l.error ?? "not filled" }));

  const record = makeBuyRecord(
    { tokensetId, tokensetName, wallet: masterAddress, side, leverage, legs: filledLegs },
    safeId(),
    Date.now(),
  );

  let persisted = true;
  try {
    saveLots(masterAddress, addLot(loadLots(masterAddress), record));
  } catch {
    persisted = false;
  }

  const planSizeByMarket = new Map(plan.legs.map((l) => [l.marketId, l.size]));
  const underfilled = filledLegs.some(
    (l) => l.qtyBought < (planSizeByMarket.get(l.marketId) ?? 0) - 1e-9,
  );
  const partial = failed.length > 0 || underfilled || filledLegs.some((l) => l.priceUnconfirmed);

  return { plan, record, partial, persisted, failed };
}

/** Buy (open or increase a long) — see `openPosition`. */
export async function executeBuy(args: ExecuteBuyArgs): Promise<ExecuteBuyResult> {
  return openPosition(args, "long");
}

/** Short (open or increase a short) — mirrors `executeBuy`; see `openPosition`. */
export async function executeShort(args: ExecuteBuyArgs): Promise<ExecuteBuyResult> {
  return openPosition(args, "short");
}

export interface ExecuteSellArgs {
  masterAddress: Address;
  lot: BuyRecord;
  /** Fraction of each leg's remaining quantity to sell (0 < pct ≤ 1). */
  pct: number;
  /** Current markets (used to price/size the close), any order. */
  markets: SizingMarketInput[];
  slippage?: number;
}

export interface ExecuteSellResult {
  plan: SellPlan;
  lot: BuyRecord;
  realizedPnlUsd: number;
  /** True if some sellable legs did not fully fill, or some legs were unsellable. */
  partial: boolean;
  persisted: boolean;
}

/**
 * Close a percentage of a single lot. Same money-safety ordering as
 * `executeBuy`/`executeShort`: throw before anything executes (invalid plan)
 * or if nothing sold at all; once any close fills, never throw — report via
 * `partial`/`persisted`. Only the target lot is mutated (independent lots).
 * Each sellable leg is placed as its own `reduceOnly` order (no batch
 * endpoint — see `openPosition`'s doc comment); side is close-direction-aware:
 * closing a long is a plain sell, closing a short is a buy-to-cover.
 *
 * KNOWN LIMITATION (carried over from the reference project): the
 * load→modify→save of lots is not atomic across browser tabs.
 */
export async function executeSell(args: ExecuteSellArgs): Promise<ExecuteSellResult> {
  const { masterAddress, lot, pct, markets, slippage } = args;

  const marketByMarketId = new Map(markets.map((m) => [m.marketId, m]));
  const plan = planSell(lot, pct, marketByMarketId, slippage);
  if (!plan.ok) throw new Error(plan.errors.join("; "));

  const signerAccount = getAgentAccount(masterAddress);
  const sellableLegs = plan.legs.filter((l) => l.sellable);

  const baseNonce = await getNonceState(masterAddress);
  const settled = await Promise.allSettled(
    sellableLegs.map((leg, i) => {
      // Closing a long = sell (Side.Short); closing a short = buy-to-cover (Side.Long).
      const orderParams: OrderParams = {
        market_id: Number(leg.marketId),
        size_steps: Math.round(leg.sellQty / leg.stepSize),
        price_ticks: Math.round(leg.limitPrice / leg.tickSize),
        side: leg.side === "short" ? Side.Long : Side.Short,
        order_type: OrderType.Market,
        time_in_force: TimeInForce.ImmediateOrCancel,
        post_only: false,
        reduce_only: true,
        stp_mode: StpMode.ExpireTaker,
        ttl_units: 0,
      };
      return placeOrder(orderParams, signerAccount, masterAddress, advanceNonce(baseNonce, i));
    }),
  );

  const fills: SellFill[] = await Promise.all(
    settled.map(async (result, i): Promise<SellFill> => {
      const leg = sellableLegs[i];
      if (result.status === "rejected") {
        return { marketId: leg.marketId, soldQty: 0, avgPx: 0 };
      }
      const filledQuantity = Number(result.value.filled_quantity || "0") / 1e18;
      if (!(filledQuantity > 0)) {
        return { marketId: leg.marketId, soldQty: 0, avgPx: 0 };
      }
      // A real close occurred — never zero it out, even if the price lookup fails.
      try {
        const order = await getOrder(result.value.order_id);
        return { marketId: leg.marketId, soldQty: filledQuantity, avgPx: Number(order.avg_price) };
      } catch {
        // Conservative fallback, same reasoning as `openPosition`'s: the
        // submitted limit price never understates proceeds for a marketable
        // close (a real fill is never worse than its limit).
        return { marketId: leg.marketId, soldQty: filledQuantity, avgPx: leg.limitPrice };
      }
    }),
  );

  const filled = fills.filter((f) => f.soldQty > 0);
  if (filled.length === 0) {
    throw new Error("Sell did not fill");
  }

  // A real sell occurred — do not throw past this point.
  const { lot: updatedLot, realizedPnlUsd } = applySellFills(lot, filled);

  let persisted = true;
  try {
    saveLots(masterAddress, replaceLot(loadLots(masterAddress), updatedLot));
  } catch {
    persisted = false;
  }

  const partial =
    plan.legs.some((l) => !l.sellable) ||
    sellableLegs.some((leg, i) => (fills[i]?.soldQty ?? 0) < leg.sellQty - 1e-9);

  return { plan, lot: updatedLot, realizedPnlUsd, partial, persisted };
}
