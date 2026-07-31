/**
 * Display-only number formatting helpers — pure `Intl.NumberFormat` wrappers,
 * zero exchange-specific logic (ported conceptually from the reference
 * project's formatting helpers, docs/tasks.md task 9).
 */

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const decimals = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * RiseX's `change_24h` market field is an ABSOLUTE price delta (quote
 * currency), not a percentage — confirmed live (e.g. BTC `last_price:
 * 62783.5, change_24h: -2013.3`; a -2013.3% move is impossible, but a
 * $2013.30 24h drop fits the market's own `high_24h`/`low_24h` range).
 * Found after a UI bug showed "-1994%" for BTC — `formatPct` was being
 * called directly on the raw field instead of a computed percentage.
 * Computes the percentage against the price 24h ago (`lastPrice -
 * change24hAbs`), which is what `change_24h` was itself derived from.
 */
export function computeChangePct24h(lastPrice: number, change24hAbs: number): number | null {
  if (!Number.isFinite(lastPrice) || !Number.isFinite(change24hAbs)) return null;
  const price24hAgo = lastPrice - change24hAbs;
  if (price24hAgo === 0) return null;
  return (change24hAbs / price24hAgo) * 100;
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
