import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { AgentApproval } from "./components/AgentApproval";
import { FundsBalance } from "./components/FundsBalance";
import { NetworkBanner } from "./components/NetworkBanner";
import { PortfolioDashboard } from "./components/PortfolioDashboard";
import { SelectedBasket } from "./components/SelectedBasket";
import { TokenPicker } from "./components/TokenPicker";
import { TokensetList } from "./components/TokensetList";
import { WalletConnect } from "./components/WalletConnect";
import { ENV } from "./config/env";
import { useAgent } from "./hooks/useAgent";
import { useLots } from "./hooks/useLots";
import { useMarkets } from "./hooks/useMarkets";
import { useTokensets } from "./hooks/useTokensets";
import type { Market } from "./lib/risex";

/** Compose a new tokenset from the market picker — local to `App`, mirrors
 * the reference project's `ComposeTokenset`, minus the `marketType` prop. */
function ComposeTokenset({ onCreate }: { onCreate: (input: { name: string; markets: string[] }) => void }) {
  const [selected, setSelected] = useState<Map<string, Market>>(new Map());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function toggle(market: Market) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(market.market_id)) next.delete(market.market_id);
      else next.set(market.market_id, market);
      return next;
    });
  }

  function handleCreate() {
    setError(null);
    try {
      onCreate({ name, markets: [...selected.keys()] });
      setName("");
      setSelected(new Map());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="compose-tokenset">
      <h2>Compose a tokenset</h2>
      <input
        type="text"
        placeholder="Tokenset name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <TokenPicker selected={new Set(selected.keys())} onToggle={toggle} />
      <SelectedBasket markets={[...selected.values()]} onRemove={(id) => setSelected((p) => {
        const next = new Map(p);
        next.delete(id);
        return next;
      })} />
      <button type="button" onClick={handleCreate} disabled={!name || selected.size === 0}>
        Create tokenset
      </button>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export default function App() {
  const { address, isConnected } = useAccount();
  const { isApproved } = useAgent();
  const { data: markets, dataUpdatedAt, isError: marketsError } = useMarkets();
  const { tokensets, create, remove } = useTokensets(address);
  const { lots, refresh: refreshLots } = useLots(address);

  const marketsList = useMemo(() => markets ?? [], [markets]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>RiseX Perps Tokensets</h1>
        <div>
          <NetworkBanner />
          <WalletConnect />
        </div>
      </header>

      <main className="app-main">
        {isConnected && address ? (
          <>
            <FundsBalance address={address} />
            <AgentApproval />
            <ComposeTokenset onCreate={create} />
            <TokensetList
              tokensets={tokensets}
              markets={marketsList}
              masterAddress={address}
              agentApproved={isApproved}
              onDelete={remove}
              onChanged={refreshLots}
            />
            <PortfolioDashboard
              lots={lots}
              markets={marketsList}
              masterAddress={address}
              agentApproved={isApproved}
              onSold={refreshLots}
              pricesUpdatedAt={dataUpdatedAt}
              pricesError={marketsError}
            />
          </>
        ) : (
          <p>Connect a wallet to compose tokensets and trade perps on RiseX.</p>
        )}
      </main>

      <footer className="app-footer">
        {ENV.label} —{" "}
        <a href={ENV.webAppUrl} target="_blank" rel="noreferrer">
          {ENV.webAppUrl}
        </a>
      </footer>
    </div>
  );
}
