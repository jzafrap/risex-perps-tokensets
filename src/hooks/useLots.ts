import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { loadLots, type BuyRecord } from "../lib/lots";

/** Loads a wallet's lots and re-syncs across browser tabs via the `storage`
 * event (same cross-tab pattern as the reference project; the known
 * cross-tab-write-race limitation carries over unchanged). */
export function useLots(wallet: Address | undefined) {
  const [lots, setLots] = useState<BuyRecord[]>([]);

  const refresh = useCallback(() => {
    setLots(wallet ? loadLots(wallet) : []);
  }, [wallet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [refresh]);

  return { lots, refresh };
}
