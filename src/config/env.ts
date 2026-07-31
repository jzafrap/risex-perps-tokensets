/**
 * Single environment switch for the whole app (see docs/design.md).
 *
 * All values below (API/WS URLs, EIP-712 domains) were verified with live
 * requests against RiseX's own API (docs/tasks.md task 0/2) — not copied from
 * docs prose. Note the testnet EIP-712 `name`/`verifyingContract` here differ
 * from an earlier (incorrect) doc-summary value recorded during the task-0
 * spike — the live `GET /v1/auth/eip712-domain` response is authoritative and
 * corrects it.
 *
 * Perps-only fork: unlike the Hyperliquid original, `storageNamespace` takes
 * no `marketType` param (docs/design.md "MarketType removal").
 */

export type RiseNetwork = "testnet" | "mainnet";

/** Read the desired network from the Vite env, defaulting to testnet-first. */
function resolveNetwork(): RiseNetwork {
  const raw = import.meta.env.VITE_RISE_NETWORK?.toLowerCase();
  return raw === "mainnet" ? "mainnet" : "testnet";
}

/**
 * RiseX's EIP-712 domain for account/session-key signing (docs/tasks.md task 0:
 * `GET /v1/auth/eip712-domain`). Testnet values are confirmed from that spike.
 * Mainnet values are explicitly NOT confirmed — `null` until fetched live.
 */
export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export interface NetworkConfig {
  network: RiseNetwork;
  isTestnet: boolean;
  /** RiseX REST API base URL. TODO — not yet confirmed for either network. */
  apiUrl: string;
  /** RiseX WebSocket URL for live market data. TODO — not yet confirmed. */
  wsUrl: string;
  /**
   * EIP-712 domain used to sign RiseX auth/order permits (docs/tasks.md task 0).
   * `null` means "not confirmed yet — fetch live before writing signing code."
   */
  eip712Domain: Eip712Domain | null;
  /**
   * RiseX's Router contract — the `target` field in a signed `VerifyWitness`
   * permit (docs/tasks.md task 6). Confirmed live via `GET /v1/system/config`'s
   * `addresses.router`.
   */
  routerAddress: `0x${string}`;
  /** Human label for the network banner. */
  label: string;
  /**
   * RiseX web app (for depositing/bridging USDC). Value from docs/design.md;
   * exact subdomain (rise.trade vs. app.rise.trade) not independently verified.
   */
  webAppUrl: string;
}

const CONFIGS: Record<RiseNetwork, NetworkConfig> = {
  testnet: {
    network: "testnet",
    isTestnet: true,
    // Confirmed live: curl https://api.testnet.rise.trade/v1/system/config
    apiUrl: "https://api.testnet.rise.trade",
    // Confirmed from developer.rise.trade's WebSocket connection reference.
    wsUrl: "wss://ws.testnet.rise.trade",
    // Confirmed live: curl https://api.testnet.rise.trade/v1/auth/eip712-domain
    eip712Domain: {
      name: "RISEx",
      version: "1",
      chainId: 11_155_931,
      verifyingContract: "0x6DA86F486b5E6536358F5b122dBe184522CA0eE3",
    },
    // Confirmed live: curl https://api.testnet.rise.trade/v1/system/config -> addresses.router
    routerAddress: "0x980b8621b8e03c3f396e1dc34c00b14d84f2a20f",
    label: "Testnet",
    webAppUrl: "https://rise.trade",
  },
  mainnet: {
    network: "mainnet",
    isTestnet: false,
    // Confirmed live: curl https://api.rise.trade/v1/system/config
    apiUrl: "https://api.rise.trade",
    // Confirmed from developer.rise.trade's WebSocket connection reference
    // (note: different domain than the REST API — risex.trade, not rise.trade).
    wsUrl: "wss://ws.risex.trade",
    // Confirmed live: curl https://api.rise.trade/v1/auth/eip712-domain
    // (previously flagged as the highest-risk unconfirmed value — now resolved).
    eip712Domain: {
      name: "RISEx",
      version: "1",
      chainId: 4153,
      verifyingContract: "0x0D919DAA3f12AE715744Eb648c00066c5DBd66f0",
    },
    // Confirmed live: curl https://api.rise.trade/v1/system/config -> addresses.router
    routerAddress: "0xaadde0cea454f2bcb26f46ed54c5709b7bb34a7e",
    label: "Mainnet",
    webAppUrl: "https://rise.trade",
  },
};

export const ENV: NetworkConfig = CONFIGS[resolveNetwork()];

/** Namespace for persisted data, scoped by network and wallet (perps-only — no marketType). */
export function storageNamespace(wallet: string): string {
  return `risex-tokensets:${ENV.network}:${wallet.toLowerCase()}`;
}
