import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveAgent,
  clearAgent,
  expireIfStale,
  generateAgent,
  getAgentAccount,
  getAgentSession,
  getSnapshot,
  isAgentApprovedFor,
  subscribe,
  type MasterWalletSigner,
} from "./agent";

const MASTER = "0x1111111111111111111111111111111111111111" as const;
const OTHER_MASTER = "0x2222222222222222222222222222222222222222" as const;

function fetchMock() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/nonce-state/")) {
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({
          data: { nonce_anchor: "5", current_bitmap_index: 12 },
          request_id: "test",
        }),
      };
    }
    if (url.endsWith("/v1/auth/register-signer")) {
      const body = JSON.parse(init!.body as string);
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({
          data: { success: true, echoedBody: body },
          request_id: "test",
        }),
      };
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

function masterWallet(): MasterWalletSigner & { signTypedData: ReturnType<typeof vi.fn> } {
  return {
    signTypedData: vi.fn(async () => "0xmastersignature" as `0x${string}`),
  };
}

describe("agent session lifecycle", () => {
  beforeEach(() => {
    clearAgent();
    vi.stubGlobal("fetch", fetchMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generateAgent creates an unapproved session bound to the master address", () => {
    const session = generateAgent(MASTER);
    expect(session.masterAddress).toBe(MASTER);
    expect(session.approvedAt).toBeNull();
    expect(isAgentApprovedFor(MASTER)).toBe(false);
  });

  it("notifies subscribers when the session changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    generateAgent(MASTER);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("approveAgent registers the session key and marks it approved", async () => {
    const wallet = masterWallet();
    const session = await approveAgent(wallet, MASTER);

    expect(session.approvedAt).not.toBeNull();
    expect(isAgentApprovedFor(MASTER)).toBe(true);
    expect(getSnapshot()).toEqual({
      approved: true,
      agentAddress: session.agentAddress,
      masterAddress: MASTER,
    });
  });

  it("signs RegisterSigner with the master wallet using anchor+1/bitmap=0 (auth nonce convention)", async () => {
    const wallet = masterWallet();
    await approveAgent(wallet, MASTER);

    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
    const call = wallet.signTypedData.mock.calls[0][0];
    expect(call.primaryType).toBe("RegisterSigner");
    expect(call.message.account).toBe(MASTER);
    expect(call.message.nonceAnchor).toBe(6); // nonce_anchor "5" + 1
    expect(call.message.nonceBitmap).toBe(0);
  });

  it("posts nonce_anchor/nonce_bitmap_index matching the auth convention, not the raw nonce-state", async () => {
    const wallet = masterWallet();
    await approveAgent(wallet, MASTER);

    const fetchFn = fetch as unknown as ReturnType<typeof vi.fn>;
    const registerCall = fetchFn.mock.calls.find(([url]: string[]) =>
      url.endsWith("/v1/auth/register-signer"),
    );
    const body = JSON.parse(registerCall![1].body as string);
    expect(body.nonce_anchor).toBe("6");
    expect(body.nonce_bitmap_index).toBe(0);
    expect(body.message).toBe("Registering signer for RISEx");
  });

  it("short-circuits if already approved (no second wallet popup)", async () => {
    const wallet = masterWallet();
    await approveAgent(wallet, MASTER);
    await approveAgent(wallet, MASTER);

    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent approvals for the same master", async () => {
    const wallet = masterWallet();
    const [a, b] = await Promise.all([approveAgent(wallet, MASTER), approveAgent(wallet, MASTER)]);

    expect(a).toBe(b);
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
  });

  it("generates a new key when approving for a different master", async () => {
    const wallet = masterWallet();
    const first = await approveAgent(wallet, MASTER);
    const second = await approveAgent(masterWallet(), OTHER_MASTER);

    expect(second.masterAddress).toBe(OTHER_MASTER);
    expect(second.agentAddress).not.toBe(first.agentAddress);
    expect(isAgentApprovedFor(MASTER)).toBe(false);
    expect(isAgentApprovedFor(OTHER_MASTER)).toBe(true);
  });

  it("clearAgent wipes the session", async () => {
    const wallet = masterWallet();
    await approveAgent(wallet, MASTER);
    clearAgent();

    expect(isAgentApprovedFor(MASTER)).toBe(false);
    expect(getSnapshot()).toEqual({ approved: false });
  });

  it("getAgentAccount throws without an approved session", () => {
    expect(() => getAgentAccount(MASTER)).toThrow(/No approved session key/);
  });

  it("getAgentAccount returns the session key's account once approved", async () => {
    const wallet = masterWallet();
    const session = await approveAgent(wallet, MASTER);
    expect(getAgentAccount(MASTER).address).toBe(session.agentAddress);
  });

  it("expireIfStale clears a session whose expiresAt has passed", async () => {
    const wallet = masterWallet();
    await approveAgent(wallet, MASTER);
    const session = getAgentSession()!;
    session.expiresAt = Math.floor(Date.now() / 1000) - 10; // force it into the past

    expireIfStale(MASTER);

    expect(isAgentApprovedFor(MASTER)).toBe(false);
    expect(getSnapshot()).toEqual({ approved: false });
  });

  it("expireIfStale leaves a still-valid session untouched", async () => {
    const wallet = masterWallet();
    await approveAgent(wallet, MASTER);

    expireIfStale(MASTER);

    expect(isAgentApprovedFor(MASTER)).toBe(true);
  });

  it("expireIfStale does not clear a session bound to a different master", async () => {
    const wallet = masterWallet();
    await approveAgent(wallet, MASTER);
    const session = getAgentSession()!;
    session.expiresAt = Math.floor(Date.now() / 1000) - 10;

    expireIfStale(OTHER_MASTER);

    // isAgentApprovedFor(MASTER) is false regardless here (the session itself
    // is expired), so assert on the session object surviving instead — that's
    // what distinguishes "not cleared" from "cleared".
    expect(getAgentSession()).not.toBeNull();
  });

  it("does not mark the session approved if registration fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/nonce-state/")) {
          return {
            ok: true,
            statusText: "OK",
            json: async () => ({ data: { nonce_anchor: "0", current_bitmap_index: 0 } }),
          };
        }
        return {
          ok: false,
          statusText: "Bad Request",
          json: async () => ({ error: { code: "Invalid", message: "boom" } }),
        };
      }),
    );

    const wallet = masterWallet();
    await expect(approveAgent(wallet, MASTER)).rejects.toThrow("boom");
    expect(isAgentApprovedFor(MASTER)).toBe(false);
  });
});
