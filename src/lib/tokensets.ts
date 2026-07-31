import { storageNamespace } from "../config/env";

/**
 * Tokenset definitions and their persistence — ported verbatim from the
 * reference project's `lib/tokensets.ts` (docs/design.md, docs/tasks.md task 7),
 * minus the `marketType` param (perps-only fork).
 *
 * A tokenset is just a named basket of RiseX market symbols — no chain state.
 * Buy lots and P&L are layered on separately (`lib/lots.ts`, `lib/pnl.ts`).
 * Persistence is serverless: localStorage, scoped by network+wallet so
 * testnet and mainnet never mix.
 */

export interface Tokenset {
  id: string;
  name: string;
  /** RiseX market ids, e.g. ["1", "2"]. Resolved to markets at runtime. */
  markets: string[];
  createdAt: number;
}

export interface NewTokenset {
  name: string;
  markets: string[];
}

// --- Pure operations -------------------------------------------------------

export function normalizeName(name: string): string {
  return name.trim();
}

export function isNameTaken(list: Tokenset[], name: string): boolean {
  const target = normalizeName(name).toLowerCase();
  return list.some((t) => t.name.toLowerCase() === target);
}

/**
 * Build a validated Tokenset. `id` and `createdAt` are injected so this stays
 * pure and testable (the hook supplies crypto.randomUUID() / Date.now()).
 * Throws on empty name or empty market list; market ids are de-duplicated.
 */
export function makeTokenset(input: NewTokenset, id: string, createdAt: number): Tokenset {
  const name = normalizeName(input.name);
  if (!name) throw new Error("Tokenset name is required");
  const markets = [...new Set(input.markets)];
  if (markets.length === 0) throw new Error("Select at least one market");
  return { id, name, markets, createdAt };
}

/** Prepend a tokenset, rejecting duplicate names (case-insensitive). */
export function addTokenset(list: Tokenset[], tokenset: Tokenset): Tokenset[] {
  if (isNameTaken(list, tokenset.name)) {
    throw new Error(`A tokenset named "${tokenset.name}" already exists`);
  }
  return [tokenset, ...list];
}

export function removeTokenset(list: Tokenset[], id: string): Tokenset[] {
  return list.filter((t) => t.id !== id);
}

// --- Persistence (localStorage, network+wallet scoped) ---------------------

function storageKey(wallet: string): string {
  return `${storageNamespace(wallet)}:tokensets`;
}

export function loadTokensets(wallet: string): Tokenset[] {
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Tokenset[]) : [];
  } catch {
    return [];
  }
}

export function saveTokensets(wallet: string, list: Tokenset[]): void {
  try {
    localStorage.setItem(storageKey(wallet), JSON.stringify(list));
  } catch {
    // Ignore quota / unavailable storage — the in-memory list still works.
  }
}
