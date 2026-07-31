import { useMemo, useState, type FormEvent } from "react";
import type { Address } from "viem";
import { useAvailableFunds } from "../hooks/useAvailableFunds";
import { executeBuy } from "../lib/execute";
import type { Market } from "../lib/risex";
import { toSizingInput } from "../lib/sizing";
import type { Tokenset } from "../lib/tokensets";
import { LeverageSelector } from "./LeverageSelector";

/**
 * Open/increase a long — RiseX port of the reference project's `BuyForm.tsx`
 * (docs/tasks.md task 9), minus the `marketType` prop: this fork is
 * perps-only, so the original's `marketType === "perp" ? ... : 1` ternaries
 * for leverage collapse to always-perp behavior, and `LeverageSelector` is
 * always shown (no more conditional gate).
 */
export function BuyForm({
  tokenset,
  markets,
  masterAddress,
  agentApproved,
  onBought,
}: {
  tokenset: Tokenset;
  markets: Market[];
  masterAddress: Address;
  agentApproved: boolean;
  onBought: () => void;
}) {
  const { data: availableUsdc, refetch } = useAvailableFunds(masterAddress);
  const [amount, setAmount] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolved = useMemo(
    () => tokenset.markets.map((id) => markets.find((m) => m.market_id === id)).filter((m): m is Market => !!m),
    [tokenset.markets, markets],
  );
  const sizingInputs = useMemo(() => resolved.map(toSizingInput), [resolved]);
  const maxLeverage = sizingInputs.length > 0 ? Math.min(...sizingInputs.map((m) => m.maxLeverage)) : 1;
  const effectiveLeverage = Math.min(leverage, maxLeverage);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const { data: freshUsdc } = await refetch();
      const result = await executeBuy({
        masterAddress,
        tokensetId: tokenset.id,
        tokensetName: tokenset.name,
        markets: sizingInputs,
        usdcTotal: Number(amount),
        availableUsdc: freshUsdc ?? availableUsdc,
        leverage: effectiveLeverage,
      });
      if (!result.persisted) {
        setError("Bought, but couldn't save the position locally — do not retry.");
      } else if (result.partial) {
        setMessage(`Partial fill — ${result.failed.length} leg(s) didn't buy.`);
      } else {
        setMessage("Bought.");
      }
      setAmount("");
      onBought();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="buy-form" onSubmit={handleSubmit}>
      <input
        type="number"
        min="0"
        step="any"
        placeholder="USDC amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        disabled={!agentApproved || busy}
      />
      <LeverageSelector maxLeverage={maxLeverage} value={effectiveLeverage} onChange={setLeverage} />
      <button type="submit" disabled={!agentApproved || busy || !amount}>
        {busy ? "Buying…" : "Buy"}
      </button>
      {message && <p className="form-message">{message}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
