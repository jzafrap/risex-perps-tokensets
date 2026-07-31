import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { ENV } from "../config/env";
import { getAvailableFunds } from "../lib/balances";

/** Available margin (USDC) for the connected wallet — perps-only, so unlike
 * the reference project's `useAvailableFunds(address, marketType)` this drops
 * the market-type dimension entirely. */
export function useAvailableFunds(address: Address | undefined) {
  return useQuery({
    queryKey: ["availableFunds", ENV.network, address],
    queryFn: () => getAvailableFunds(address!),
    enabled: !!address,
    refetchInterval: 15_000,
  });
}
