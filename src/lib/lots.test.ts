import { beforeEach, describe, expect, it } from "vitest";
import {
  addLot,
  anyLegFilled,
  applySellFills,
  buildLegsFromOutcomes,
  loadLots,
  makeBuyRecord,
  replaceLot,
  saveLots,
  spentFromLegs,
  type BuyRecord,
  type OrderOutcome,
  type SellFill,
} from "./lots";
import type { BuyPlan } from "./sizing";

const PLAN: BuyPlan = {
  legs: [
    {
      marketId: "1",
      symbol: "BTC/USDC",
      stepSize: 0.001,
      tickSize: 0.1,
      minOrderSize: 0.001,
      allocationUsd: 100,
      mid: 100,
      limitPrice: 102,
      size: 0.98,
      maxNotionalUsd: 99.96,
    },
    {
      marketId: "2",
      symbol: "ETH/USDC",
      stepSize: 0.01,
      tickSize: 0.01,
      minOrderSize: 0.01,
      allocationUsd: 100,
      mid: 50,
      limitPrice: 51,
      size: 1.96,
      maxNotionalUsd: 99.96,
    },
  ],
  usdcTotal: 200,
  plannedUsd: 196,
  slippage: 0.02,
  leverage: 1,
  requiredMarginUsd: 200,
  ok: true,
  errors: [],
};

describe("buildLegsFromOutcomes", () => {
  it("records a filled leg with its actual qty/price", () => {
    const outcomes: OrderOutcome[] = [
      { filledQuantity: 0.98, avgFillPrice: 101.5 },
      { filledQuantity: 1.96, avgFillPrice: 50.8 },
    ];
    const legs = buildLegsFromOutcomes(PLAN, outcomes);

    expect(legs[0]).toMatchObject({ marketId: "1", qtyBought: 0.98, avgEntryPrice: 101.5, qtyRemaining: 0.98 });
    expect(legs[1]).toMatchObject({ marketId: "2", qtyBought: 1.96, avgEntryPrice: 50.8, qtyRemaining: 1.96 });
  });

  it("records an unfilled leg (zero qty) without dropping it, keeping the error", () => {
    const outcomes: OrderOutcome[] = [
      { filledQuantity: 0, avgFillPrice: 0 },
      { filledQuantity: 1.96, avgFillPrice: 50.8 },
    ];
    const legs = buildLegsFromOutcomes(PLAN, outcomes);

    expect(legs[0]).toMatchObject({ qtyBought: 0, qtyRemaining: 0, error: "not filled" });
    expect(legs[1].qtyBought).toBe(1.96);
  });

  it("records a leg whose placeOrder call threw, using its error message", () => {
    const outcomes: OrderOutcome[] = [
      { filledQuantity: 0, avgFillPrice: 0, error: "insufficient margin" },
      { filledQuantity: 1.96, avgFillPrice: 50.8 },
    ];
    const legs = buildLegsFromOutcomes(PLAN, outcomes);
    expect(legs[0].error).toBe("insufficient margin");
  });

  it("never zeroes out a real fill just because its price is unconfirmed", () => {
    const outcomes: OrderOutcome[] = [
      { filledQuantity: 0.98, avgFillPrice: 102, priceUnconfirmed: true },
      { filledQuantity: 1.96, avgFillPrice: 50.8 },
    ];
    const legs = buildLegsFromOutcomes(PLAN, outcomes);
    expect(legs[0].qtyBought).toBe(0.98);
    expect(legs[0].error).toBeUndefined();
    expect(legs[0].priceUnconfirmed).toBe(true);
    expect(legs[1].priceUnconfirmed).toBeUndefined();
  });
});

describe("spentFromLegs / anyLegFilled", () => {
  it("sums filled notionals", () => {
    const legs = buildLegsFromOutcomes(PLAN, [
      { filledQuantity: 1, avgFillPrice: 100 },
      { filledQuantity: 2, avgFillPrice: 50 },
    ]);
    expect(spentFromLegs(legs)).toBe(200);
  });

  it("anyLegFilled is false when every leg is zero", () => {
    const legs = buildLegsFromOutcomes(PLAN, [
      { filledQuantity: 0, avgFillPrice: 0 },
      { filledQuantity: 0, avgFillPrice: 0 },
    ]);
    expect(anyLegFilled(legs)).toBe(false);
  });
});

