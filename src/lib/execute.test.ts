import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { executeBuy, executeShort, executeSell } from "./execute";
import { loadLots, saveLots, type BuyRecord } from "./lots";
import type { SizingMarketInput } from "./sizing";

vi.mock("./agent", () => ({
  getAgentAccount: vi.fn(),
}));
vi.mock("./exchange", () => ({
  placeOrder: vi.fn(),
  updateLeverage: vi.fn(),
}));
vi.mock("./risex", () => ({
  getNonceState: vi.fn(),
  getOrder: vi.fn(),
}));

import { getAgentAccount } from "./agent";
import { placeOrder, updateLeverage } from "./exchange";
import { getNonceState, getOrder } from "./risex";

const MASTER = "0x1111111111111111111111111111111111111111" as const;
const SIGNER = privateKeyToAccount(generatePrivateKey());

const MARKET_A: SizingMarketInput = {
  marketId: "1",
  symbol: "BTC/USDC",
  stepSize: 0.001,
  tickSize: 0.1,
  minOrderSize: 0.001,
  maxLeverage: 50,
  mid: 100,
};

const MARKET_B: SizingMarketInput = {
  marketId: "2",
  symbol: "ETH/USDC",
  stepSize: 0.01,
  tickSize: 0.01,
  minOrderSize: 0.01,
  maxLeverage: 50,
  mid: 50,
};

