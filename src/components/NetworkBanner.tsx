import { ENV } from "../config/env";

/** Visible network indicator (testnet/mainnet) — ported verbatim; drives off
 * `ENV` only, no hooks/props. */
export function NetworkBanner() {
  return (
    <div className={`network-banner network-banner--${ENV.network}`}>
      RiseX — <strong>{ENV.label}</strong>
      {ENV.isTestnet && <span> (test funds only — no real value)</span>}
    </div>
  );
}
