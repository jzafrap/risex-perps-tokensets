import type { Market } from "./risex";

/**
 * Buy-order sizing math — RiseX port of the reference project's `lib/orders.ts`
 * (docs/design.md, docs/tasks.md task 4).
 *
 * Ported as-is (exchange-agnostic): equal-split allocation, the "never skip a
 * leg" re-check after rounding, and leverage→margin math.
 *
 * Rewritten (RiseX-specific, confirmed live via docs/tasks.md task 0/3):
 * - Hyperliquid rounds to `szDecimals`/a flat `$10` minimum notional. RiseX
 *   instead gives each market an integer **step size** (`config.step_size`)
 *   and its own **minimum order SIZE** (`config.min_order_size`) — there is no
 *   flat USD minimum across markets. So the "min-notional guard" becomes a
 *   per-leg minimum-SIZE guard instead of a global dollar floor.
 * - Prices round to a **tick size** (`config.step_price`), not
 *   szDecimals+5-sig-figs.
 *
 * Sizing off the marketable LIMIT price (not mid) so a fill can never cost
 * more than the leg's allocation — same overspend-safety reasoning as the
 * original.
 */

/** Default slippage bound for market-emulating IOC orders (fraction, 0.02 = 2%). */
export const DEFAULT_SLIPPAGE = 0.02;

/** Tiny epsilon so exact-boundary values aren't rejected by floating-point noise. */
const EPSILON = 1e-9;

/** Round `size` DOWN to the nearest multiple of `stepSize` — never up, to avoid
 * overspending. The epsilon absorbs binary-float error without rounding down a
 * genuine fraction (mirrors the reference project's `roundSize`). */
export function roundToStep(size: number, stepSize: number): number {
  if (!(size > 0) || !(stepSize > 0)) return 0;
  return Math.floor(size / stepSize + EPSILON) * stepSize;
}

/** Round `price` to the nearest multiple of `tickSize`, directionally: UP when
 * `roundUp` (keeps a buy/short-close marketable), DOWN otherwise (keeps a
 * sell/long-close marketable). */
export function roundToTick(price: number, tickSize: number, roundUp: boolean): number {
  if (!(price > 0) || !(tickSize > 0)) return 0;
  const steps = price / tickSize;
  return (roundUp ? Math.ceil(steps - EPSILON) : Math.floor(steps + EPSILON)) * tickSize;
}

/**
 * Marketable limit price for an IOC-equivalent order: above mid for buys
 * (rounded up to the nearest tick), below mid for sells (rounded down), by the
 * slippage bound. Mirrors the reference project's `marketablePrice`, minus the
 * 5-significant-figures rule (that was Hyperliquid's wire-format quirk, not a
 * RiseX constraint — RiseX only needs tick alignment).
 */
export function marketablePrice(
  mid: number,
  isBuy: boolean,
  tickSize: number,
  slippage = DEFAULT_SLIPPAGE,
): number {
  if (!(mid > 0)) return 0;
  const raw = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
  return roundToTick(raw, tickSize, isBuy);
}

/** Numeric view of a RiseX market's sizing-relevant fields — parsed once from
 * the wire's decimal strings (see `lib/risex.ts`), never re-parsed downstream. */
export interface SizingMarketInput {
  marketId: string;
  symbol: string;
  stepSize: number;
  tickSize: number;
  minOrderSize: number;
  maxLeverage: number;
  /** Reference price for sizing (mark price). */
  mid: number;
}

/** Parse a live `Market` (decimal-string wire fields) into numeric sizing inputs. */
export function toSizingInput(market: Market): SizingMarketInput {
  return {
    marketId: market.market_id,
    symbol: market.display_name,
    stepSize: Number(market.config.step_size),
    tickSize: Number(market.config.step_price),
    minOrderSize: Number(market.config.min_order_size),
    maxLeverage: Number(market.config.max_leverage),
    mid: Number(market.mark_price),
  };
}

