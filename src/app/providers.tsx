import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "../lib/wagmi";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Chain/market data is short-lived; refetch on focus keeps balances fresh.
      staleTime: 10_000,
      retry: 1,
    },
  },
});

/**
 * Perps-only fork: no MarketTypeProvider (the reference project's spot/perp
 * switch is dropped entirely, see docs/design.md "MarketType removal").
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
