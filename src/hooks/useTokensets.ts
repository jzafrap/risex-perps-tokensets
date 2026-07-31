import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { ENV } from "../config/env";
import {
  addTokenset,
  loadTokensets,
  makeTokenset,
  removeTokenset as removeTokensetFromList,
  saveTokensets,
  type NewTokenset,
  type Tokenset,
} from "../lib/tokensets";

/** Tokenset CRUD for the connected wallet, persisted to localStorage
 * (network+wallet scoped). Perps-only, so no `marketType` dimension. */
export function useTokensets(wallet: Address | undefined) {
  const [tokensets, setTokensets] = useState<Tokenset[]>([]);

  useEffect(() => {
    setTokensets(wallet ? loadTokensets(wallet) : []);
  }, [wallet]);

  const create = useCallback(
    (input: NewTokenset): Tokenset => {
      if (!wallet) throw new Error("Connect a wallet first");
      const tokenset = makeTokenset(input, crypto.randomUUID(), Date.now());
      const next = addTokenset(tokensets, tokenset);
      saveTokensets(wallet, next);
      setTokensets(next);
      return tokenset;
    },
    [wallet, tokensets],
  );

  const remove = useCallback(
    (id: string) => {
      if (!wallet) return;
      const next = removeTokensetFromList(tokensets, id);
      saveTokensets(wallet, next);
      setTokensets(next);
    },
    [wallet, tokensets],
  );

  return { tokensets, create, remove, network: ENV.network };
}
