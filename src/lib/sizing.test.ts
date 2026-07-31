import { describe, expect, it } from "vitest";
import {
  marketablePrice,
  planBuy,
  roundToStep,
  roundToTick,
  toSizingInput,
  type SizingMarketInput,
} from "./sizing";
import type { Market } from "./risex";

describe("roundToStep", () => {
  it("floors to the nearest step multiple", () => {
    expect(roundToStep(1.987, 0.01)).toBeCloseTo(1.98, 9);
    expect(roundToStep(100 / 51, 0.001)).toBeCloseTo(1.96, 9);
  });

  it("does not truncate an already-aligned value due to float noise", () => {
    // 0.58 * 100 = 57.99999999999999 in IEEE754 — must stay 0.58, not drop to 0.57.
    expect(roundToStep(0.58, 0.01)).toBeCloseTo(0.58, 9);
  });

  it("returns 0 for non-positive size or step", () => {
    expect(roundToStep(0, 0.01)).toBe(0);
    expect(roundToStep(-5, 0.01)).toBe(0);
    expect(roundToStep(5, 0)).toBe(0);
  });
});

describe("roundToTick", () => {
  it("rounds up when roundUp is true", () => {
    expect(roundToTick(102.03, 0.1, true)).toBeCloseTo(102.1, 9);
  });

  it("rounds down when roundUp is false", () => {
    expect(roundToTick(102.09, 0.1, false)).toBeCloseTo(102.0, 9);
  });

  it("leaves an exact multiple unchanged in both directions", () => {
    expect(roundToTick(102.0, 0.1, true)).toBeCloseTo(102.0, 9);
    expect(roundToTick(102.0, 0.1, false)).toBeCloseTo(102.0, 9);
  });
});

describe("marketablePrice", () => {
  it("prices a buy above mid, rounded up to the tick", () => {
    expect(marketablePrice(100, true, 0.1, 0.02)).toBeCloseTo(102.0, 9);
  });

  it("prices a sell below mid, rounded down to the tick", () => {
    expect(marketablePrice(100, false, 0.1, 0.02)).toBeCloseTo(98.0, 9);
  });

  it("returns 0 for a non-positive mid", () => {
    expect(marketablePrice(0, true, 0.1)).toBe(0);
  });
});

describe("toSizingInput", () => {
  it("parses a live-shaped Market's decimal-string fields into numbers", () => {
    const btcFixture: Market = {
      market_id: "1",
      base_asset_symbol: "BTC/USDC",
      quote_asset_symbol: "USDC",
      display_name: "BTC/USDC",
      underlying: "BTC/USDC",
      config: {
        name: "BTC/USDC",
        quote: "0x8c49baeec2ea2356598ef33ea5dd52267643e677",
        step_size: "0.000001",
        step_price: "0.1",
        min_order_size: "0.0001",
        unlocked: true,
        max_leverage: "50",
        maintenance_margin_factor: "75",
        open_interest_limit: "0",
      },
      last_price: "63923.2",
      mark_price: "63854.030368642299876051",
      index_price: "63844.168863622195",
      quote_volume_24h: "7501801.1089201",
      change_24h: "-11.8",
      high_24h: "66000",
      low_24h: "63811.8",
      max_position_size: "100000000",
      open_interest: "14624.273672",
      current_funding_rate: "0.000012509122998275",
      funding_rate_8h: "0.0001000729839862",
      accumulated_funding: "-26745.512579585304401948",
      funding_interval: "3600000000000",
      next_funding_time: "1785488400000000000",
      active: true,
      post_only: false,
    };

    const parsed = toSizingInput(btcFixture);
    expect(parsed.stepSize).toBeCloseTo(0.000001, 12);
    expect(parsed.tickSize).toBeCloseTo(0.1, 9);
    expect(parsed.minOrderSize).toBeCloseTo(0.0001, 9);
    expect(parsed.maxLeverage).toBe(50);
    expect(parsed.mid).toBeCloseTo(63854.030368642299876051, 5);
  });
});

const MARKET_A: SizingMarketInput = {
  marketId: "a",
  symbol: "A/USDC",
  stepSize: 0.01,
  tickSize: 0.1,
  minOrderSize: 0.1,
  maxLeverage: 10,
  mid: 100,
};

const MARKET_B: SizingMarketInput = {
  marketId: "b",
  symbol: "B/USDC",
  stepSize: 0.001,
  tickSize: 0.01,
  minOrderSize: 0.01,
  maxLeverage: 20,
  mid: 50,
};

describe("planBuy", () => {
  it("splits usdcTotal equally and sizes off the marketable limit price", () => {
    const plan = planBuy([MARKET_A, MARKET_B], 200);

    expect(plan.ok).toBe(true);
    expect(plan.legs[0].allocationUsd).toBe(100);
    expect(plan.legs[0].limitPrice).toBeCloseTo(102.0, 9);
    expect(plan.legs[0].size).toBeCloseTo(0.98, 9);
    expect(plan.legs[0].maxNotionalUsd).toBeLessThanOrEqual(100);

    expect(plan.legs[1].limitPrice).toBeCloseTo(51.0, 9);
    expect(plan.legs[1].size).toBeCloseTo(1.96, 9);
    expect(plan.legs[1].maxNotionalUsd).toBeLessThanOrEqual(100);
  });

  it("never lets a fill cost more than the leg's allocation", () => {
    const plan = planBuy([MARKET_A, MARKET_B], 200);
    for (const leg of plan.legs) {
      expect(leg.maxNotionalUsd).toBeLessThanOrEqual(leg.allocationUsd + 1e-9);
    }
  });

  it("computes requiredMarginUsd from leverage (1x is numerically unchanged)", () => {
    const plan1x = planBuy([MARKET_A], 100, undefined, undefined, 1);
    expect(plan1x.requiredMarginUsd).toBe(100);

    const plan2x = planBuy([MARKET_A], 100, undefined, undefined, 2);
    expect(plan2x.requiredMarginUsd).toBe(50);
  });

  it("blocks the whole plan (never skips a leg) when a leg rounds below its own minOrderSize", () => {
    // perToken = 0.5 → size at Market A rounds to 0 (below minOrderSize 0.1).
    const plan = planBuy([MARKET_A], 1);

    expect(plan.ok).toBe(false);
    expect(plan.errors.some((e) => e.includes("too small"))).toBe(true);
  });

  it("flags insufficient funds against the required margin, not raw usdcTotal", () => {
    const plan = planBuy([MARKET_A], 100, undefined, 50, 1);
    expect(plan.ok).toBe(false);
    expect(plan.errors.some((e) => e.includes("Insufficient USDC"))).toBe(true);
  });

  it("rejects a non-positive or missing usdcTotal", () => {
    expect(planBuy([MARKET_A], 0).ok).toBe(false);
    expect(planBuy([MARKET_A], Number.NaN).ok).toBe(false);
  });

  it("rejects an empty market list", () => {
    expect(planBuy([], 100).ok).toBe(false);
  });
});