export interface BuyLegPlan {
  marketId: string;
  symbol: string;
  stepSize: number;
  tickSize: number;
  minOrderSize: number;
  /** Intended USDC for this leg (usdcTotal / n). */
  allocationUsd: number;
  mid: number;
  /** Marketable limit price actually submitted. */
  limitPrice: number;
  /** Size after rounding down to stepSize. */
  size: number;
  /** Worst-case notional = size × limitPrice (the max this leg can spend). */
  maxNotionalUsd: number;
}

export interface BuyPlan {
  legs: BuyLegPlan[];
  usdcTotal: number;
  /** Sum of expected notionals (size × mid) — realistic estimate, not the cap. */
  plannedUsd: number;
  slippage: number;
  /** Leverage applied to this plan (1x up to the tightest leg's maxLeverage). */
  leverage: number;
  /** USDC margin actually required = usdcTotal / leverage. At 1x, equals usdcTotal. */
  requiredMarginUsd: number;
  ok: boolean;
  errors: string[];
}

/**
 * Plan an equal-split buy/short-open across the given markets. Re-checks each
 * leg after size rounding against ITS OWN `minOrderSize` — never skips a leg
 * (same "never skip, prompt to raise the total instead" policy as the
 * reference project, adapted from a flat $10 notional floor to RiseX's
 * per-market minimum size).
 */
export function planBuy(
  markets: SizingMarketInput[],
  usdcTotal: number,
  slippage = DEFAULT_SLIPPAGE,
  availableUsdc?: number,
  leverage = 1,
  side: "long" | "short" = "long",
): BuyPlan {
  const n = markets.length;
  const errors: string[] = [];
  const requiredMarginUsd =
    Number.isFinite(usdcTotal) && leverage > 0 ? usdcTotal / leverage : usdcTotal;

  if (n === 0) errors.push("Tokenset has no markets");
  if (!Number.isFinite(usdcTotal) || !(usdcTotal > 0)) {
    errors.push("Enter a valid amount greater than 0");
  }

  if (
    availableUsdc !== undefined &&
    Number.isFinite(availableUsdc) &&
    Number.isFinite(requiredMarginUsd) &&
    requiredMarginUsd > availableUsdc + EPSILON
  ) {
    errors.push(`Insufficient USDC: need ${requiredMarginUsd}, have ${availableUsdc.toFixed(2)}`);
  }

  const isBuy = side === "long";
  const perToken = n > 0 && Number.isFinite(usdcTotal) ? usdcTotal / n : 0;
  const legs: BuyLegPlan[] = markets.map((m) => {
    const limitPrice = marketablePrice(m.mid, isBuy, m.tickSize, slippage);
    // Size off the LIMIT price (worst case) so the fill can't exceed allocation.
    const size = limitPrice > 0 ? roundToStep(perToken / limitPrice, m.stepSize) : 0;
    return {
      marketId: m.marketId,
      symbol: m.symbol,
      stepSize: m.stepSize,
      tickSize: m.tickSize,
      minOrderSize: m.minOrderSize,
      allocationUsd: perToken,
      mid: m.mid,
      limitPrice,
      size,
      maxNotionalUsd: size * limitPrice,
    };
  });

  // Post-rounding re-check: every leg must still clear ITS OWN minimum size.
  for (const leg of legs) {
    if (leg.mid <= 0 || leg.limitPrice <= 0) {
      errors.push(`${leg.symbol}: no price available`);
    } else if (leg.size <= 0 || leg.size < leg.minOrderSize - EPSILON) {
      errors.push(`${leg.symbol}: leg too small after rounding — raise the total amount`);
    }
  }

  const plannedUsd = legs.reduce((sum, l) => sum + l.size * l.mid, 0);

  return {
    legs,
    usdcTotal,
    plannedUsd,
    slippage,
    leverage,
    requiredMarginUsd,
    ok: errors.length === 0,
    errors,
  };
}
