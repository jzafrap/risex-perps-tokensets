import { getBalance } from "./risex";

/** Available margin (USDC) for opening/increasing positions — RiseX port of
 * the reference project's `lib/balances.ts` (docs/tasks.md task 9). Perps-only,
 * so there's no separate spot-vs-perp funds source to pick between. */
export async function getAvailableFunds(account: `0x${string}`): Promise<number> {
  const balance = await getBalance(account);
  const parsed = Number(balance);
  return Number.isFinite(parsed) ? parsed : 0;
}
