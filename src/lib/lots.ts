import { storageNamespace } from "../config/env";
import type { BuyPlan } from "./sizing";

/**
 * Buy lots — the app-side bookkeeping RiseX does not keep, ported near-verbatim
 * from the reference project's `lib/lots.ts` (docs/design.md, docs/tasks.md
 * task 7, pulled forward into task 6 since `execute.ts` depends on it).
 *
 * Dropped vs. the original: the `marketType` field/param (this fork is
 * perps-only — docs/design.md "MarketType removal").
 */

export interface BuyLeg {
  marketId: string;
  symbol: string;
  /** Intended USDC for this leg. */
  usdcAllocated: number;
  /** Size actually filled. */
  qtyBought: number;
  /** Average entry price (USDC per unit) from fills; 0 if unfilled. */
  avgEntryPrice: number;
  /** Remaining size not yet sold (decreases on partial sells). */
  qtyRemaining: number;
  /** Cumulative realized P&L (USDC) from sells of this leg. */
  realizedPnlUsd?: number;
  /** Present when this leg failed to place/fill (qtyBought is 0). */
  error?: string;
  /**
   * True when this leg DID fill but its `avgEntryPrice` is a conservative
   * fallback (the submitted limit price), not a confirmed fill price — the
   * follow-up `GET /v1/orders/by-id/{id}` price lookup failed. Never silently
   * treated as "unfilled"; surfaced so the UI can flag the cost basis as
   * approximate (docs/tasks.md task 6).
   */
  priceUnconfirmed?: boolean;
}

export type LotStatus = "open" | "partially_sold" | "closed";

export interface BuyRecord {
  id: string;
  tokensetId: string;
  tokensetName: string;
  wallet: string;
  /** Position direction. Defaults to "long" for lots persisted before this existed. */
  side?: "long" | "short";
  /** Leverage this position was opened at. Defaults to 1 for older lots. */
  leverage?: number;
  /** Actual USDC spent from fills (not the requested total — rounding). */
  usdcSpent: number;
  legs: BuyLeg[];
  status: LotStatus;
  createdAt: number;
}

/**
 * One leg's outcome from a RiseX `placeOrder` call — either it placed (with
 * some fill, possibly zero for an unfilled IOC) or it threw/failed outright.
 * Unlike Hyperliquid's batched-order status union, RiseX has no bulk-order
 * endpoint (confirmed — docs/tasks.md task 6): each leg is its own independent
 * `placeOrder` call, so there is no "recover partial fills from a thrown batch
 * error" case to model here — a thrown call simply means that leg didn't fill.
 *
 * ASSUMPTION (not yet live-verified — flag before trusting on real fills):
 * `filled_quantity` is documented as "WAD format (1e18)", i.e. the filled size
 * in base-asset units scaled by 1e18, distinct from `size_steps`'s integer
 * step count. No real fill response has been observed yet to confirm this.
 */
export interface OrderOutcome {
  filledQuantity: number;
  avgFillPrice: number;
  /** Set ONLY when nothing filled (placement failed / IOC didn't match). A
   * leg that filled is never marked `error`, even if its price is unconfirmed
   * (see `priceUnconfirmed`) — a real fill must never be recorded as zero. */
  error?: string;
  /** True when the fill is real but its price is a conservative fallback
   * (see `BuyLeg.priceUnconfirmed`). */
  priceUnconfirmed?: boolean;
}

// --- Pure builders ----------------------------------------------------------

/** Build lot legs by pairing a plan with each leg's independent order outcome
 * (same order). A leg with no fill is recorded with qty 0 (and its error, if
 * any) — never dropped, so a partial basket stays visible. A leg that filled
 * is always recorded with its real qty, even if `priceUnconfirmed` is set. */
