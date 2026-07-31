import { useAgent } from "../hooks/useAgent";

/**
 * Session-key ("API Wallet") approval control — ported near-verbatim from the
 * reference project's `AgentApproval.tsx` (docs/tasks.md task 9). Copy is
 * intentionally hedged on the "trade-only" claim: task 5 found no `withdraw`
 * method in RiseX's confirmed API surface, but that's indirect evidence, not
 * a verified guarantee — see docs/tasks.md task 5.
 */
export function AgentApproval() {
  const { isApproved, agentAddress, approve, revoke, isApproving, error, canApprove } = useAgent();

  if (isApproved) {
    return (
      <div className="agent-approval agent-approval--approved">
        <p>
          Trading session active — key <code>{agentAddress?.slice(0, 10)}…</code> can place/close
          orders on your behalf. It lives only in this browser tab's memory and is discarded on
          refresh or disconnect.
        </p>
        <button type="button" onClick={revoke}>
          Forget session key
        </button>
      </div>
    );
  }

  return (
    <div className="agent-approval">
      <p>
        Approve a session key so you don't have to sign every order in your wallet. It's a
        delegated key that lives only in memory (never saved to disk) and, based on RiseX's
        documented API, has no observed ability to withdraw funds — but that has not been
        independently verified as a hard guarantee.
      </p>
      <button type="button" disabled={!canApprove || isApproving} onClick={approve}>
        {isApproving ? "Approving…" : "Approve session key"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