describe("executeBuy / executeShort", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(getAgentAccount).mockReturnValue(SIGNER);
    vi.mocked(getNonceState).mockResolvedValue({ nonce_anchor: "0", current_bitmap_index: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws before touching the agent/exchange when the plan is invalid", async () => {
    await expect(
      executeBuy({
        masterAddress: MASTER,
        tokensetId: "ts1",
        tokensetName: "Basket",
        markets: [MARKET_A, MARKET_B],
        usdcTotal: 0,
      }),
    ).rejects.toThrow();

    expect(getAgentAccount).not.toHaveBeenCalled();
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("sets leverage once per unique market before placing orders", async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      order_id: "1-1-1",
      tx_hash: "0x1",
      block_number: "1",
      sc_order_id: "1",
      filled_quantity: String(0.98 * 1e18),
    });
    vi.mocked(getOrder).mockResolvedValue({
      id: "1-1-1",
      wide_order_id: "1",
      resting_order_id: "1",
      client_order_id: "0",
      market_id: "1",
      sender: MASTER,
      price: "102",
      size: "0.98",
      avg_price: "101.5",
      filled_size: "0.98",
      fee_bps: "5",
      side: "BUY",
      type: "MARKET",
      time_in_force: "IOC",
      status: "ORDER_STATUS_FILLED",
    });

    await executeBuy({
      masterAddress: MASTER,
      tokensetId: "ts1",
      tokensetName: "Basket",
      markets: [MARKET_A, MARKET_B],
      usdcTotal: 200,
      leverage: 3,
    });

    expect(updateLeverage).toHaveBeenCalledTimes(2);
    expect(updateLeverage).toHaveBeenCalledWith(1, 3, SIGNER, MASTER);
    expect(updateLeverage).toHaveBeenCalledWith(2, 3, SIGNER, MASTER);
  });

  it("aborts before placing any order when setting leverage fails (money-safety: nothing executes on a failed pre-condition)", async () => {
    vi.mocked(updateLeverage).mockRejectedValue(new Error("leverage update rejected"));

    await expect(
      executeBuy({
        masterAddress: MASTER,
        tokensetId: "ts1",
        tokensetName: "Basket",
        markets: [MARKET_A, MARKET_B],
        usdcTotal: 200,
        leverage: 5,
      }),
    ).rejects.toThrow("leverage update rejected");

    expect(placeOrder).not.toHaveBeenCalled();
    expect(loadLots(MASTER)).toEqual([]);
  });

  it("stops after the first leverage failure without setting leverage for remaining markets", async () => {
    vi.mocked(updateLeverage).mockImplementation(async (marketId) => {
      if (marketId === 1) throw new Error("leverage update rejected for market 1");
    });

    await expect(
      executeBuy({
        masterAddress: MASTER,
        tokensetId: "ts1",
        tokensetName: "Basket",
        markets: [MARKET_A, MARKET_B],
        usdcTotal: 200,
      }),
    ).rejects.toThrow("leverage update rejected for market 1");

    // Sequential, in plan order: market 1 fails, market 2 is never attempted.
    expect(updateLeverage).toHaveBeenCalledTimes(1);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("places one independent order per leg with distinct, pre-advanced nonces", async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      order_id: "1-1-1",
      tx_hash: "0x1",
      block_number: "1",
      sc_order_id: "1",
      filled_quantity: String(1 * 1e18),
    });
    vi.mocked(getOrder).mockResolvedValue({
      id: "1-1-1",
      wide_order_id: "1",
      resting_order_id: "1",
      client_order_id: "0",
      market_id: "1",
      sender: MASTER,
      price: "102",
      size: "1",
      avg_price: "101",
      filled_size: "1",
      fee_bps: "5",
      side: "BUY",
      type: "MARKET",
      time_in_force: "IOC",
      status: "ORDER_STATUS_FILLED",
    });

    await executeBuy({
      masterAddress: MASTER,
      tokensetId: "ts1",
      tokensetName: "Basket",
      markets: [MARKET_A, MARKET_B],
      usdcTotal: 200,
    });

    expect(placeOrder).toHaveBeenCalledTimes(2);
    const nonces = vi.mocked(placeOrder).mock.calls.map((c) => c[3]?.current_bitmap_index);
    expect(new Set(nonces).size).toBe(2); // no collisions
  });

  it("records only filled legs and reports partial when one leg fails", async () => {
    vi.mocked(placeOrder).mockImplementation(async (params) => {
      if (params.market_id === 1) {
        throw new Error("insufficient margin");
      }
      return {
        order_id: "2-1-1",
        tx_hash: "0x2",
        block_number: "1",
        sc_order_id: "2",
        filled_quantity: String(1.96 * 1e18),
      };
    });
    vi.mocked(getOrder).mockResolvedValue({
      id: "2-1-1",
      wide_order_id: "2",
      resting_order_id: "2",
      client_order_id: "0",
      market_id: "2",
      sender: MASTER,
      price: "51",
      size: "1.96",
      avg_price: "50.8",
      filled_size: "1.96",
      fee_bps: "5",
      side: "BUY",
      type: "MARKET",
      time_in_force: "IOC",
      status: "ORDER_STATUS_FILLED",
    });

    const result = await executeBuy({
      masterAddress: MASTER,
      tokensetId: "ts1",
      tokensetName: "Basket",
      markets: [MARKET_A, MARKET_B],
      usdcTotal: 200,
    });

    expect(result.partial).toBe(true);
    expect(result.persisted).toBe(true);
    expect(result.failed).toEqual([{ marketId: "1", symbol: "BTC/USDC", error: "insufficient margin" }]);
    expect(result.record.legs).toHaveLength(1);
    expect(result.record.legs[0].marketId).toBe("2");

    const saved = loadLots(MASTER);
    expect(saved).toHaveLength(1);
    expect(saved[0].legs).toHaveLength(1);
  });

  it("throws (and persists nothing) when no leg fills at all", async () => {
    vi.mocked(placeOrder).mockRejectedValue(new Error("no liquidity"));

    await expect(
      executeBuy({
        masterAddress: MASTER,
        tokensetId: "ts1",
        tokensetName: "Basket",
        markets: [MARKET_A, MARKET_B],
        usdcTotal: 200,
      }),
    ).rejects.toThrow(/did not fill/);

    expect(loadLots(MASTER)).toEqual([]);
  });

  it("falls back to the limit price and flags priceUnconfirmed when getOrder fails after a real fill", async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      order_id: "3-1-1",
      tx_hash: "0x3",
      block_number: "1",
      sc_order_id: "3",
      filled_quantity: String(1.96 * 1e18),
    });
    vi.mocked(getOrder).mockRejectedValue(new Error("order lookup failed"));

    const result = await executeBuy({
      masterAddress: MASTER,
      tokensetId: "ts1",
      tokensetName: "Basket",
      markets: [MARKET_B],
      usdcTotal: 100,
    });

    expect(result.record.legs[0].qtyBought).toBeGreaterThan(0);
    expect(result.record.legs[0].priceUnconfirmed).toBe(true);
    expect(result.partial).toBe(true);
  });

  it("executeShort records the lot with side='short'", async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      order_id: "4-1-1",
      tx_hash: "0x4",
      block_number: "1",
      sc_order_id: "4",
      filled_quantity: String(1 * 1e18),
    });
    vi.mocked(getOrder).mockResolvedValue({
      id: "4-1-1",
      wide_order_id: "4",
      resting_order_id: "4",
      client_order_id: "0",
      market_id: "1",
      sender: MASTER,
      price: "98",
      size: "1",
      avg_price: "98.5",
      filled_size: "1",
      fee_bps: "5",
      side: "SELL",
      type: "MARKET",
      time_in_force: "IOC",
      status: "ORDER_STATUS_FILLED",
    });

    const result = await executeShort({
      masterAddress: MASTER,
      tokensetId: "ts1",
      tokensetName: "Basket",
      markets: [MARKET_A],
      usdcTotal: 100,
    });

    expect(result.record.side).toBe("short");
  });
});

