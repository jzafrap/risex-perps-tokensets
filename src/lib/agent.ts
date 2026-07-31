import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ENV } from "../config/env";
import { apiPost } from "./api";
import { getNonceState } from "./risex";

/**
 * RiseX signing layer — session key ("API Wallet") architecture ported from the
 * reference project's `lib/agent.ts` (docs/design.md, docs/tasks.md task 5).
 *
 * Same trust model as the original: the delegated signing key is generated and
 * held ONLY in this module's memory (never localStorage/sessionStorage/cookies/
 * IndexedDB, never logged), discarded on disconnect/refresh, and exposed to React
 * only as a key-free snapshot via subscribe/getSnapshot (`useSyncExternalStore`).
 *
 * What's RiseX-specific (rewritten, not ported): registering the key is
 * `POST /v1/auth/register-signer` and needs TWO EIP-712 signatures — the master
 * wallet's `RegisterSigner` signature AND the new key's own `VerifySigner`
 * self-signature — instead of Hyperliquit's single `approveAgent` signature.
 *
 * PROVENANCE WARNING (read before touching the constants below): RiseX's public
 * docs describe these structs only in prose and got some details wrong elsewhere
 * in this project (see docs/tasks.md task 2's EIP-712-domain correction). The
 * exact EIP-712 type definitions and the "auth ops use anchor+1/bitmap=0" nonce
 * convention below come from reading the source of `risex-client`
 * (github.com/SmoothBot/risex-ts) directly — NOT from doc prose. That SDK's own
 * README calls itself "unofficial, not production ready, use at your own risk."
 * This is still the best available evidence, but **run one real registration on
 * testnet and confirm it succeeds before trusting this on mainnet.**
 */

const REGISTER_SIGNER_MESSAGE = "Registering signer for RISEx";
/** Auth ops (register/revoke signer) deliberately use bitmap index 0 with a
 * fresh anchor (`current anchor + 1`), per `risex-ts`'s
 * `createRegisterSignerSignatures` — a different nonce convention than order
 * permits, which reuse the current anchor/bitmap-index pair. */
const AUTH_NONCE_BITMAP = 0;
/** 30 days — matches `risex-ts`'s `DEFAULT_SIGNER_EXPIRY_SECONDS`. */
const SIGNER_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

const REGISTER_SIGNER_TYPES = {
  RegisterSigner: [
    { name: "account", type: "address" },
    { name: "signer", type: "address" },
    { name: "message", type: "string" },
    { name: "expiration", type: "uint32" },
    { name: "nonceAnchor", type: "uint48" },
    { name: "nonceBitmap", type: "uint8" },
  ],
} as const;

const VERIFY_SIGNER_TYPES = {
  VerifySigner: [
    { name: "account", type: "address" },
    { name: "nonceAnchor", type: "uint48" },
    { name: "nonceBitmap", type: "uint8" },
  ],
} as const;

/** Minimal shape of the master wallet's signer — matches viem's `WalletClient`
 * (wagmi) `signTypedData` method, kept narrow so this module doesn't depend on
 * the full wagmi/viem wallet-client type. */
