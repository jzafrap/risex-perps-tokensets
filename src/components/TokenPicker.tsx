import { useMemo, useState } from "react";
import { useMarkets } from "../hooks/useMarkets";
import { volumeTier } from "../lib/liquidity";
import { formatPct, formatPrice, formatUsdCompact } from "../lib/format";
import type { Market } from "../lib/risex";
import { LiquidityBadge } from "./LiquidityBadge";

const MAX_ROWS = 80;

/** Market picker for composing a tokenset — RiseX port of the reference
 * project's `TokenPicker.tsx` (docs/tasks.md task 9), minus the `marketType`
 * prop (perps-only fork — always shows every RiseX market). */
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
        {filtered.map((m) => {
          const tier = volumeTier(Number(m.quote_volume_24h));
          const isSelected = selected.has(m.market_id);
          return (
            <label key={m.market_id} className="token-row">
              <input type="checkbox" checked={isSelected} onChange={() => onToggle(m)} />
              <span className="token-row-name">{m.display_name}</span>
              <span className="token-row-price">{formatPrice(Number(m.mark_price))}</span>
              <span className="token-row-change">{formatPct(Number(m.change_24h))}</span>
              <span className="token-row-volume">{formatUsdCompact(Number(m.quote_volume_24h))}</span>
              <LiquidityBadge tier={tier} />
            </label>
          );
        })}
      </div>
    </div>
  );
}
