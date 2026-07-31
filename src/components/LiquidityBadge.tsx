import type { LiquidityTier } from "../lib/liquidity";

const LABEL: Record<LiquidityTier, string> = { high: "High", medium: "Medium", low: "Low" };

/** Dumb liquidity-tier badge — ported verbatim, no hooks/exchange logic. */
export function LiquidityBadge({ tier }: { tier: LiquidityTier }) {
  return <span className={`liq-badge liq-${tier}`}>{LABEL[tier]}</span>;
}
