import type { BuyRecord } from "./lots";

/**
 * Unrealized P&L math for open positions — ported verbatim from the reference
 * project's `lib/pnl.ts` (docs/design.md, docs/tasks.md task 7). No
 * Hyperliquid-specific assumptions were found in here (confirmed while
 * porting): pure math over `BuyRecord`'s remaining quantities and current
 * prices. Only the lookup key changed, from `token` (a spot symbol) to
 * `marketId` (this fork's `BuyLeg` field — see `lib/lots.ts`).
 *
 * Nothing here is persisted. A leg with no current price is left unvalued
 * (null) and excluded from totals rather than guessed.
 */

const DUST = 1e-9;

export interface LegPnl {
  marketId: string;
  symbol: string;
  qtyRemaining: number;
  avgEntryPrice: number;
  currentPrice: number | null;
  costUsd: number;
  valueUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  /** Passed through from `BuyLeg.priceUnconfirmed` (docs/tasks.md task 6) so
   * the UI can flag an approximate cost basis. */
  priceUnconfirmed?: boolean;
}

export interface PnlTotals {
  /** Cost basis of the priced, still-held legs. */
  costUsd: number;
  /** Current market value of the priced, still-held legs. */
  valueUsd: number;
  pnlUsd: number;
  pnlPct: number | null;
  /** Legs that could not be valued (no current price). */
  unpricedCount: number;
}

export interface LotPnl {
  lot: BuyRecord;
  legs: LegPnl[];
  totals: PnlTotals;
}

function pct(pnlUsd: number, costUsd: number): number | null {
  return costUsd > DUST ? (pnlUsd / costUsd) * 100 : null;
}

/**
 * P&L sign multiplier for a lot's side: long profits as value rises above
 * cost (dir=1); short profits as value falls below cost (dir=-1). Lots
 * without a `side` (persisted before directional shorts existed) default to
 * long, matching current behavior exactly.
 */
function pnlDirection(lot: BuyRecord): 1 | -1 {
  return lot.side === "short" ? -1 : 1;
}

/** Per-leg unrealized P&L for a lot's remaining holdings. */
export function computeLegPnls(
  lot: BuyRecord,
  priceByMarket: Map<string, number | null>,
): LegPnl[] {
  const dir = pnlDirection(lot);
  return lot.legs
    .filter((leg) => leg.qtyRemaining > DUST)
    .map((leg) => {
      const currentPrice = priceByMarket.get(leg.marketId) ?? null;
      const costUsd = leg.qtyRemaining * leg.avgEntryPrice;
      const valueUsd = currentPrice !== null ? leg.qtyRemaining * currentPrice : null;
      const pnlUsd = valueUsd !== null ? dir * (valueUsd - costUsd) : null;
      return {
        marketId: leg.marketId,
        symbol: leg.symbol,
        qtyRemaining: leg.qtyRemaining,
        avgEntryPrice: leg.avgEntryPrice,
        currentPrice,
        costUsd,
        valueUsd,
        pnlUsd,
        pnlPct: pnlUsd !== null ? pct(pnlUsd, costUsd) : null,
        ...(leg.priceUnconfirmed ? { priceUnconfirmed: true } : {}),
      };
    });
}

/**
 * Aggregate totals over priced legs (unpriced legs are counted, not valued).
 * `pnlUsd` sums each leg's already-signed `pnlUsd` (rather than
 * `valueUsd - costUsd` on the aggregate) so mixed long+short baskets sum
 * correctly — a long leg's gain and a short leg's gain both add, even though
 * their `valueUsd` deltas point in opposite directions.
 */
export function totalsFromLegs(legs: LegPnl[]): PnlTotals {
  let costUsd = 0;
  let valueUsd = 0;
  let pnlUsd = 0;
  let unpricedCount = 0;
  for (const leg of legs) {
    if (leg.valueUsd === null || leg.pnlUsd === null) {
      unpricedCount += 1;
      continue;
    }
    costUsd += leg.costUsd;
    valueUsd += leg.valueUsd;
    pnlUsd += leg.pnlUsd;
  }
  return { costUsd, valueUsd, pnlUsd, pnlPct: pct(pnlUsd, costUsd), unpricedCount };
}

/** Full P&L view for one lot. */
export function computeLotPnl(lot: BuyRecord, priceByMarket: Map<string, number | null>): LotPnl {
  const legs = computeLegPnls(lot, priceByMarket);
  return { lot, legs, totals: totalsFromLegs(legs) };
}

/** Combined totals across several lots (e.g. all open lots of one tokenset). */
export function aggregateTotals(lotPnls: LotPnl[]): PnlTotals {
  return totalsFromLegs(lotPnls.flatMap((l) => l.legs));
}

/** Positions worth less than this (USDC) are considered "small" / dust. */
export const SMALL_POSITION_USD = 5;

/**
 * Whether a lot's current value is below `threshold` — used by the "hide small
 * balances" filter. Only judged as small when the lot is actually valuable (at
 * least one leg has a current price); a fully-unpriced lot is never hidden, so a
 * price outage can't make real positions disappear.
 */
export function isSmallPosition(pnl: LotPnl, threshold = SMALL_POSITION_USD): boolean {
  const pricedLegs = pnl.legs.length - pnl.totals.unpricedCount;
  return pricedLegs > 0 && pnl.totals.valueUsd < threshold;
}

/** Default age after which live prices are considered stale for P&L display. */
export const PRICE_STALE_MS = 90_000;

/**
 * Whether prices are too old to trust for P&L (staleness guard). Treats an
 * unset/zero timestamp as stale.
 */
export function isPriceStale(updatedAt: number, now: number, thresholdMs = PRICE_STALE_MS): boolean {
  // Fail safe: a missing/invalid timestamp counts as stale.
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return true;
  return now - updatedAt > thresholdMs;
}