describe("makeBuyRecord", () => {
  it("defaults side to long and leverage to 1", () => {
    const legs = buildLegsFromOutcomes(PLAN, [
      { filledQuantity: 1, avgFillPrice: 100 },
      { filledQuantity: 2, avgFillPrice: 50 },
    ]);
    const record = makeBuyRecord(
      { tokensetId: "ts1", tokensetName: "Basket", wallet: "0xabc", legs },
      "lot-1",
      1_700_000_000_000,
    );
    expect(record.side).toBe("long");
    expect(record.leverage).toBe(1);
    expect(record.status).toBe("open");
    expect(record.usdcSpent).toBe(200);
  });
});

describe("applySellFills", () => {
  const openLot: BuyRecord = {
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

  it("accrues profit for a long leg sold above entry", () => {
    const fills: SellFill[] = [{ marketId: "1", soldQty: 1, avgPx: 110 }];
    const { lot, realizedPnlUsd } = applySellFills(openLot, fills);
    expect(realizedPnlUsd).toBe(10);
    expect(lot.legs[0].qtyRemaining).toBe(0);
    expect(lot.legs[1].qtyRemaining).toBe(2);
  });

  it("inverts P&L direction for a short lot (profits as price falls)", () => {
    const shortLot: BuyRecord = { ...openLot, side: "short" };
    const fills: SellFill[] = [{ marketId: "1", soldQty: 1, avgPx: 90 }];
    const { realizedPnlUsd } = applySellFills(shortLot, fills);
    expect(realizedPnlUsd).toBe(10); // covering below entry is a profit for a short
  });

  it("marks the lot closed once every leg is fully sold", () => {
    const fills: SellFill[] = [
      { marketId: "1", soldQty: 1, avgPx: 100 },
      { marketId: "2", soldQty: 2, avgPx: 50 },
    ];
    const { lot } = applySellFills(openLot, fills);
    expect(lot.status).toBe("closed");
  });

  it("marks the lot partially_sold when some quantity remains", () => {
    const fills: SellFill[] = [{ marketId: "1", soldQty: 0.5, avgPx: 100 }];
    const { lot } = applySellFills(openLot, fills);
    expect(lot.status).toBe("partially_sold");
  });
});

describe("localStorage persistence (network+wallet scoped)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips lots through save/load", () => {
    const record = makeBuyRecord(
      {
        tokensetId: "ts1",
        tokensetName: "Basket",
        wallet: "0xAbC",
        legs: buildLegsFromOutcomes(PLAN, [
          { filledQuantity: 1, avgFillPrice: 100 },
          { filledQuantity: 2, avgFillPrice: 50 },
        ]),
      },
      "lot-1",
      1_700_000_000_000,
    );

    saveLots("0xAbC", addLot(loadLots("0xAbC"), record));
    const loaded = loadLots("0xAbC");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("lot-1");
  });

  it("replaceLot swaps only the matching lot by id", () => {
    const lotA = makeBuyRecord({ tokensetId: "a", tokensetName: "A", wallet: "0xabc", legs: [] }, "a", 0);
    const lotB = makeBuyRecord({ tokensetId: "b", tokensetName: "B", wallet: "0xabc", legs: [] }, "b", 0);
    const lots = [lotA, lotB];
    const updatedB = { ...lotB, status: "closed" as const };
    const result = replaceLot(lots, updatedB);

    expect(result.find((l) => l.id === "a")).toEqual(lotA);
    expect(result.find((l) => l.id === "b")?.status).toBe("closed");
  });

  it("loadLots returns [] for missing or corrupt data", () => {
    expect(loadLots("0xNoData")).toEqual([]);
    localStorage.setItem("risex-tokensets:testnet:0xcorrupt:lots", "{not json");
    expect(loadLots("0xcorrupt")).toEqual([]);
  });
});
