import { useMemo, useState } from "react";
import type { Address } from "viem";
import { executeSell } from "../lib/execute";
import type { BuyRecord } from "../lib/lots";
import type { Market } from "../lib/risex";
import { toSizingInput } from "../lib/sizing";

const PERCENTAGES = [0.25, 0.5, 1];

/**
 * Close a percentage of one lot — RiseX port of the reference project's
 * `SellForm.tsx` (docs/tasks.md task 9), minus the `marketType` prop. No
 * leverage control (closes at whatever leverage the lot was opened at). The
 * close label is side-aware ("Cover" for a short, "Sell" for a long) —
 * generic logic, kept as-is.
 */
export function SellForm({
  lot,
  markets,
  masterAddress,
  agentApproved,
  onSold,
}: {
  lot: BuyRecord;
  markets: Market[];
  masterAddress: Address;
  agentApproved: boolean;
  onSold: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sizingInputs = useMemo(() => {
    const marketIds = new Set(lot.legs.map((l) => l.marketId));
    return markets.filter((m) => marketIds.has(m.market_id)).map(toSizingInput);
  }, [lot.legs, markets]);

  const closeLabel = lot.side === "short" ? "Cover" : "Sell";

  async function handleClose(pct: number) {
    setBusy(pct);
    setMessage(null);
    setError(null);
    try {
      const result = await executeSell({ masterAddress, lot, pct, markets: sizingInputs });
      if (!result.persisted) {
        setError(`${closeLabel === "Cover" ? "Covered" : "Sold"}, but couldn't save locally — do not retry.`);
      } else if (result.partial) {
        setMessage("Partially closed — some legs didn't fully fill or weren't sellable.");
      } else {
        setMessage(`${closeLabel === "Cover" ? "Covered" : "Sold"}.`);
      }
      onSold();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sell-form">
      {PERCENTAGES.map((pct) => (
        <button
          key={pct}
          type="button"
          disabled={!agentApproved || busy !== null}
          onClick={() => handleClose(pct)}
        >
          {busy === pct ? "…" : `${closeLabel} ${Math.round(pct * 100)}%`}
        </button>
      ))}
      {message && <p className="form-message">{message}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
