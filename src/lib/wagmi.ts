import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected } from "wagmi/connectors";

/**
 * RISE Chain definitions (RiseX's underlying EVM chain — see docs/design.md).
 *
 * All values below were verified live (docs/tasks.md task 0/2), not copied from
 * docs prose:
 * - Chain ids confirmed via `eth_chainId` against the RPC URLs themselves.
 * - RPC URLs confirmed via `GET https://api.{testnet.,}rise.trade/v1/system/config`
 *   (mainnet) and cross-referenced with chainlist/RISE's own docs (testnet, whose
 *   `system/config` returns an empty `rpc_endpoints` array).
 */
export const riseTestnet = defineChain({
  id: 11_155_931,
  name: "Rise Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://testnet.riselabs.xyz"],
    },
  },
  testnet: true,
});

export const riseMainnet = defineChain({
  id: 4153,
  name: "RISE",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.risechain.com"],
    },
  },
});

/**
 * wagmi config for wallet connection.
 *
 * The injected connector covers both Rabby and MetaMask. RiseX's actual
 * signing flow (API Wallet registration + per-order permits, see docs/tasks.md
 * task 0) is implemented in later tasks (`lib/agent.ts` port) — this file
 * only wires up the chain(s) so the wallet has a valid domain to connect to
 * and sign against.
 */
export const wagmiConfig = createConfig({
  chains: [riseMainnet, riseTestnet],
  connectors: [injected()],
  transports: {
    [riseMainnet.id]: http(),
    [riseTestnet.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
