import type { BuyRecord } from "./lots";
import { marketablePrice, roundToStep, type SizingMarketInput } from "./sizing";

/**
 * Sell/close-order sizing — RiseX port of the reference project's
 * `lib/sell.ts` (docs/design.md, docs/tasks.md task 8). A sell always targets
 * ONE lot and a percentage of each leg's remaining quantity; it never touches
 * another lot. Perps-only here, so every "sell" is a CLOSE (reduceOnly),
 * side-aware end to end: closing a long is a plain sell; closing a short is a
 * buy-to-cover (a plain sell on a short lot would GROW the short instead of
 * covering it). Pure and side-effect free — execution lives in `execute.ts`.
 */

const DUST_EPSILON = 1e-9;

export interface SellLegPlan {
  marketId: string;
  symbol: string;
  stepSize: number;
  tickSize: number;
  minOrderSize: number;
  qtyRemaining: number;
  /** Quantity to sell for this leg (qtyRemaining × pct, rounded down). */
  sellQty: number;
  mid: number;
  limitPrice: number;
  /** Whether this leg can actually be sold now. */
  sellable: boolean;
  /** Position direction being closed. "short" closes via buy-to-cover
   * (opposite order side); "long" closes via a plain sell. */
  side: "long" | "short";
  /** Why a leg is not sellable (no market / below min / rounds to zero). */
  reason?: string;
}

export interface SellPlan {
  lotId: string;
  /** Fraction to sell, 0 < pct ≤ 1. */
  pct: number;
  legs: SellLegPlan[];
  sellableCount: number;
  ok: boolean;
  errors: string[];
}

/**
 * Plan a percentage close of a single lot. Only legs with remaining quantity
 * are considered. A leg is not sellable if its market has no price, its
 * rounded sell size is zero, or it would round below that market's own
 * `minOrderSize` — those legs are flagged (not silently dropped) so a partial
 * close is visible.
 */
export function planSell(
  lot: BuyRecord,
  pct: number,
  marketByMarketId: Map<string, SizingMarketInput>,
  slippage?: number,
): SellPlan {
  const errors: string[] = [];
  if (!Number.isFinite(pct) || pct <= 0 || pct > 1) {
    errors.push("Sell percentage must be between 0 and 100");
  }

  // Closing a short means buying to cover: the marketable price direction
  // flips (above mid, rounded up — like opening a long) and so does the
  // eventual order side. Lots without `side` (persisted before directional
  // shorts existed) default to "long".
  const side: "long" | "short" = lot.side === "short" ? "short" : "long";
  const isBuyToClose = side === "short";

  const legs: SellLegPlan[] = lot.legs
    .filter((leg) => leg.qtyRemaining > DUST_EPSILON)
    .map((leg) => {
      const market = marketByMarketId.get(leg.marketId);
      const mid = market?.mid ?? 0;
      const stepSize = market?.stepSize ?? 0;
      const tickSize = market?.tickSize ?? 0;
      const minOrderSize = market?.minOrderSize ?? 0;

      const base: SellLegPlan = {
        marketId: leg.marketId,
        symbol: leg.symbol,
        stepSize,
        tickSize,
        minOrderSize,
        qtyRemaining: leg.qtyRemaining,
        sellQty: 0,
        mid,
        limitPrice: 0,
        sellable: false,
        side,
      };

      if (!market || mid <= 0) {
        return { ...base, reason: "no market/price" };
      }

      const validPct = Number.isFinite(pct) && pct > 0 && pct <= 1 ? pct : 0;
      const sellQty = roundToStep(leg.qtyRemaining * validPct, stepSize);
      const limitPrice = marketablePrice(mid, isBuyToClose, tickSize, slippage);
      if (sellQty <= 0) {
        return { ...base, sellQty, limitPrice, reason: "rounds to zero" };
      }
      if (sellQty < minOrderSize - DUST_EPSILON) {
        return { ...base, sellQty, limitPrice, reason: "below market minimum size" };
      }
      return { ...base, sellQty, limitPrice, sellable: true };
    });

  const sellableCount = legs.filter((l) => l.sellable).length;
  if (legs.length === 0) errors.push("Lot has nothing left to sell");
  else if (sellableCount === 0) {
    errors.push("No legs are sellable right now (illiquid, dust, or below minimum)");
  }

  return {
    lotId: lot.id,
    pct,
    legs,
    sellableCount,
    ok: errors.length === 0,
    errors,
  };
}
