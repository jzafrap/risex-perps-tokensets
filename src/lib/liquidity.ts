import type { Orderbook } from "./risex";

/**
 * Pure liquidity helpers for the tokenset composer's badges — RiseX port of
 * the reference project's `lib/liquidity.ts` concept (docs/design.md,
 * docs/tasks.md task 9). Now backed by a real order book (`GET /v1/orderbook`,
 * confirmed live) after task 3's earlier "no confirmed endpoint" gap was
 * resolved by reading `risex-client`'s source directly.
 */

export type LiquidityTier = "high" | "medium" | "low";

/** 24h quote-volume thresholds (USD) for the volume-only tier — used when no
 * order book is available yet, or as the coarse first-pass filter. */
const HIGH_VOLUME_USD = 1_000_000;
const MEDIUM_VOLUME_USD = 100_000;

export function volumeTier(quoteVolume24h: number): LiquidityTier {
  if (quoteVolume24h >= HIGH_VOLUME_USD) return "high";
  if (quoteVolume24h >= MEDIUM_VOLUME_USD) return "medium";
  return "low";
}

/** Mid price from the order book's best bid/ask, or null if either side is empty. */
export function midFromBook(book: Orderbook): number | null {
  const bestBid = book.bids[0] ? Number(book.bids[0].price) : null;
  const bestAsk = book.asks[0] ? Number(book.asks[0].price) : null;
  if (bestBid === null || bestAsk === null) return null;
  return (bestBid + bestAsk) / 2;
}

/** Bid/ask spread as a percentage of mid, or null if unpriceable. */
export function spreadPct(book: Orderbook): number | null {
  const bestBid = book.bids[0] ? Number(book.bids[0].price) : null;
  const bestAsk = book.asks[0] ? Number(book.asks[0].price) : null;
  if (bestBid === null || bestAsk === null || bestBid <= 0) return null;
  const mid = (bestBid + bestAsk) / 2;
  return ((bestAsk - bestBid) / mid) * 100;
}

/** Notional size (quote-currency value) resting within `pct`% of mid, summed
 * across both sides — the truest proxy for how much a market order will slip. */
export function depthWithinPct(book: Orderbook, pct: number): number {
  const mid = midFromBook(book);
  if (mid === null || mid <= 0) return 0;
  const band = mid * (pct / 100);
  const lower = mid - band;
  const upper = mid + band;

  let notional = 0;
  for (const level of book.bids) {
    const price = Number(level.price);
    if (price >= lower) notional += price * Number(level.quantity);
  }
  for (const level of book.asks) {
    const price = Number(level.price);
    if (price <= upper) notional += price * Number(level.quantity);
  }
  return notional;
}

/**
 * Combine the coarse 24h-volume tier with a spread-based downgrade: a thin
 * book (wide spread) is flagged even if 24h volume looks healthy. Never
 * upgrades a tier — only downgrades toward "low".
 */
export function worstTier(volume24hTier: LiquidityTier, spread: number | null): LiquidityTier {
  if (spread === null) return volume24hTier;
  const order: LiquidityTier[] = ["low", "medium", "high"];
  const spreadTier: LiquidityTier = spread > 1 ? "low" : spread > 0.3 ? "medium" : "high";
  const worseIndex = Math.min(order.indexOf(volume24hTier), order.indexOf(spreadTier));
  return order[worseIndex];
}
