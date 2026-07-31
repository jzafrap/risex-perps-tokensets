import { describe, expect, it } from "vitest";
import { planSell } from "./sell";
import type { BuyRecord } from "./lots";
import type { SizingMarketInput } from "./sizing";

const MARKET_A: SizingMarketInput = {
  marketId: "1",
  symbol: "BTC/USDC",
  stepSize: 0.01,
  tickSize: 0.1,
  minOrderSize: 0.1,
  maxLeverage: 10,
  mid: 100,
};

const LONG_LOT: BuyRecord = {
  id: "lot-1",
  tokensetId: "ts1",
  tokensetName: "Basket",
  wallet: "0xabc",
  side: "long",
  leverage: 1,
  usdcSpent: 100,
  status: "open",
  createdAt: 0,
  legs: [
    { marketId: "1", symbol: "BTC/USDC", usdcAllocated: 100, qtyBought: 1, avgEntryPrice: 100, qtyRemaining: 1 },
  ],
};

describe("planSell — long lot (plain sell to close)", () => {
  it("sizes the sell as a percentage of remaining quantity, priced below mid", () => {
    const plan = planSell(LONG_LOT, 0.5, new Map([["1", MARKET_A]]));

    expect(plan.ok).toBe(true);
    expect(plan.sellableCount).toBe(1);
    const leg = plan.legs[0];
    expect(leg.sellQty).toBeCloseTo(0.5, 9);
    expect(leg.side).toBe("long");
    expect(leg.limitPrice).toBeLessThan(MARKET_A.mid); // marketable sell prices below mid
    expect(leg.sellable).toBe(true);
  });

  it("100% closes the full remaining quantity", () => {
    const plan = planSell(LONG_LOT, 1, new Map([["1", MARKET_A]]));
    expect(plan.legs[0].sellQty).toBeCloseTo(1, 9);
  });
});

describe("planSell — short lot (buy-to-cover to close)", () => {
  const SHORT_LOT: BuyRecord = { ...LONG_LOT, side: "short" };

  it("prices the close ABOVE mid (buy-to-cover is marketable like a buy)", () => {
    const plan = planSell(SHORT_LOT, 1, new Map([["1", MARKET_A]]));
    const leg = plan.legs[0];
    expect(leg.side).toBe("short");
    expect(leg.limitPrice).toBeGreaterThan(MARKET_A.mid);
  });
});

describe("planSell — guards", () => {
  it("rejects a percentage outside (0, 1]", () => {
    expect(planSell(LONG_LOT, 0, new Map([["1", MARKET_A]])).ok).toBe(false);
    expect(planSell(LONG_LOT, 1.5, new Map([["1", MARKET_A]])).ok).toBe(false);
  });

  it("flags a leg with no market as unsellable, not silently dropped", () => {
    const plan = planSell(LONG_LOT, 1, new Map());
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0].sellable).toBe(false);
    expect(plan.legs[0].reason).toBe("no market/price");
    expect(plan.ok).toBe(false);
  });

  it("flags a leg that rounds below the market's own minOrderSize", () => {
    const tinyLot: BuyRecord = {
      ...LONG_LOT,
      legs: [{ ...LONG_LOT.legs[0], qtyRemaining: 0.05 }],
    };
    // 5% of 0.05 = 0.0025, rounds to 0 at stepSize 0.01 -> "rounds to zero"
    // Use a pct that rounds to something below minOrderSize (0.1) but nonzero:
    // qtyRemaining 0.05 * pct 1.0 -> sellQty 0.05 (rounded to step 0.01) < minOrderSize 0.1
    const plan = planSell(tinyLot, 1, new Map([["1", MARKET_A]]));
    expect(plan.legs[0].sellable).toBe(false);
    expect(plan.legs[0].reason).toBe("below market minimum size");
  });

  it("reports 'nothing left to sell' when every leg is fully closed (dust)", () => {
    const closedLot: BuyRecord = { ...LONG_LOT, legs: [{ ...LONG_LOT.legs[0], qtyRemaining: 0 }] };
    const plan = planSell(closedLot, 1, new Map([["1", MARKET_A]]));
    expect(plan.legs).toHaveLength(0);
    expect(plan.errors).toContain("Lot has nothing left to sell");
  });
});
