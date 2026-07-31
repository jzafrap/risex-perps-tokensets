import type { Address } from "viem";
import type { Market } from "../lib/risex";
import type { Tokenset } from "../lib/tokensets";
import { BuyForm } from "./BuyForm";
import { ShortForm } from "./ShortForm";

/**
 * List of composed tokensets, each with its Buy/Short controls — RiseX port
 * of the reference project's `TokensetList.tsx` (docs/tasks.md task 9).
 * Perps-only: `ShortForm` now mounts unconditionally alongside `BuyForm` for
 * every tokenset (the original only mounted it when `marketType === "perp"`).
 */
export function TokensetList({
  tokensets,
  markets,
  masterAddress,
  agentApproved,
  onDelete,
  onChanged,
}: {
  tokensets: Tokenset[];
  markets: Market[];
  masterAddress: Address;
  agentApproved: boolean;
  onDelete: (id: string) => void;
  onChanged: () => void;
}) {
  if (tokensets.length === 0) {
    return <p className="tokenset-list-empty">No tokensets yet — compose one above.</p>;
  }

  return (
    <div className="tokenset-list">
      {tokensets.map((ts) => (
        <div key={ts.id} className="tokenset-card">
          <div className="tokenset-card-header">
            <h3>{ts.name}</h3>
            <button type="button" onClick={() => onDelete(ts.id)}>
              Delete
            </button>
          </div>
          <div className="tokenset-chips">
            {ts.markets.map((id) => {
              const market = markets.find((m) => m.market_id === id);
              return (
                <span key={id} className="tokenset-chip">
                  {market?.display_name ?? id}
                </span>
              );
            })}
          </div>
          <BuyForm
            tokenset={ts}
            markets={markets}
            masterAddress={masterAddress}
            agentApproved={agentApproved}
            onBought={onChanged}
          />
          <ShortForm
            tokenset={ts}
            markets={markets}
            masterAddress={masterAddress}
            agentApproved={agentApproved}
            onShorted={onChanged}
          />
        </div>
      ))}
    </div>
  );
}
