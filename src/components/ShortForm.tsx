import { useMemo, useState, type FormEvent } from "react";
import type { Address } from "viem";
import { useAvailableFunds } from "../hooks/useAvailableFunds";
import { executeShort } from "../lib/execute";
import type { Market } from "../lib/risex";
import { toSizingInput } from "../lib/sizing";
import type { Tokenset } from "../lib/tokensets";
import { LeverageSelector } from "./LeverageSelector";

/**
 * Open/increase a short — mirrors `BuyForm`; RiseX port of the reference
 * project's `ShortForm.tsx` (docs/tasks.md task 9). That component was
 * already effectively perps-only (shorts don't exist for spot), so the only
 * strip needed is the `marketType` prop — this fork mounts it unconditionally
 * alongside `BuyForm` for every tokenset (see `TokensetList`).
 */
export function ShortForm({
  tokenset,
  markets,
  masterAddress,
  agentApproved,
  onShorted,
}: {
  tokenset: Tokenset;
  markets: Market[];
  masterAddress: Address;
  agentApproved: boolean;
  onShorted: () => void;
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
      const result = await executeShort({
        masterAddress,
        tokensetId: tokenset.id,
        tokensetName: tokenset.name,
        markets: sizingInputs,
        usdcTotal: Number(amount),
        availableUsdc: freshUsdc ?? availableUsdc,
        leverage: effectiveLeverage,
      });
      if (!result.persisted) {
        setError("Shorted, but couldn't save the position locally — do not retry.");
      } else if (result.partial) {
        setMessage(`Partial fill — ${result.failed.length} leg(s) didn't fill.`);
      } else {
        setMessage("Shorted.");
      }
      setAmount("");
      onShorted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="short-form" onSubmit={handleSubmit}>
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
        {busy ? "Shorting…" : "Short"}
      </button>
      {message && <p className="form-message">{message}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
