import { useQuery } from "@tanstack/react-query";
import { ENV } from "../config/env";
import { depthWithinPct, midFromBook, spreadPct, volumeTier, worstTier, type LiquidityTier } from "../lib/liquidity";
import { getOrderbook } from "../lib/risex";

const DEPTH_BAND_PCT = 2;

/** Order-book-derived liquidity for one market — now backed by the real
 * `GET /v1/orderbook` endpoint (docs/tasks.md task 9 resolved task 3's
 * earlier gap; the endpoint path was found by reading `risex-client`'s
 * source, not by further guessing). */
export function useBookLiquidity(marketId: string, quoteVolume24h: number) {
  return useQuery({
    queryKey: ["bookLiquidity", ENV.network, marketId],
    queryFn: async () => {
      const book = await getOrderbook(Number(marketId));
      const spread = spreadPct(book);
      const tier: LiquidityTier = worstTier(volumeTier(quoteVolume24h), spread);
      return {
        mid: midFromBook(book),
        spreadPct: spread,
        depthUsd: depthWithinPct(book, DEPTH_BAND_PCT),
        tier,
      };
    },
    staleTime: 15_000,
  });
}
