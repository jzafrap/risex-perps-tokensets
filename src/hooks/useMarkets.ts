import { useQuery } from "@tanstack/react-query";
import { ENV } from "../config/env";
import { getMarkets } from "../lib/risex";

/** All RiseX markets — perps-only, so unlike the reference project's
 * `useMarkets(marketType)` this takes no argument. */
export function useMarkets() {
  return useQuery({
    queryKey: ["markets", ENV.network],
    queryFn: getMarkets,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
