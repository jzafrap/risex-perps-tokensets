import type { Address } from "viem";
import { useAvailableFunds } from "../hooks/useAvailableFunds";
import { formatUsd } from "../lib/format";

/** Shows the connected wallet's available USDC margin balance (RiseX's
 * cross-margin balance, `lib/balances.ts`). Previously only used internally
 * by `BuyForm`/`ShortForm` for the pre-trade funds guard — never displayed. */
export function FundsBalance({ address }: { address: Address }) {
  const { data, isLoading, isError } = useAvailableFunds(address);

  return (
    <div className="funds-balance">
      <span className="funds-balance-label">Available USDC (margin)</span>
      <span className="funds-balance-value">
        {isLoading ? "…" : isError ? "—" : formatUsd(data)}
      </span>
    </div>
  );
}
