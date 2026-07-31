import { beforeEach, describe, expect, it } from "vitest";
import {
  addTokenset,
  isNameTaken,
  loadTokensets,
  makeTokenset,
  normalizeName,
  removeTokenset,
  saveTokensets,
  type Tokenset,
} from "./tokensets";

describe("normalizeName", () => {
  it("trims whitespace", () => {
    expect(normalizeName("  Basket 1  ")).toBe("Basket 1");
  });
});

describe("isNameTaken", () => {
  const list: Tokenset[] = [{ id: "1", name: "Basket 1", markets: ["1"], createdAt: 0 }];

  it("is case-insensitive", () => {
    expect(isNameTaken(list, "basket 1")).toBe(true);
    expect(isNameTaken(list, "BASKET 1")).toBe(true);
  });

  it("is false for a different name", () => {
    expect(isNameTaken(list, "Basket 2")).toBe(false);
  });
});

describe("makeTokenset", () => {
  it("builds a validated tokenset with de-duplicated market ids", () => {
    const ts = makeTokenset({ name: " Basket 1 ", markets: ["1", "2", "1"] }, "id-1", 123);
    expect(ts).toEqual({ id: "id-1", name: "Basket 1", markets: ["1", "2"], createdAt: 123 });
  });

  it("throws on an empty name", () => {
    expect(() => makeTokenset({ name: "  ", markets: ["1"] }, "id-1", 0)).toThrow(/name is required/);
  });

  it("throws on an empty market list", () => {
    expect(() => makeTokenset({ name: "Basket", markets: [] }, "id-1", 0)).toThrow(/at least one market/);
  });
});

describe("addTokenset / removeTokenset", () => {
  it("prepends a new tokenset", () => {
    const existing: Tokenset[] = [{ id: "1", name: "A", markets: ["1"], createdAt: 0 }];
    const added = { id: "2", name: "B", markets: ["2"], createdAt: 1 };
    expect(addTokenset(existing, added)).toEqual([added, ...existing]);
  });

  it("rejects a duplicate name (case-insensitive)", () => {
    const existing: Tokenset[] = [{ id: "1", name: "Basket", markets: ["1"], createdAt: 0 }];
    expect(() =>
      addTokenset(existing, { id: "2", name: "basket", markets: ["2"], createdAt: 1 }),
    ).toThrow(/already exists/);
  });

  it("removes a tokenset by id", () => {
    const existing: Tokenset[] = [
      { id: "1", name: "A", markets: ["1"], createdAt: 0 },
      { id: "2", name: "B", markets: ["2"], createdAt: 1 },
    ];
    expect(removeTokenset(existing, "1")).toEqual([existing[1]]);
  });
});

describe("localStorage persistence (network+wallet scoped)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips tokensets through save/load", () => {
    const list: Tokenset[] = [{ id: "1", name: "Basket", markets: ["1", "2"], createdAt: 0 }];
    saveTokensets("0xAbC", list);
    expect(loadTokensets("0xAbC")).toEqual(list);
  });

  it("returns [] for missing or corrupt data", () => {
    expect(loadTokensets("0xNoData")).toEqual([]);
    localStorage.setItem("risex-tokensets:testnet:0xcorrupt:tokensets", "{not json");
    expect(loadTokensets("0xcorrupt")).toEqual([]);
  });

  it("does not throw when storage write fails (quota/unavailable)", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => saveTokensets("0xabc", [])).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