export interface MasterWalletSigner {
  signTypedData(args: {
    account: Address;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

export interface AgentSession {
  masterAddress: Address;
  /** viem local account wrapping the in-memory session-key private key. */
  account: PrivateKeyAccount;
  agentAddress: Address;
  /** Set once registered with RiseX; null until then. */
  approvedAt: number | null;
  /** Unix seconds — matches the `expiration` signed into `RegisterSigner`. */
  expiresAt: number | null;
}

export interface AgentSnapshot {
  approved: boolean;
  agentAddress?: Address;
  masterAddress?: Address;
}

const NO_AGENT: AgentSnapshot = { approved: false };

// In-memory ONLY. The single source of truth; never serialized.
let session: AgentSession | null = null;
let snapshot: AgentSnapshot = NO_AGENT;
const listeners = new Set<() => void>();

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function publish(): void {
  snapshot =
    session !== null && session.approvedAt !== null
      ? { approved: true, agentAddress: session.agentAddress, masterAddress: session.masterAddress }
      : NO_AGENT;
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): AgentSnapshot {
  return snapshot;
}

export function getAgentSession(): AgentSession | null {
  return session;
}

/** Wipe the session key from memory (disconnect, wallet switch, or manual clear).
 * Does NOT call RiseX's revoke-signer endpoint — same scope as the reference
 * project's `clearAgent` (local-only; on-chain revocation is a separate, not yet
 * implemented, concern). */
export function clearAgent(): void {
  if (session === null) return;
  session = null;
  publish();
}

export function isAgentApprovedFor(masterAddress: Address | undefined): boolean {
  return (
    session !== null &&
    masterAddress !== undefined &&
    sameAddress(session.masterAddress, masterAddress) &&
    session.approvedAt !== null &&
    (session.expiresAt === null || session.expiresAt * 1000 > Date.now())
  );
}

/**
 * Actively expire a stale session (docs/tasks.md task 11 — "API Wallet expiry
 * detection"). `isAgentApprovedFor` already checks `expiresAt` for the
 * signing trust boundary, but nothing re-evaluates it against the clock on
 * its own — the reactive `snapshot` exposed to the UI only updates on a
 * state transition (approve/clear), so a session could silently pass its
 * `expiresAt` while the UI still shows "approved". Call this periodically
 * (see `hooks/useAgent.ts`) so the UI falls back to the approval prompt.
 */
export function expireIfStale(masterAddress: Address | undefined): void {
  if (
    session !== null &&
    session.approvedAt !== null &&
    session.expiresAt !== null &&
    session.expiresAt * 1000 <= Date.now() &&
    (masterAddress === undefined || sameAddress(session.masterAddress, masterAddress))
  ) {
    clearAgent();
  }
}

/** Generate a fresh in-memory session key bound to a master address (unregistered). */
export function generateAgent(masterAddress: Address): AgentSession {
  const account = privateKeyToAccount(generatePrivateKey());
  session = {
    masterAddress,
    account,
    agentAddress: account.address,
    approvedAt: null,
    expiresAt: null,
  };
  publish();
  return session;
}

// De-duplicate concurrent registrations for the same master (avoids double
// wallet popups and last-write-wins races on the shared session).
let inFlight: { master: string; promise: Promise<AgentSession> } | null = null;

/**
 * Register a session key ("API Wallet") for `masterAddress` — RiseX's
 * `POST /v1/auth/register-signer`, requiring two EIP-712 signatures (see the
 * module doc comment). Short-circuits if already approved; (re)generates the
 * key if none exists or it's bound to a different master. Discards a stale
 * result if the wallet changed mid-approval.
 */
export async function approveAgent(
  masterWallet: MasterWalletSigner,
  masterAddress: Address,
  label = "risex-perps-tokensets",
): Promise<AgentSession> {
  if (isAgentApprovedFor(masterAddress)) return session!;
  if (inFlight !== null && sameAddress(inFlight.master, masterAddress)) {
    return inFlight.promise;
  }

  const promise = (async (): Promise<AgentSession> => {
    if (session === null || !sameAddress(session.masterAddress, masterAddress)) {
      generateAgent(masterAddress);
    }
    const target = session!;

    const domain = ENV.eip712Domain;
    if (!domain) {
      throw new Error(`No EIP-712 domain configured for network "${ENV.network}"`);
    }
    const typedDomain = {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    };

    const nonceState = await getNonceState(masterAddress);
    const nonceAnchor = Number(nonceState.nonce_anchor) + 1;
    const nonceBitmap = AUTH_NONCE_BITMAP;
    const expiration = Math.floor(Date.now() / 1000) + SIGNER_EXPIRY_SECONDS;

    // Signed by the MASTER wallet (one popup).
    const accountSignature = await masterWallet.signTypedData({
      account: masterAddress,
      domain: typedDomain,
      types: REGISTER_SIGNER_TYPES,
      primaryType: "RegisterSigner",
      message: {
        account: masterAddress,
        signer: target.agentAddress,
        message: REGISTER_SIGNER_MESSAGE,
        expiration,
        nonceAnchor,
        nonceBitmap,
      },
    });

    // Self-signed by the new session key (no popup — in-memory key).
    const signerSignature = await target.account.signTypedData({
      domain: typedDomain,
      types: VERIFY_SIGNER_TYPES,
      primaryType: "VerifySigner",
      message: { account: masterAddress, nonceAnchor, nonceBitmap },
    });

    await apiPost("/v1/auth/register-signer", {
      account: masterAddress,
      signer: target.agentAddress,
      message: REGISTER_SIGNER_MESSAGE,
      nonce_anchor: String(nonceAnchor),
      nonce_bitmap_index: nonceBitmap,
      expiration: String(expiration),
      account_signature: accountSignature,
      signer_signature: signerSignature,
      label,
    });

    // Apply only if this exact session is still current (wallet didn't change).
    if (session !== target || !sameAddress(target.masterAddress, masterAddress)) {
      throw new Error("Wallet changed during approval — please approve again");
    }
    target.approvedAt = Date.now();
    target.expiresAt = expiration;
    publish();
    return target;
  })();

  inFlight = { master: masterAddress, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

/**
 * The in-memory session key's viem account, for signing order permits
 * (docs/tasks.md task 6). Requires the CURRENT master address and verifies the
 * approved agent is bound to it — this is the trust boundary. Throws if there is
 * no approved agent for that master.
 */
export function getAgentAccount(masterAddress: Address): PrivateKeyAccount {
  if (!isAgentApprovedFor(masterAddress)) {
    throw new Error("No approved session key for the connected wallet — approve one first");
  }
  return session!.account;
}
