import { describe, expect, it } from "vitest";
import {
  aggregateTotals,
  computeLegPnls,
  computeLotPnl,
  isPriceStale,
  isSmallPosition,
  totalsFromLegs,
  type LotPnl,
} from "./pnl";
import type { BuyRecord } from "./lots";

const LONG_LOT: BuyRecord = {
  id: "lot-1",
  tokensetId: "ts1",
  tokensetName: "Basket",
  wallet: "0xabc",
  side: "long",
  leverage: 1,
  usdcSpent: 200,
  status: "open",
  createdAt: 0,
  legs: [
    { marketId: "1", symbol: "BTC/USDC", usdcAllocated: 100, qtyBought: 1, avgEntryPrice: 100, qtyRemaining: 1 },
    { marketId: "2", symbol: "ETH/USDC", usdcAllocated: 100, qtyBought: 2, avgEntryPrice: 50, qtyRemaining: 2 },
  ],
};

describe("computeLegPnls", () => {
  it("computes profit for a long leg whose price rose", () => {
    const legs = computeLegPnls(LONG_LOT, new Map([["1", 110], ["2", 50]]));
    const btc = legs.find((l) => l.marketId === "1")!;
    expect(btc.valueUsd).toBe(110);
    expect(btc.costUsd).toBe(100);
    expect(btc.pnlUsd).toBe(10);
    expect(btc.pnlPct).toBe(10);
  });

  it("inverts P&L direction for a short lot", () => {
    const shortLot: BuyRecord = { ...LONG_LOT, side: "short" };
    const legs = computeLegPnls(shortLot, new Map([["1", 90], ["2", 50]]));
    const btc = legs.find((l) => l.marketId === "1")!;
    // Short profits as price falls: entry 100 -> 90 is a $10 gain.
    expect(btc.pnlUsd).toBe(10);
  });

  it("leaves a leg with no current price unvalued (null), not guessed", () => {
    const legs = computeLegPnls(LONG_LOT, new Map([["1", 110]])); // market "2" missing
    const eth = legs.find((l) => l.marketId === "2")!;
    expect(eth.currentPrice).toBeNull();
    expect(eth.valueUsd).toBeNull();
    expect(eth.pnlUsd).toBeNull();
  });

  it("passes through priceUnconfirmed from the underlying BuyLeg", () => {
    const lotWithApprox: BuyRecord = {
      ...LONG_LOT,
      legs: [{ ...LONG_LOT.legs[0], priceUnconfirmed: true }, LONG_LOT.legs[1]],
    };
    const legs = computeLegPnls(lotWithApprox, new Map([["1", 110], ["2", 50]]));
    expect(legs.find((l) => l.marketId === "1")?.priceUnconfirmed).toBe(true);
    expect(legs.find((l) => l.marketId === "2")?.priceUnconfirmed).toBeUndefined();
  });

  it("excludes fully-sold (dust) legs", () => {
    const closedLeg = { ...LONG_LOT, legs: [{ ...LONG_LOT.legs[0], qtyRemaining: 0 }] };
    expect(computeLegPnls(closedLeg, new Map([["1", 110]]))).toHaveLength(0);
  });
});

describe("totalsFromLegs / aggregateTotals", () => {
  it("sums cost/value/pnl only over priced legs, counting unpriced separately", () => {
    const legs = computeLegPnls(LONG_LOT, new Map([["1", 110]])); // "2" unpriced
    const totals = totalsFromLegs(legs);
    expect(totals.costUsd).toBe(100);
    expect(totals.valueUsd).toBe(110);
    expect(totals.pnlUsd).toBe(10);
    expect(totals.unpricedCount).toBe(1);
  });

  it("sums signed per-leg pnl so mixed long+short baskets add correctly", () => {
    const shortLeg = { ...LONG_LOT.legs[1], marketId: "2" };
    const mixedLot: BuyRecord = { ...LONG_LOT, side: "long", legs: [LONG_LOT.legs[0], shortLeg] };
    const legs = computeLegPnls(mixedLot, new Map([["1", 110], ["2", 40]]));
    const totals = totalsFromLegs(legs);
    // leg1: +10 (long, 100->110); leg2 (still "long" lot, 50->40): -20
    expect(totals.pnlUsd).toBe(10 + (40 - 50) * 2);
  });

  it("aggregateTotals combines totals across multiple lots", () => {
    const lot2: BuyRecord = { ...LONG_LOT, id: "lot-2" };
    const lotPnls: LotPnl[] = [computeLotPnl(LONG_LOT, new Map([["1", 110], ["2", 50]])), computeLotPnl(lot2, new Map([["1", 110], ["2", 50]]))];
    const combined = aggregateTotals(lotPnls);
    expect(combined.pnlUsd).toBe(20); // 10 per lot * 2 lots
  });
});

describe("isSmallPosition", () => {
  it("is true when priced and below threshold", () => {
    const pnl = computeLotPnl(LONG_LOT, new Map([["1", 1], ["2", 1]])); // tiny value
    expect(isSmallPosition(pnl, 5)).toBe(true);
  });

  it("is false when no leg is priced (never hide on a price outage)", () => {
    const pnl = computeLotPnl(LONG_LOT, new Map());
    expect(isSmallPosition(pnl, 5)).toBe(false);
  });

  it("is false when value is above threshold", () => {
    const pnl = computeLotPnl(LONG_LOT, new Map([["1", 100], ["2", 50]]));
    expect(isSmallPosition(pnl, 5)).toBe(false);
  });
});

describe("isPriceStale", () => {
  it("is false for a recent timestamp", () => {
    expect(isPriceStale(1_000_000, 1_000_000 + 1000)).toBe(false);
  });

  it("is true once older than the threshold", () => {
    expect(isPriceStale(0, 100_000)).toBe(true);
  });

  it("treats a missing/invalid timestamp as stale (fail safe)", () => {
    expect(isPriceStale(0, 1000)).toBe(true);
    expect(isPriceStale(Number.NaN, 1000)).toBe(true);
  });
});
