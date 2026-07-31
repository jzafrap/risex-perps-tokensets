import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV, storageNamespace } from "./env";

describe("env config", () => {
  it("defaults to testnet when VITE_RISE_NETWORK is unset", () => {
    expect(ENV.network).toBe("testnet");
    expect(ENV.isTestnet).toBe(true);
  });

  it("has a live-verified testnet EIP-712 domain (docs/tasks.md task 0/2 spike)", () => {
    expect(ENV.eip712Domain).toEqual({
      name: "RISEx",
      version: "1",
      chainId: 11_155_931,
      verifyingContract: "0x6DA86F486b5E6536358F5b122dBe184522CA0eE3",
    });
  });

  it("has a live-verified REST/WS base URL", () => {
    expect(ENV.apiUrl).toBe("https://api.testnet.rise.trade");
    expect(ENV.wsUrl).toBe("wss://ws.testnet.rise.trade");
  });

  it("has a live-verified router address (VerifyWitness permit target)", () => {
    expect(ENV.routerAddress).toBe("0x980b8621b8e03c3f396e1dc34c00b14d84f2a20f");
  });
});

describe("env config (mainnet)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves to mainnet with a live-verified EIP-712 domain and URLs", async () => {
    vi.stubEnv("VITE_RISE_NETWORK", "mainnet");
    vi.resetModules();
    const { ENV: mainnetEnv } = await import("./env");

    expect(mainnetEnv.network).toBe("mainnet");
    expect(mainnetEnv.isTestnet).toBe(false);
    expect(mainnetEnv.apiUrl).toBe("https://api.rise.trade");
    expect(mainnetEnv.wsUrl).toBe("wss://ws.risex.trade");
    expect(mainnetEnv.eip712Domain).toEqual({
      name: "RISEx",
      version: "1",
      chainId: 4153,
      verifyingContract: "0x0D919DAA3f12AE715744Eb648c00066c5DBd66f0",
    });
    expect(mainnetEnv.routerAddress).toBe("0xaadde0cea454f2bcb26f46ed54c5709b7bb34a7e");
  });
});

describe("storageNamespace", () => {
  it("scopes the key by network and lowercased wallet, with no marketType param", () => {
    const ns = storageNamespace("0xAbC123");
    expect(ns).toBe(`risex-tokensets:${ENV.network}:0xabc123`);
  });

  it("produces distinct keys for distinct wallets", () => {
    expect(storageNamespace("0xaaa")).not.toBe(storageNamespace("0xbbb"));
  });
});
