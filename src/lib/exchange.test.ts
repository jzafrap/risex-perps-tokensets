import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildPermit, placeOrder, updateLeverage } from "./exchange";
import { OrderType, Side, StpMode, TimeInForce, type OrderParams } from "./orderEncoding";

const MASTER = "0x1111111111111111111111111111111111111111" as const;
const SIGNER = privateKeyToAccount(generatePrivateKey());

function fetchMock() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/nonce-state/")) {
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({ data: { nonce_anchor: "5", current_bitmap_index: 12 } }),
      };
    }
    if (url.endsWith("/v1/orders/place") || url.endsWith("/v1/account/leverage")) {
      const body = JSON.parse(init!.body as string);
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({ data: { echoed: body, order_id: "1-2-3", tx_hash: "0xabc" } }),
      };
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

describe("buildPermit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the current anchor/bitmap when the bitmap isn't exhausted", async () => {
    const permit = await buildPermit(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SIGNER,
      MASTER,
      { nonce_anchor: "5", current_bitmap_index: 12 },
    );

    expect(permit.nonce_anchor).toBe(5);
    expect(permit.nonce_bitmap_index).toBe(12);
    expect(permit.account).toBe(MASTER);
    expect(permit.signer).toBe(SIGNER.address);
  });

  it("rolls over to a fresh anchor with bitmap 0 once the bitmap is exhausted (>207)", async () => {
    const permit = await buildPermit(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SIGNER,
      MASTER,
      { nonce_anchor: "5", current_bitmap_index: 208 },
    );

    expect(permit.nonce_anchor).toBe(6);
    expect(permit.nonce_bitmap_index).toBe(0);
  });

  it("does not roll over exactly at the boundary (208 is the rollover trigger, 207 is still valid)", async () => {
    const permit = await buildPermit(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SIGNER,
      MASTER,
      { nonce_anchor: "5", current_bitmap_index: 207 },
    );

    expect(permit.nonce_anchor).toBe(5);
    expect(permit.nonce_bitmap_index).toBe(207);
  });

  it("base64-encodes the signature (not a 0x-hex string)", async () => {
    const permit = await buildPermit(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SIGNER,
      MASTER,
      { nonce_anchor: "0", current_bitmap_index: 0 },
    );

    expect(permit.signature.startsWith("0x")).toBe(false);
    expect(/^[A-Za-z0-9+/]+=*$/.test(permit.signature)).toBe(true);
  });

  it("sets a deadline roughly `now + 300s`", async () => {
    const before = Math.floor(Date.now() / 1000);
    const permit = await buildPermit(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SIGNER,
      MASTER,
      { nonce_anchor: "0", current_bitmap_index: 0 },
    );
    expect(permit.deadline).toBeGreaterThanOrEqual(before + 300);
    expect(permit.deadline).toBeLessThan(before + 310);
  });
});

const MARKET_BUY: OrderParams = {
  market_id: 2,
  size_steps: 1000,
  price_ticks: 0,
  side: Side.Long,
  order_type: OrderType.Market,
  time_in_force: TimeInForce.ImmediateOrCancel,
  post_only: false,
  reduce_only: false,
  stp_mode: StpMode.ExpireTaker,
  ttl_units: 0,
};

describe("placeOrder", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches nonce state and posts the order with a signed permit attached", async () => {
    const result = await placeOrder(MARKET_BUY, SIGNER, MASTER);
    expect(result.order_id).toBe("1-2-3");

    const fetchFn = fetch as unknown as ReturnType<typeof vi.fn>;
    const call = fetchFn.mock.calls.find(([url]: string[]) => url.endsWith("/v1/orders/place"));
    const body = JSON.parse(call![1].body as string);
    expect(body.market_id).toBe(2);
    expect(body.side).toBe(Side.Long);
    expect(body.builder_id).toBe(0);
    expect(body.client_order_id).toBe("0");
    expect(body.permit.signer).toBe(SIGNER.address);
    expect(body.permit.nonce_anchor).toBe(5);
    expect(body.permit.nonce_bitmap_index).toBe(12);
  });

  it("reuses a supplied nonce state instead of fetching one", async () => {
    await placeOrder(MARKET_BUY, SIGNER, MASTER, { nonce_anchor: "0", current_bitmap_index: 0 });

    const fetchFn = fetch as unknown as ReturnType<typeof vi.fn>;
    const nonceCalls = fetchFn.mock.calls.filter(([url]: string[]) => url.includes("/v1/nonce-state/"));
    expect(nonceCalls).toHaveLength(0);
  });
});

describe("updateLeverage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the leverage update with a signed permit under the 'permit_params' field (not 'permit' — this endpoint's field name differs from /v1/orders/place, confirmed against the live API's own error message)", async () => {
    await updateLeverage(2, 5, SIGNER, MASTER);

    const fetchFn = fetch as unknown as ReturnType<typeof vi.fn>;
    const call = fetchFn.mock.calls.find(([url]: string[]) => url.endsWith("/v1/account/leverage"));
    const body = JSON.parse(call![1].body as string);
    expect(body.market_id).toBe(2);
    expect(body.leverage).toBe("5");
    expect(body.permit_params.account).toBe(MASTER);
    expect(body.permit).toBeUndefined();
  });
});
