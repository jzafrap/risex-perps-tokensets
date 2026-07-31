import type { Market } from "../lib/risex";
import { TokenLiquidityDetail } from "./TokenLiquidityDetail";

/** The basket-in-progress while composing a tokenset — dumb list renderer,
 * ported with the `marketType` prop dropped. */
export function SelectedBasket({
  markets,
  onRemove,
}: {
  markets: Market[];
  onRemove: (marketId: string) => void;
}) {
  if (markets.length === 0) {
    return <p className="selected-basket-empty">No markets selected yet.</p>;
  }

  return (
    <ul className="selected-basket">
      {markets.map((m) => (
        <li key={m.market_id}>
          <span>{m.display_name}</span>
          <TokenLiquidityDetail marketId={m.market_id} quoteVolume24h={Number(m.quote_volume_24h)} />
          <button type="button" onClick={() => onRemove(m.market_id)}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
