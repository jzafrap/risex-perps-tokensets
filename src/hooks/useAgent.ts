import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { useAccount } from "wagmi";
import {
  approveAgent as approveAgentLib,
  clearAgent,
  expireIfStale,
  getAgentSession,
  getSnapshot,
  subscribe,
} from "../lib/agent";

/** How often to check whether the session key has passed its signed
 * `expiresAt` (docs/tasks.md task 11) — the trust-boundary check in
 * `lib/agent.ts` is already expiry-aware, but nothing re-evaluates the clock
 * on its own, so the reactive UI snapshot needs this poll to fall back to
 * the approval prompt once a session goes stale. */
const EXPIRY_CHECK_INTERVAL_MS = 30_000;

/**
 * Manage the session-key ("API Wallet") for the connected wallet — ported
 * near-verbatim from the reference project's `hooks/useAgent.ts`
 * (docs/tasks.md task 9). No RiseX-specific logic here: this hook only
 * bridges `lib/agent.ts`'s reactive store to React and builds a chain-agnostic
 * `WalletClient` at approve-time from the connector's EIP-1193 provider —
 * `lib/agent.ts`'s `approveAgent` fetches RiseX's own EIP-712 domain/chain via
 * `ENV`, so the wallet's active network doesn't matter for signing.
 */

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function useAgent() {
  const { address, connector, isConnected } = useAccount();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const [isApproving, setIsApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wipe any session key not bound to the currently connected wallet.
  useEffect(() => {
    const s = getAgentSession();
    if (s !== null && !sameAddress(s.masterAddress, address)) {
      clearAgent();
    }
    setError(null);
  }, [address]);

  // Actively expire a stale session so the UI falls back to the approval
  // prompt instead of showing "approved" past the signed expiration.
  useEffect(() => {
    const id = setInterval(() => expireIfStale(address), EXPIRY_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [address]);

  const approve = useCallback(async () => {
    if (!address || !connector) return;
    setIsApproving(true);
    setError(null);
    try {
      const provider = (await connector.getProvider()) as EIP1193Provider;
      const walletClient = createWalletClient({
        account: address,
        transport: custom(provider),
      });
      await approveAgentLib(walletClient, address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsApproving(false);
    }
  }, [address, connector]);

  const revoke = useCallback(() => {
    clearAgent();
    setError(null);
  }, []);

  const isApproved = snapshot.approved && sameAddress(snapshot.masterAddress, address);

  return {
    isApproved,
    agentAddress: isApproved ? snapshot.agentAddress : undefined,
    approve,
    revoke,
    isApproving,
    error,
    canApprove: Boolean(isConnected && address && connector),
  };
}
