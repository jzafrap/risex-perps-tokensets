import { useMemo, useState } from "react";
import { useMarkets } from "../hooks/useMarkets";
import { volumeTier } from "../lib/liquidity";
import { formatPct, formatPrice, formatUsdCompact } from "../lib/format";
import type { Market } from "../lib/risex";
import { LiquidityBadge } from "./LiquidityBadge";

const MAX_ROWS = 80;

/** Market picker for composing a tokenset — RiseX port of the reference
 * project's `TokenPicker.tsx` (docs/tasks.md task 9), minus the `marketType`
 * prop (perps-only fork — always shows every RiseX market). Rendered as a
 * table (not stacked rows) so price/change/volume line up in columns. */
export function TokenPicker({
  selected,
  onToggle,
}: {
  selected: Set<string>;
  onToggle: (market: Market) => void;
}) {
  const { data: markets, isLoading, isError } = useMarkets();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!markets) return [];
    const q = query.trim().toLowerCase();
    const list = q ? markets.filter((m) => m.display_name.toLowerCase().includes(q)) : markets;
    return list.slice(0, MAX_ROWS);
  }, [markets, query]);

  if (isLoading) return <p>Loading markets…</p>;
  if (isError || !markets) return <p className="error">Could not load RiseX markets.</p>;

  return (
    <div className="token-picker">
      <input
        type="text"
        placeholder="Search markets…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="token-picker-list">
        <table className="token-picker-table">
          <thead>
            <tr>
              <th aria-hidden="true"></th>
              <th>Market</th>
              <th>Price</th>
              <th>24h change</th>
              <th>24h volume</th>
              <th>Liquidity</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const tier = volumeTier(Number(m.quote_volume_24h));
              const isSelected = selected.has(m.market_id);
              const change = Number(m.change_24h);
              const inputId = `market-${m.market_id}`;
              return (
                <tr key={m.market_id}>
                  <td>
                    <input
                      type="checkbox"
                      id={inputId}
                      checked={isSelected}
                      onChange={() => onToggle(m)}
                    />
                  </td>
                  <td>
                    <label htmlFor={inputId}>{m.display_name}</label>
                  </td>
                  <td>{formatPrice(Number(m.mark_price))}</td>
                  <td className={change >= 0 ? "pnl-positive" : "pnl-negative"}>
                    {formatPct(change)}
                  </td>
                  <td>{formatUsdCompact(Number(m.quote_volume_24h))}</td>
                  <td>
                    <LiquidityBadge tier={tier} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
