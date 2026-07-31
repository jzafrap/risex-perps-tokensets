import { useBookLiquidity } from "../hooks/useBookLiquidity";
import { formatPct, formatUsdCompact } from "../lib/format";
import { LiquidityBadge } from "./LiquidityBadge";

/** Per-market liquidity detail (spread/depth, badge) — RiseX port backed by
 * the now-confirmed `GET /v1/orderbook` endpoint (docs/tasks.md task 9). */
export function TokenLiquidityDetail({
  marketId,
  quoteVolume24h,
}: {
  marketId: string;
  quoteVolume24h: number;
}) {
  const { data, isLoading, isError } = useBookLiquidity(marketId, quoteVolume24h);

  if (isLoading) return <span className="liq-detail liq-detail--loading">…</span>;
  if (isError || !data) return <span className="liq-detail liq-detail--error">no book data</span>;

  return (
    <span className="liq-detail">
      <LiquidityBadge tier={data.tier} />
      <span className="liq-detail-spread">spread {formatPct(data.spreadPct)}</span>
      <span className="liq-detail-depth">depth ±2% {formatUsdCompact(data.depthUsd)}</span>
    </span>
  );
}
