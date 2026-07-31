import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBalance, getMarkets, getNonceState, getOrder, getOrderbook, getPosition } from "./risex";

const BTC_MARKET_FIXTURE = {
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

describe("getMarkets", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(`${(await import("../config/env")).ENV.apiUrl}/v1/markets`);
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({
            data: { markets: [BTC_MARKET_FIXTURE], cached_at: 1_700_000_000 },
            request_id: "test-request-id",
          }),
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the markets array from the response envelope", async () => {
    const markets = await getMarkets();
    expect(markets).toEqual([BTC_MARKET_FIXTURE]);
  });

  it("keeps step_size/step_price/max_leverage as strings, not numbers (wire format)", async () => {
    const [market] = await getMarkets();
    expect(typeof market.config.step_size).toBe("string");
    expect(typeof market.config.step_price).toBe("string");
    expect(typeof market.config.max_leverage).toBe("string");
  });
});

describe("getNonceState", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the account's nonce anchor and bitmap index from the confirmed endpoint", async () => {
    const account = "0x1111111111111111111111111111111111111111" as const;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(`${(await import("../config/env")).ENV.apiUrl}/v1/nonce-state/${account}`);
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({
            data: { nonce_anchor: "0", current_bitmap_index: 0 },
            request_id: "test-request-id",
          }),
        };
      }),
    );

    const state = await getNonceState(account);
    expect(state).toEqual({ nonce_anchor: "0", current_bitmap_index: 0 });
  });
});

describe("getOrder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches order detail (including avg_price, absent from placeOrder's own response)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(`${(await import("../config/env")).ENV.apiUrl}/v1/orders/by-id/1-2-3`);
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({
            data: {
              order: {
                id: "1-2-3",
                market_id: "2",
                avg_price: "1880.5",
                filled_size: "0.001",
                status: "ORDER_STATUS_FILLED",
              },
            },
          }),
        };
      }),
    );

    const order = await getOrder("1-2-3");
    expect(order.avg_price).toBe("1880.5");
    expect(order.filled_size).toBe("0.001");
  });
});

describe("getOrderbook", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches bids/asks for a market_id via query params (real endpoint, not /v1/markets/orderbook-levels)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(`${(await import("../config/env")).ENV.apiUrl}/v1/orderbook?market_id=1&limit=20`);
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({
            data: {
              market_id: "1",
              bids: [{ price: "63678.5", quantity: "0.000785", order_count: 1 }],
              asks: [{ price: "63678.6", quantity: "0.000785", order_count: 1 }],
              total_bids: "85",
              total_asks: "71",
            },
          }),
        };
      }),
    );

    const book = await getOrderbook(1);
    expect(book.bids[0].price).toBe("63678.5");
    expect(book.asks[0].price).toBe("63678.6");
  });
});

describe("getPosition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a position via query params (real endpoint, not a path segment)", async () => {
    const account = "0x1111111111111111111111111111111111111111" as const;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(
          `${(await import("../config/env")).ENV.apiUrl}/v1/account/position?market_id=1&account=${account}`,
        );
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({ data: { position: { size: "0", market_id: "0" } } }),
        };
      }),
    );

    const position = await getPosition(1, account);
    expect(position.size).toBe("0");
  });
});

describe("getBalance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the cross-margin balance for an account", async () => {
    const account = "0x1111111111111111111111111111111111111111" as const;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(
          `${(await import("../config/env")).ENV.apiUrl}/v1/account/cross-margin-balance?account=${account}`,
        );
        return { ok: true, statusText: "OK", json: async () => ({ data: { balance: "500.25" } }) };
      }),
    );

    expect(await getBalance(account)).toBe("500.25");
  });
});

describe("getMarkets error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws with the API's error message on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        statusText: "Internal Server Error",
        json: async () => ({ error: { code: "Internal", message: "boom" } }),
      })),
    );

    await expect(getMarkets()).rejects.toThrow("boom");
  });
});
