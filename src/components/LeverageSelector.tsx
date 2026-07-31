const OPTIONS = [1, 2, 3];

/** Leverage picker, gated to the resolved asset's `maxLeverage` — options
 * above the cap are hidden, never silently clamped. Ported verbatim; always
 * shown now (no more `marketType === "perp"` gate around its usage — this
 * fork is perps-only). */
export function LeverageSelector({
  maxLeverage,
  value,
  onChange,
}: {
  maxLeverage: number;
  value: number;
  onChange: (leverage: number) => void;
}) {
  const options = OPTIONS.filter((lev) => lev <= maxLeverage);
  return (
    <div className="leverage-selector">
      {options.map((lev) => (
        <button
          key={lev}
          type="button"
          className={`leverage-btn${lev === value ? " active" : ""}`}
          onClick={() => onChange(lev)}
        >
          {lev}x
        </button>
      ))}
    </div>
  );
}
