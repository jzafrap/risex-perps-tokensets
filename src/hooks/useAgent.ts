import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { useAccount } from "wagmi";
import { ENV } from "../config/env";
import {
  approveAgent as approveAgentLib,
  clearAgent,
  expireIfStale,
  getAgentSession,
  getSnapshot,
  subscribe,
} from "../lib/agent";
import { riseMainnet, riseTestnet } from "../lib/wagmi";

/** How often to check whether the session key has passed its signed
 * `expiresAt` (docs/tasks.md task 11) — the trust-boundary check in
 * `lib/agent.ts` is already expiry-aware, but nothing re-evaluates the clock
 * on its own, so the reactive UI snapshot needs this poll to fall back to
 * the approval prompt once a session goes stale. */
const EXPIRY_CHECK_INTERVAL_MS = 30_000;

const targetChain = ENV.network === "mainnet" ? riseMainnet : riseTestnet;

/**
 * Manage the session-key ("API Wallet") for the connected wallet — ported
 * from the reference project's `hooks/useAgent.ts` (docs/tasks.md task 9),
 * with one correction found while testing against a real wallet: the
 * original's comment claimed "the wallet's active network doesn't matter for
 * signing," reasoning that RiseX's `approveAgent` fetches its own EIP-712
 * domain/chain via `ENV` regardless of what the wallet is connected to. That
 * assumption doesn't hold here — MetaMask (and other wallets) validate that a
 * `signTypedData` request's `domain.chainId` matches the wallet's CURRENTLY
 * ACTIVE network, and reject the request otherwise
 * ("chainId should be same as current chainId"). So `approve()` now
 * explicitly switches (or adds, if RISE Chain isn't in the wallet yet) the
 * correct chain before requesting the signature.
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
        chain: targetChain,
        transport: custom(provider),
      });

      // Ensure the wallet is actually ON RISE Chain before signing — see the
      // module doc comment above for why this is required.
      try {
        await walletClient.switchChain({ id: targetChain.id });
      } catch {
        // Unrecognized chain (e.g. error code 4902) — add it, then switch.
        await walletClient.addChain({ chain: targetChain });
        await walletClient.switchChain({ id: targetChain.id });
      }

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
