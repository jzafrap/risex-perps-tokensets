import { describe, expect, it } from "vitest";
import { depthWithinPct, midFromBook, spreadPct, volumeTier, worstTier } from "./liquidity";
import type { Orderbook } from "./risex";

const BOOK: Orderbook = {
  market_id: "1",
  bids: [
    { price: "99.9", quantity: "1", order_count: 1 },
    { price: "99.0", quantity: "5", order_count: 1 },
  ],
  asks: [
    { price: "100.1", quantity: "1", order_count: 1 },
    { price: "101.0", quantity: "5", order_count: 1 },
  ],
  total_bids: "2",
  total_asks: "2",
};

describe("volumeTier", () => {
  it("tiers by 24h quote volume thresholds", () => {
    expect(volumeTier(2_000_000)).toBe("high");
    expect(volumeTier(500_000)).toBe("medium");
    expect(volumeTier(1_000)).toBe("low");
  });
});

describe("midFromBook / spreadPct", () => {
  it("computes mid as the average of best bid/ask", () => {
    expect(midFromBook(BOOK)).toBeCloseTo(100, 9);
  });

  it("computes spread as a percentage of mid", () => {
    expect(spreadPct(BOOK)).toBeCloseTo((0.2 / 100) * 100, 9);
  });

  it("returns null when a side of the book is empty", () => {
    const thin: Orderbook = { ...BOOK, asks: [] };
    expect(midFromBook(thin)).toBeNull();
    expect(spreadPct(thin)).toBeNull();
  });
});

describe("depthWithinPct", () => {
  it("sums notional within the band on both sides", () => {
    // mid=100, 1% band = [99, 101]: bid 99.9(1)+99.0(5) both qualify (>=99),
    // ask 100.1(1)+101.0(5) both qualify (<=101).
    const depth = depthWithinPct(BOOK, 1);
    const expected = 99.9 * 1 + 99.0 * 5 + 100.1 * 1 + 101.0 * 5;
    expect(depth).toBeCloseTo(expected, 6);
  });

  it("excludes levels outside a tighter band", () => {
    // 0.05% band = [99.95, 100.05] excludes every level in BOOK.
    expect(depthWithinPct(BOOK, 0.05)).toBe(0);
  });

  it("returns 0 when the book can't be priced", () => {
    expect(depthWithinPct({ ...BOOK, bids: [] }, 1)).toBe(0);
  });
});

describe("worstTier", () => {
  it("keeps the volume tier when spread is tight", () => {
    expect(worstTier("high", 0.1)).toBe("high");
  });

  it("downgrades toward low on a wide spread, never upgrades", () => {
    expect(worstTier("high", 2)).toBe("low");
    expect(worstTier("low", 0.1)).toBe("low");
  });

  it("falls back to the volume tier when spread is unknown", () => {
    expect(worstTier("medium", null)).toBe("medium");
  });
});
