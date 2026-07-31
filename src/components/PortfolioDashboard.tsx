import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import {
  aggregateTotals,
  computeLotPnl,
  isPriceStale,
  isSmallPosition,
  SMALL_POSITION_USD,
  type LotPnl,
} from "../lib/pnl";
import type { BuyRecord } from "../lib/lots";
import type { Market } from "../lib/risex";
import { formatPct, formatUsd } from "../lib/format";
import { SellForm } from "./SellForm";

const CLOCK_INTERVAL_MS = 15_000;

/**
 * Open positions + live P&L — RiseX port of the reference project's
 * `PortfolioDashboard.tsx` (docs/tasks.md task 9), minus `marketType`. The
 * original's `LeverageBadge` was guarded by `lot.marketType !== "perp"`
 * (return null for spot lots) — since this fork's `BuyRecord` has no
 * `marketType` field at all (dropped in `lib/lots.ts`), that guard is dead
 * code and has been deleted; the badge always renders.
 */
export function PortfolioDashboard({
  lots,
  markets,
  masterAddress,
  agentApproved,
  onSold,
  pricesUpdatedAt = 0,
  pricesError = false,
}: {
  lots: BuyRecord[];
  markets: Market[];
  masterAddress: Address;
  agentApproved: boolean;
  onSold: () => void;
  pricesUpdatedAt?: number;
  pricesError?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [hideSmall, setHideSmall] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const priceByMarket = useMemo(
    () => new Map(markets.map((m) => [m.market_id, Number(m.mark_price)])),
    [markets],
  );

  const openLots = lots.filter((l) => l.status !== "closed");
  const stale = isPriceStale(pricesUpdatedAt, now);

  const lotPnls: LotPnl[] = useMemo(
    () => openLots.map((lot) => computeLotPnl(lot, priceByMarket)),
    [openLots, priceByMarket],
  );

  const visible = hideSmall ? lotPnls.filter((p) => !isSmallPosition(p)) : lotPnls;
  const totals = aggregateTotals(visible);

  if (openLots.length === 0) {
    return <p className="portfolio-empty">No open positions.</p>;
  }

  return (
    <section className="portfolio-dashboard">
      <div className="portfolio-header">
        <h2>Portfolio</h2>
        <label>
          <input type="checkbox" checked={hideSmall} onChange={(e) => setHideSmall(e.target.checked)} />
          Hide positions under {formatUsd(SMALL_POSITION_USD)}
        </label>
      </div>

      {pricesError && <p className="error">Price feed error — P&amp;L may be inaccurate.</p>}
      {stale && !pricesError && <p className="warning">Prices are stale — P&amp;L may be out of date.</p>}

      <div className="portfolio-totals">
        <span>Value: {formatUsd(totals.valueUsd)}</span>
        <span>P&amp;L: {formatUsd(totals.pnlUsd)} ({formatPct(totals.pnlPct)})</span>
      </div>

      {visible.map(({ lot, legs, totals: lotTotals }) => (
        <div key={lot.id} className="lot-card">
          <div className="lot-card-header">
            <span className="lot-name">{lot.tokensetName}</span>
            <span className={`leverage-badge leverage-badge--${lot.side ?? "long"}`}>
              PERPS · {(lot.side ?? "long") === "short" ? "SELL" : "BUY"} {lot.leverage ?? 1}x
            </span>
            <span>{formatUsd(lotTotals.valueUsd)}</span>
            <span>
              {formatUsd(lotTotals.pnlUsd)} ({formatPct(lotTotals.pnlPct)})
            </span>
          </div>
          <ul className="lot-legs">
            {legs.map((leg) => (
              <li key={leg.marketId}>
                {leg.symbol}: {leg.qtyRemaining} @ {formatUsd(leg.avgEntryPrice)} →{" "}
                {formatUsd(leg.currentPrice)} ({formatPct(leg.pnlPct)})
                {leg.priceUnconfirmed && <em> (approx. cost basis)</em>}
              </li>
            ))}
          </ul>
          <SellForm lot={lot} markets={markets} masterAddress={masterAddress} agentApproved={agentApproved} onSold={onSold} />
        </div>
      ))}
    </section>
  );
}
