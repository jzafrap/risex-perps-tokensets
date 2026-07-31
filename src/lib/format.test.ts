import { describe, expect, it } from "vitest";
import { computeChangePct24h } from "./format";

describe("computeChangePct24h", () => {
  it("computes a plausible percentage from a live-shaped BTC example (was showing -1994% before this fix)", () => {
    // last_price: 62783.5, change_24h: -2013.3 (both live-confirmed RiseX values).
    const pct = computeChangePct24h(62783.5, -2013.3);
    expect(pct).not.toBeNull();
    expect(pct!).toBeCloseTo(-3.107, 2);
    expect(Math.abs(pct!)).toBeLessThan(100); // sanity: a percentage, not the raw dollar delta
  });

  it("computes a positive percentage for a price that rose", () => {
    // price 24h ago = 100 - 10 = 90; +10/90 = +11.11%
    expect(computeChangePct24h(100, 10)).toBeCloseTo(11.11, 1);
  });

  it("returns null when the 24h-ago price would be zero (division by zero)", () => {
    expect(computeChangePct24h(10, 10)).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(computeChangePct24h(Number.NaN, 5)).toBeNull();
    expect(computeChangePct24h(100, Number.NaN)).toBeNull();
  });

  it("returns 0 for no change", () => {
    expect(computeChangePct24h(100, 0)).toBe(0);
  });
});