export function buildLegsFromOutcomes(plan: BuyPlan, outcomes: OrderOutcome[]): BuyLeg[] {
  return plan.legs.map((leg, i) => {
    const outcome = outcomes[i];
    if (!outcome || outcome.filledQuantity <= 0) {
      return {
        marketId: leg.marketId,
        symbol: leg.symbol,
        usdcAllocated: leg.allocationUsd,
        qtyBought: 0,
        avgEntryPrice: 0,
        qtyRemaining: 0,
        error: outcome?.error ?? "not filled",
      };
    }
    return {
      marketId: leg.marketId,
      symbol: leg.symbol,
      usdcAllocated: leg.allocationUsd,
      qtyBought: outcome.filledQuantity,
      avgEntryPrice: outcome.avgFillPrice,
      qtyRemaining: outcome.filledQuantity,
      ...(outcome.priceUnconfirmed ? { priceUnconfirmed: true } : {}),
    };
  });
}

/** Actual USDC spent = sum of filled notionals (qty × entry price). */
export function spentFromLegs(legs: BuyLeg[]): number {
  return legs.reduce((sum, l) => sum + l.qtyBought * l.avgEntryPrice, 0);
}

export interface NewLotInput {
  tokensetId: string;
  tokensetName: string;
  wallet: string;
  side?: "long" | "short";
  leverage?: number;
  legs: BuyLeg[];
}

export function makeBuyRecord(input: NewLotInput, id: string, createdAt: number): BuyRecord {
  return {
    id,
    tokensetId: input.tokensetId,
    tokensetName: input.tokensetName,
    wallet: input.wallet,
    side: input.side ?? "long",
    leverage: input.leverage ?? 1,
    usdcSpent: spentFromLegs(input.legs),
    legs: input.legs,
    status: "open",
    createdAt,
  };
}

/** True if at least one leg actually filled. */
export function anyLegFilled(legs: BuyLeg[]): boolean {
  return legs.some((l) => l.qtyBought > 0);
}

// --- Persistence (localStorage, network+wallet scoped) ---------------------

function storageKey(wallet: string): string {
  return `${storageNamespace(wallet)}:lots`;
}

export function loadLots(wallet: string): BuyRecord[] {
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BuyRecord[]) : [];
  } catch {
    return [];
  }
}

/** Persist lots. Throws on failure (quota/unavailable) — the caller MUST
 * surface this, because a filled buy whose lot isn't saved becomes untracked
 * money. */
export function saveLots(wallet: string, lots: BuyRecord[]): void {
  localStorage.setItem(storageKey(wallet), JSON.stringify(lots));
}

export function addLot(lots: BuyRecord[], lot: BuyRecord): BuyRecord[] {
  return [lot, ...lots];
}

/** Replace a lot in place by id (used after a sell updates it). */
export function replaceLot(lots: BuyRecord[], updated: BuyRecord): BuyRecord[] {
  return lots.map((l) => (l.id === updated.id ? updated : l));
}

const DUST_EPSILON = 1e-9;

/** A confirmed sell fill for one leg. */
export interface SellFill {
  marketId: string;
  soldQty: number;
  avgPx: number;
}

/**
 * Apply sell fills to a lot: reduce each sold leg's qtyRemaining, accrue
 * realized P&L (soldQty × (sellPrice − avgEntryPrice) × side direction), and
 * recompute lot status. Pure — returns a new lot plus this sell's realized
 * P&L. Legs not in `fills` are untouched.
 */
export function applySellFills(
  lot: BuyRecord,
  fills: SellFill[],
): { lot: BuyRecord; realizedPnlUsd: number } {
  const dir = lot.side === "short" ? -1 : 1;
  const byMarket = new Map(fills.map((f) => [f.marketId, f]));
  let realizedPnlUsd = 0;

  const legs = lot.legs.map((leg) => {
    const fill = byMarket.get(leg.marketId);
    if (!fill || fill.soldQty <= 0) return leg;
    const pnl = dir * fill.soldQty * (fill.avgPx - leg.avgEntryPrice);
    realizedPnlUsd += pnl;
    return {
      ...leg,
      qtyRemaining: Math.max(0, leg.qtyRemaining - fill.soldQty),
      realizedPnlUsd: (leg.realizedPnlUsd ?? 0) + pnl,
    };
  });

  const anyRemaining = legs.some((l) => l.qtyRemaining > DUST_EPSILON);
  const status: LotStatus = anyRemaining ? "partially_sold" : "closed";

  return { lot: { ...lot, legs, status }, realizedPnlUsd };
}