describe("executeSell", () => {
  const OPEN_LOT: BuyRecord = {
    id: "lot-1",
    tokensetId: "ts1",
    tokensetName: "Basket",
    wallet: MASTER,
    side: "long",
    leverage: 1,
    usdcSpent: 100,
    status: "open",
    createdAt: 0,
    legs: [
      { marketId: "1", symbol: "BTC/USDC", usdcAllocated: 100, qtyBought: 1, avgEntryPrice: 100, qtyRemaining: 1 },
    ],
  };

  beforeEach(() => {
    localStorage.clear();
    saveLots(MASTER, [OPEN_LOT]);
    vi.mocked(getAgentAccount).mockReturnValue(SIGNER);
    vi.mocked(getNonceState).mockResolvedValue({ nonce_anchor: "0", current_bitmap_index: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws before touching the agent/exchange when the plan is invalid", async () => {
    await expect(
      executeSell({ masterAddress: MASTER, lot: OPEN_LOT, pct: 0, markets: [MARKET_A] }),
    ).rejects.toThrow();
    expect(getAgentAccount).not.toHaveBeenCalled();
  });

  it("closes a long lot with a plain SELL order (Side.Short) and accrues realized P&L", async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      order_id: "9-1-1",
      tx_hash: "0x9",
      block_number: "1",
      sc_order_id: "9",
      filled_quantity: String(0.5 * 1e18),
    });
    vi.mocked(getOrder).mockResolvedValue({
      id: "9-1-1",
      wide_order_id: "9",
      resting_order_id: "9",
      client_order_id: "0",
      market_id: "1",
      sender: MASTER,
      price: "98",
      size: "0.5",
      avg_price: "110",
      filled_size: "0.5",
      fee_bps: "5",
      side: "SELL",
      type: "MARKET",
      time_in_force: "IOC",
      status: "ORDER_STATUS_FILLED",
    });

    const result = await executeSell({
      masterAddress: MASTER,
      lot: OPEN_LOT,
      pct: 0.5,
      markets: [MARKET_A],
    });

    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(placeOrder).mock.calls[0][0].reduce_only).toBe(true);
    expect(vi.mocked(placeOrder).mock.calls[0][0].side).toBe(1); // Side.Short = plain sell to close a long
    expect(result.realizedPnlUsd).toBeCloseTo(0.5 * (110 - 100), 9);
    expect(result.lot.status).toBe("partially_sold");
    expect(result.persisted).toBe(true);

    const saved = loadLots(MASTER);
    expect(saved[0].legs[0].qtyRemaining).toBeCloseTo(0.5, 9);
  });

  it("closes a short lot with a buy-to-cover order (Side.Long)", async () => {
    const shortLot: BuyRecord = { ...OPEN_LOT, side: "short" };
    saveLots(MASTER, [shortLot]);

    vi.mocked(placeOrder).mockResolvedValue({
      order_id: "9-2-1",
      tx_hash: "0x9",
      block_number: "1",
      sc_order_id: "9",
      filled_quantity: String(1 * 1e18),
    });
    vi.mocked(getOrder).mockResolvedValue({
      id: "9-2-1",
      wide_order_id: "9",
      resting_order_id: "9",
      client_order_id: "0",
      market_id: "1",
      sender: MASTER,
      price: "102",
      size: "1",
      avg_price: "90",
      filled_size: "1",
      fee_bps: "5",
      side: "BUY",
      type: "MARKET",
      time_in_force: "IOC",
      status: "ORDER_STATUS_FILLED",
    });

    const result = await executeSell({
      masterAddress: MASTER,
      lot: shortLot,
      pct: 1,
      markets: [MARKET_A],
    });

    expect(vi.mocked(placeOrder).mock.calls[0][0].side).toBe(0); // Side.Long = buy-to-cover a short
    // Short covering below entry (100 -> 90) is a profit.
    expect(result.realizedPnlUsd).toBeCloseTo(1 * (100 - 90), 9);
  });

  it("throws and leaves the lot untouched when nothing sells", async () => {
    vi.mocked(placeOrder).mockRejectedValue(new Error("no liquidity"));

    await expect(
      executeSell({ masterAddress: MASTER, lot: OPEN_LOT, pct: 1, markets: [MARKET_A] }),
    ).rejects.toThrow(/did not fill/);

    expect(loadLots(MASTER)[0].legs[0].qtyRemaining).toBe(1);
  });

  it("reports partial when some legs aren't sellable (no market)", async () => {
    const twoLegLot: BuyRecord = {
      ...OPEN_LOT,
      legs: [
        ...OPEN_LOT.legs,
        { marketId: "2", symbol: "ETH/USDC", usdcAllocated: 100, qtyBought: 2, avgEntryPrice: 50, qtyRemaining: 2 },
      ],
    };
    saveLots(MASTER, [twoLegLot]);

    vi.mocked(placeOrder).mockResolvedValue({
      order_id: "9-3-1",
      tx_hash: "0x9",
      block_number: "1",
      sc_order_id: "9",
      filled_quantity: String(1 * 1e18),
    });
    vi.mocked(getOrder).mockResolvedValue({
      id: "9-3-1",
      wide_order_id: "9",
      resting_order_id: "9",
      client_order_id: "0",
      market_id: "1",
      sender: MASTER,
      price: "98",
      size: "1",
      avg_price: "98",
      filled_size: "1",
      fee_bps: "5",
      side: "SELL",
      type: "MARKET",
      time_in_force: "IOC",
      status: "ORDER_STATUS_FILLED",
    });

    // Only market "1" is resolvable — market "2" is missing, so that leg is unsellable.
    const result = await executeSell({
      masterAddress: MASTER,
      lot: twoLegLot,
      pct: 1,
      markets: [MARKET_A],
    });

    expect(result.partial).toBe(true);
    expect(placeOrder).toHaveBeenCalledTimes(1); // only the sellable leg was placed
  });

  it("falls back to the limit price when the fill-price lookup fails, without losing the fill", async () => {
    vi.mocked(placeOrder).mockResolvedValue({
      order_id: "9-4-1",
      tx_hash: "0x9",
      block_number: "1",
      sc_order_id: "9",
      filled_quantity: String(1 * 1e18),
    });
    vi.mocked(getOrder).mockRejectedValue(new Error("lookup failed"));

    const result = await executeSell({
      masterAddress: MASTER,
      lot: OPEN_LOT,
      pct: 1,
      markets: [MARKET_A],
    });

    expect(result.lot.legs[0].qtyRemaining).toBe(0);
    expect(result.persisted).toBe(true);
  });
});
