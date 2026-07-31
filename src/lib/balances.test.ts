import { afterEach, describe, expect, it, vi } from "vitest";
import { getAvailableFunds } from "./balances";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;

describe("getAvailableFunds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the cross-margin balance string into a number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        statusText: "OK",
        json: async () => ({ data: { balance: "1234.56" } }),
      })),
    );
    expect(await getAvailableFunds(ACCOUNT)).toBe(1234.56);
  });

  it("falls back to 0 on an unparseable balance rather than NaN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        statusText: "OK",
        json: async () => ({ data: { balance: "" } }),
      })),
    );
    expect(await getAvailableFunds(ACCOUNT)).toBe(0);
  });
});
