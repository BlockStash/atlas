import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  formatUnits,
  keccak256,
  stringToHex,
  isHex,
  type Address,
  type Abi,
  encodeFunctionData,
} from "viem";
import {
  LayoutDashboard,
  Globe2,
  Layers3,
  LineChart,
  ShieldCheck,
  Wallet,
  ArrowUpRight,
  RefreshCw,
  Plus,
  LockKeyhole,
  ChevronDown,
  Activity,
  Copy,
  ExternalLink,
} from "lucide-react";
import {
  client,
  abis,
  marketAbi,
  read,
  readCountry,
  write,
  amount,
  message,
  injected,
  roles,
  isAddress,
  zeroAddress,
  rpc,
  type Config,
  type Country,
  type State,
  type Stock,
  type Role,
  type Tx,
} from "./protocol";
import "./style.css";
const tabs = [
  "Overview",
  "Stocks",
  "Price feeds",
  "Treasury",
  "Access",
  "Upgrades",
] as const;
type Tab = (typeof tabs)[number];
const symbols: Record<string, string> = {
  india: "IN",
  usa: "US",
  uk: "UK",
  singapore: "SG",
  europe: "EU",
};
const fmt = (n: bigint, d = 8, digits = 4) =>
  Number(formatUnits(n, d)).toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const hash = (s: string) => keccak256(stringToHex(s));
const explorer = (address: string) =>
  `https://sepolia.etherscan.io/address/${address}`;
function AddressLink({ address }: { address: string }) {
  return (
    <span className="address">
      <a href={explorer(address)} target="_blank" rel="noreferrer">
        {short(address)}
        <ArrowUpRight size={12} />
      </a>
      <button
        className="icon"
        aria-label="Copy address"
        onClick={() => void navigator.clipboard.writeText(address)}
      >
        <Copy size={12} />
      </button>
    </span>
  );
}
function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
function App() {
  const [config, setConfig] = useState<Config | null>(null),
    [region, setRegion] = useState("india"),
    [account, setAccount] = useState<Address>(zeroAddress),
    [data, setData] = useState<State | null>(null),
    [tab, setTab] = useState<Tab>("Overview"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [tx, setTx] = useState<Tx | null>(null),
    [clock, setClock] = useState(0);
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState(""),
    [native, setNative] = useState(""),
    [fx, setFx] = useState(""),
    [usdt, setUsdt] = useState(""),
    [recipient, setRecipient] = useState(""),
    [tokenAmount, setTokenAmount] = useState(""),
    [role, setRole] = useState<Role>("STOCK_ADMIN_ROLE"),
    [roleAccount, setRoleAccount] = useState(""),
    [newOwner, setNewOwner] = useState(""),
    [candidate, setCandidate] = useState(""),
    [ack, setAck] = useState(false),
    [maxAge, setMaxAge] = useState("900"),
    [batch, setBatch] = useState(""),
    [form, setForm] = useState({
      ticker: "",
      companyName: "",
      country: "",
      exchange: "",
      priceFeedId: "",
    }),
    [treasury, setTreasury] = useState<{
      balance: bigint;
      canMint: boolean;
      admin: boolean;
    } | null>(null),
    [transfers, setTransfers] = useState<
      { hash: string; from: string; to: string; value: bigint }[]
    >([]),
    [ticks, setTicks] = useState<
      { timestamp: number; usd_price: string; usdt_price: string | null }[]
    >([]);
  const sequence = useRef(0);
  const country = config?.countries.find((c) => c.region === region);
  const owner =
    !!data &&
    account !== zeroAddress &&
    data.owner.toLowerCase() === account.toLowerCase();
  const allowed = (r: Role) =>
    owner || data?.roles.ADMIN_ROLE === true || data?.roles[r] === true;
  const stock =
    data?.stocks.find((s) => s.stockId === selected) ?? data?.stocks[0];
  const fresh = (s: Stock) =>
    s.active && s.price !== null && s.validUntil >= clock;
  const load = useCallback(async () => {
    if (!country) return;
    const current = ++sequence.current;
    setLoading(true);
    try {
      const value = await readCountry(country, account);
      if (current === sequence.current) {
        setData(value);
        setError("");
        setMaxAge(String(value.maxAge));
      }
    } catch (e) {
      if (current === sequence.current) setError(message(e));
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [country, account]);
  useEffect(() => {
    fetch("/api/protocol/config")
      .then((r) => {
        if (!r.ok)
          throw Error("The backend configuration endpoint is unavailable.");
        return r.json();
      })
      .then(setConfig)
      .catch((e) => {
        setError(message(e));
        setLoading(false);
      });
  }, []);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    const tick = () => setClock(Math.floor(Date.now() / 1000));
    tick();
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const p = injected();
    const changed = () => {
      setAccount(zeroAddress);
      setData(null);
      setTreasury(null);
      setError("Wallet changed. Reconnect before sending transactions.");
    };
    p?.on?.("accountsChanged", changed);
    p?.on?.("chainChanged", changed);
    return () => {
      p?.removeListener?.("accountsChanged", changed);
      p?.removeListener?.("chainChanged", changed);
    };
  }, []);
  useEffect(() => {
    setSelected("");
    setNative("");
    setFx("");
    setUsdt("");
    setTicks([]);
  }, [region]);
  useEffect(() => {
    if (data?.usdt[0])
      setUsdt((current) => current || formatUnits(data.usdt[0], 8));
  }, [data?.usdt[0], region]);
  useEffect(() => {
    if (!stock) return;
    let active = true;
    fetch(`/api/protocol/history/${stock.stockId}`)
      .then((r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then((r) => {
        if (active) setTicks([...r.history].reverse());
      })
      .catch(() => {
        if (active) setTicks([]);
      });
    return () => {
      active = false;
    };
  }, [stock?.stockId, data]);
  async function connect() {
    setError("");
    try {
      const p = injected();
      if (!p)
        throw Error("Install MetaMask or another injected Ethereum wallet.");
      const accounts = (await p.request({
        method: "eth_requestAccounts",
      })) as Address[];
      try {
        await p.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0xaa36a7" }],
        });
      } catch (e) {
        if ((e as { code?: number }).code !== 4902) throw e;
        await p.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0xaa36a7",
              chainName: "Sepolia",
              nativeCurrency: {
                name: "Sepolia ETH",
                symbol: "ETH",
                decimals: 18,
              },
              rpcUrls: [rpc],
              blockExplorerUrls: ["https://sepolia.etherscan.io"],
            },
          ],
        });
      }
      setAccount(accounts[0] ?? zeroAddress);
    } catch (e) {
      setError(message(e));
    }
  }
  async function run(work: () => Promise<unknown>) {
    if (account === zeroAddress) {
      setError("Connect your wallet first.");
      return;
    }
    setBusy(true);
    setError("");
    setTx(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError(message(e));
      setTx((t) =>
        t && t.status !== "confirmed" ? { ...t, status: "failed" } : t,
      );
    } finally {
      setBusy(false);
    }
  }
  const send = (name: string, args: readonly unknown[] = []) => {
    if (!country) throw Error("Select a configured country market.");
    return write(country.address, name, args, account, setTx);
  };
  async function onboard(useBatch = false) {
    await run(async () => {
      let entries: (typeof form)[];
      try {
        entries = useBatch ? JSON.parse(batch) : [form];
      } catch {
        throw Error("Enter a valid JSON array of stock metadata.");
      }
      if (!Array.isArray(entries) || !entries.length || entries.length > 100)
        throw Error("Onboard between 1 and 100 stocks per transaction.");
      const inputs = entries.map((s) => {
        const ticker = s.ticker?.trim().toUpperCase(),
          exchange = s.exchange?.trim(),
          name = s.companyName?.trim(),
          countryCode = s.country?.trim().toUpperCase(),
          feed = s.priceFeedId?.trim();
        if (
          !ticker ||
          ticker.length > 24 ||
          !name ||
          name.length > 100 ||
          !exchange ||
          exchange.length > 40 ||
          !/^[A-Z]{2}$/.test(countryCode) ||
          !feed
        )
          throw Error(
            "Each stock needs a ticker, company, two-letter country, exchange and price feed ID.",
          );
        return {
          stockId: hash(`${region}:${exchange}:${ticker}`),
          ticker,
          companyName: name,
          country: stringToHex(countryCode),
          exchange,
          priceFeedId: isHex(feed) && feed.length === 66 ? feed : hash(feed),
        };
      });
      await send("onboardStocks", [inputs]);
      setForm({
        ticker: "",
        companyName: "",
        country: "",
        exchange: "",
        priceFeedId: "",
      });
      setBatch("");
    });
  }
  async function publish() {
    await run(async () => {
      if (!stock || !country) throw Error("Choose a stock.");
      const head = await client.getBlockNumber();
      const block = await client.getBlock({
        blockNumber: head > 2n ? head - 2n : head,
      });
      await send("publishPrices", [
        [{ stockId: stock.stockId, nativePrice: amount(native) }],
        amount(fx || formatUnits(data!.fx[0], 8)),
        amount(usdt),
        block.timestamp,
        block.timestamp + BigInt(data!.maxAge),
      ]);
    });
  }
  async function market(open: boolean) {
    await run(async () => {
      const timestamp = (await client.getBlock()).timestamp;
      await send("setMarket", [true, open, timestamp + 82800n]);
    });
  }
  async function roleChange(grant: boolean) {
    await run(async () => {
      if (!isAddress(roleAccount) || roleAccount === zeroAddress)
        throw Error("Enter a valid nonzero address.");
      await send(grant ? "grantRole" : "revokeRole", [hash(role), roleAccount]);
    });
  }
  async function loadTreasury() {
    if (!config) return;
    const abi = abis.AtlasUSDT as Abi;
    const [balance, canMint, admin] = await Promise.all([
      read(config.atlasUSDT, "balanceOf", [account], abi),
      read(
        config.atlasUSDT,
        "hasRole",
        [hash("MINTER_ROLE"), account],
        abi,
      ).catch(() => false),
      read(
        config.atlasUSDT,
        "hasRole",
        [`0x${"0".repeat(64)}`, account],
        abi,
      ).catch(() => false),
    ]);
    setTreasury({
      balance: balance as bigint,
      canMint: canMint === true,
      admin: admin === true,
    });
    const latest = await client.getBlockNumber();
    const logs = await client.getLogs({
      address: config.atlasUSDT,
      event: {
        type: "event",
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256" },
        ],
      },
      fromBlock: latest > 499n ? latest - 499n : 0n,
      toBlock: latest,
    });
    setTransfers(
      logs
        .slice(-30)
        .reverse()
        .map((l) => ({
          hash: l.transactionHash,
          from: l.args.from!,
          to: l.args.to!,
          value: l.args.value!,
        })),
    );
  }
  useEffect(() => {
    if (tab === "Treasury")
      void loadTreasury().catch((e) => setError(message(e)));
  }, [tab, account, config]);
  async function distribute(kind: "mint" | "transfer") {
    await run(async () => {
      if (!config || !isAddress(recipient) || recipient === zeroAddress)
        throw Error("Enter a valid recipient.");
      await write(
        config.atlasUSDT,
        kind,
        [recipient, amount(tokenAmount, 6)],
        account,
        setTx,
        abis.AtlasUSDT as Abi,
      );
      await loadTreasury();
    });
  }
  async function upgrade() {
    await run(async () => {
      if (!owner || !isAddress(candidate) || !ack)
        throw Error(
          "Owner access, an implementation address and storage validation confirmation are required.",
        );
      const code = await client.getCode({ address: candidate });
      if (!code || code === "0x")
        throw Error("The new implementation address has no contract code.");
      const uuid = await read(candidate, "proxiableUUID");
      if (
        uuid !==
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
      )
        throw Error("The candidate is not a UUPS implementation.");
      await send("upgradeToAndCall", [candidate, "0x"]);
      setCandidate("");
      setAck(false);
    });
  }
  const liveCount = data?.stocks.filter(fresh).length ?? 0;
  const chart = ticks.map((t) => Number(t.usdt_price ?? t.usd_price) / 1e8),
    low = Math.min(...chart),
    high = Math.max(...chart),
    range = high - low || 1;
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/">
          <div className="brand-icon">
            <Globe2 size={24} />
          </div>
          <div>
            Market Control<small>COUNTRY OPERATIONS</small>
          </div>
        </a>
        <div className="workspace">MANAGEMENT WORKSPACE</div>
        <nav>
          {tabs.map((name, i) => {
            const Icon = [
              LayoutDashboard,
              Layers3,
              LineChart,
              Wallet,
              ShieldCheck,
              LockKeyhole,
            ][i];
            return (
              <button
                key={name}
                className={tab === name ? "selected" : ""}
                onClick={() => setTab(name)}
              >
                <Icon size={18} />
                {name}
                {tab === name && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="network">
            <span />
            Sepolia testnet
          </div>
          <p>
            Five markets. One control plane.
            <br />
            Demo synthetic assets.
          </p>
          <a href="http://127.0.0.1:3000" target="_blank" rel="noreferrer">
            Open investor application
            <ArrowUpRight size={14} />
          </a>
        </div>
      </aside>
      <div className="workspace-main">
        <header>
          <div className="breadcrumb">
            Operations <span>/</span> {tab}
          </div>
          <div className="header-actions">
            <span className="testnet">
              <span /> SEPOLIA
            </span>
            <button className="wallet-button" onClick={() => void connect()}>
              <Wallet size={15} />
              {account === zeroAddress ? "Connect wallet" : short(account)}
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">GLOBAL MARKETS INFRASTRUCTURE</div>
              <h1>{tab === "Overview" ? "Country operations" : tab}</h1>
              <p>
                Manage stock assets, pricing and permissions in one market
                contract.
              </p>
            </div>
            <button
              className="button secondary"
              disabled={loading || busy || !country}
              onClick={() => void load()}
            >
              <RefreshCw size={15} className={loading ? "spin" : ""} />
              Refresh state
            </button>
          </div>
          <section className="country-selector">
            {(
              config?.countries ?? [
                { region: "india", label: "India", currency: "INR" },
                { region: "usa", label: "United States", currency: "USD" },
                { region: "uk", label: "United Kingdom", currency: "GBP" },
                { region: "singapore", label: "Singapore", currency: "SGD" },
                { region: "europe", label: "Europe", currency: "EUR" },
              ]
            ).map((c) => (
              <button
                key={c.region}
                className={region === c.region ? "active" : ""}
                disabled={busy}
                onClick={() => {
                  setRegion(c.region);
                  setData(null);
                  setError("");
                  setTx(null);
                }}
              >
                <span className={`country-mark ${c.region}`}>
                  {symbols[c.region]}
                </span>
                <span>
                  {c.label}
                  <small>{c.currency} MARKET</small>
                </span>
                {region === c.region && <span className="country-dot" />}
              </button>
            ))}
          </section>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {tx && (
            <div
              className={`notice ${tx.status === "failed" ? "error" : "transaction"}`}
              role="status"
            >
              <Activity size={16} />
              <span>
                {tx.label} ·{" "}
                {tx.status === "signature"
                  ? "Review in your wallet"
                  : tx.status === "submitted"
                    ? "Submitted; waiting for confirmation"
                    : tx.status === "confirmed"
                      ? "Confirmed"
                      : "Failed or not confirmed"}
              </span>
              {tx.hash && (
                <a
                  href={`https://sepolia.etherscan.io/tx/${tx.hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction
                  <ExternalLink size={13} />
                </a>
              )}
            </div>
          )}
          {!config?.configured ? (
            <section className="panel setup">
              <Globe2 size={36} />
              <h2>Connect your country deployment</h2>
              <p>
                {config?.message ||
                  "Loading the deployment configuration from the Atlas backend…"}
              </p>
              <p>
                Deploy the five upgradeable market proxies, configure the
                backend’s v2 deployment manifest, then reload this page. This
                dashboard runs independently from the investor app.
              </p>
            </section>
          ) : !data ? (
            <section className="panel setup">
              <RefreshCw className={loading ? "spin" : ""} />
              <h2>
                {loading ? "Reading market state…" : "Market state unavailable"}
              </h2>
              <button className="button" onClick={() => void load()}>
                Try again
              </button>
            </section>
          ) : (
            <>
              <div className="market-banner">
                <div>
                  <span className="section-tag">
                    {country?.label.toUpperCase()} MARKET CONTRACT
                  </span>
                  <AddressLink address={country!.address} />
                  <span className="badge">ERC-1155 · UUPS v{data.version}</span>
                </div>
                <div
                  className={`status ${data.paused ? "warning" : data.open && data.enabled && data.marketUntil >= clock ? "positive" : "muted"}`}
                >
                  <span />
                  {data.paused
                    ? "Paused"
                    : data.open && data.enabled && data.marketUntil >= clock
                      ? "Market open"
                      : "Market closed / expired"}
                </div>
              </div>
              {tab === "Overview" && (
                <>
                  <div className="metrics">
                    <Metric
                      label="REGISTERED STOCKS"
                      value={String(data.stocks.length)}
                      note="One contract. Multiple stock IDs."
                    />
                    <Metric
                      label="FRESH PRICE FEEDS"
                      value={`${liveCount} / ${data.stocks.length}`}
                      note="Native + FX + USDT observations"
                    />
                    <Metric
                      label="NATIVE CURRENCY / USD"
                      value={
                        data.fx[0] ? fmt(data.fx[0], 8, 8) : "Not published"
                      }
                      note={`USD per ${country?.currency}`}
                    />
                    <Metric
                      label="USDT / USD"
                      value={
                        data.usdt[0]
                          ? `$${fmt(data.usdt[0], 8, 6)}`
                          : "Not published"
                      }
                      note="Tracks USDT’s dollar price"
                    />
                  </div>
                  <div className="two-column">
                    <section className="panel">
                      <div className="panel-title">
                        <h2>Market assets</h2>
                        <button
                          className="text-button"
                          onClick={() => setTab("Stocks")}
                        >
                          Manage assets
                          <ArrowUpRight size={14} />
                        </button>
                      </div>
                      <StockTable
                        rows={data.stocks.slice(0, 7)}
                        fresh={fresh}
                      />
                      {!data.stocks.length && (
                        <p className="empty">
                          Onboard the first stock to start this market.
                        </p>
                      )}
                    </section>
                    <div className="stack">
                      <section className="panel">
                        <div className="panel-title">
                          <h2>Control & ownership</h2>
                          <ShieldCheck size={17} />
                        </div>
                        <dl>
                          <dt>Contract owner</dt>
                          <dd>
                            <AddressLink address={data.owner} />
                          </dd>
                          <dt>Your access</dt>
                          <dd>
                            {owner
                              ? "Owner"
                              : data.roles.ADMIN_ROLE
                                ? "Delegated admin"
                                : Object.entries(data.roles).filter(
                                      ([, yes]) => yes,
                                    ).length
                                  ? "Scoped operator"
                                  : "Read only"}
                          </dd>
                          <dt>Trading engine</dt>
                          <dd>
                            <AddressLink address={data.engine} />
                          </dd>
                          <dt>Maximum price age</dt>
                          <dd>{data.maxAge} seconds</dd>
                        </dl>
                        <div className="subtle-note">
                          Owners control upgrades and access. Delegated
                          operators manage only their authorized functions.
                        </div>
                      </section>
                      <section className="panel">
                        <div className="panel-title">
                          <h2>Market session</h2>
                          <Activity size={17} />
                        </div>
                        <p className="muted-copy">
                          Open status expires{" "}
                          {data.marketUntil
                            ? new Date(data.marketUntil * 1000).toLocaleString()
                            : "when configured"}
                          . Renew before expiry.
                        </p>
                        <div className="button-row">
                          <button
                            className="button"
                            disabled={busy || !allowed("MARKET_ADMIN_ROLE")}
                            onClick={() => void market(true)}
                          >
                            Open / renew
                          </button>
                          <button
                            className="button secondary"
                            disabled={busy || !allowed("MARKET_ADMIN_ROLE")}
                            onClick={() => void market(false)}
                          >
                            Close market
                          </button>
                        </div>
                        <div className="divider" />
                        <button
                          className="button secondary full"
                          disabled={busy || !allowed("PAUSER_ROLE")}
                          onClick={() =>
                            void run(() =>
                              send(data.paused ? "unpause" : "pause"),
                            )
                          }
                        >
                          {data.paused
                            ? "Unpause market"
                            : "Pause trading & token transfers"}
                        </button>
                      </section>
                    </div>
                  </div>
                </>
              )}
              {tab === "Stocks" && (
                <>
                  <section className="panel">
                    <div className="panel-title">
                      <h2>
                        Stock registry{" "}
                        <span className="count">{data.stocks.length}</span>
                      </h2>
                      <input
                        className="search"
                        placeholder="Search ticker or company"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                    <StockTable
                      rows={data.stocks.filter((s) =>
                        `${s.ticker} ${s.companyName}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )}
                      fresh={fresh}
                      toggle={(s) =>
                        void run(() =>
                          send("setStockActive", [s.stockId, !s.active]),
                        )
                      }
                      disabled={busy || !allowed("STOCK_ADMIN_ROLE")}
                    />
                  </section>
                  <div className="two-column">
                    <section className="panel">
                      <div className="panel-title">
                        <h2>Onboard a stock</h2>
                        <Plus size={17} />
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void onboard();
                        }}
                      >
                        <div className="form-grid">
                          {Object.entries(form).map(([key, value]) => (
                            <label key={key}>
                              {
                                (
                                  {
                                    ticker: "Ticker",
                                    companyName: "Company name",
                                    country: "Country code (2 letters)",
                                    exchange: "Exchange",
                                    priceFeedId: "Price feed identifier",
                                  } as Record<string, string>
                                )[key]
                              }
                              <input
                                required
                                value={value}
                                onChange={(e) =>
                                  setForm({ ...form, [key]: e.target.value })
                                }
                                placeholder={
                                  key === "country"
                                    ? symbols[region] === "UK"
                                      ? "GB"
                                      : symbols[region]
                                    : key === "priceFeedId"
                                      ? "provider:exchange:ticker"
                                      : ""
                                }
                              />
                            </label>
                          ))}
                        </div>
                        <p className="subtle-note">
                          Creates a stock ID inside this contract. No new
                          contract is deployed. Publish a price before enabling
                          trades.
                        </p>
                        <button
                          className="button"
                          disabled={busy || !allowed("STOCK_ADMIN_ROLE")}
                        >
                          <Plus size={15} />
                          Onboard stock
                        </button>
                      </form>
                    </section>
                    <section className="panel">
                      <h2>Batch onboarding</h2>
                      <p className="muted-copy">
                        Add up to 100 stocks in a single transaction. Existing
                        IDs and exchange/ticker combinations are rejected.
                      </p>
                      <label>
                        JSON stock metadata
                        <textarea
                          rows={10}
                          value={batch}
                          onChange={(e) => setBatch(e.target.value)}
                          placeholder={
                            '[{"ticker":"NEW","companyName":"Example","country":"US","exchange":"NASDAQ","priceFeedId":"provider:NEW"}]'
                          }
                        />
                      </label>
                      <button
                        className="button secondary"
                        disabled={
                          busy || !allowed("STOCK_ADMIN_ROLE") || !batch
                        }
                        onClick={() => void onboard(true)}
                      >
                        Onboard batch
                      </button>
                    </section>
                  </div>
                </>
              )}
              {tab === "Price feeds" && (
                <div className="two-column">
                  <section className="panel">
                    <div className="panel-title">
                      <h2>Publish a price observation</h2>
                      <LineChart size={18} />
                    </div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void publish();
                      }}
                    >
                      <label>
                        Stock
                        <select
                          value={stock?.stockId || ""}
                          onChange={(e) => {
                            setSelected(e.target.value);
                            setNative("");
                          }}
                        >
                          {data.stocks.map((s) => (
                            <option key={s.stockId} value={s.stockId}>
                              {s.ticker} · {s.companyName}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="form-grid">
                        <label>
                          Native stock price ({country?.currency})
                          <input
                            required
                            value={native}
                            onChange={(e) => setNative(e.target.value)}
                            inputMode="decimal"
                            placeholder={
                              stock ? formatUnits(stock.native, 8) : "0.00"
                            }
                          />
                        </label>
                        <label>
                          USD per {country?.currency}
                          <input
                            value={fx}
                            onChange={(e) => setFx(e.target.value)}
                            inputMode="decimal"
                            placeholder={formatUnits(data.fx[0], 8)}
                          />
                        </label>
                        <label>
                          USD per USDT
                          <input
                            required
                            value={usdt}
                            onChange={(e) => setUsdt(e.target.value)}
                            inputMode="decimal"
                          />
                        </label>
                      </div>
                      <div className="formula">
                        Native × USD/native ÷ USD/USDT{" "}
                        <span>= stock price in USDT</span>
                      </div>
                      <p className="subtle-note">
                        Publishes the stock, FX and USDT quote atomically.
                        Prices expire after {data.maxAge} seconds. GBP inputs
                        must be in pounds, not pence.
                      </p>
                      <button
                        className="button"
                        disabled={
                          busy || !allowed("PRICE_UPDATER_ROLE") || !stock
                        }
                      >
                        Publish observation
                      </button>
                    </form>
                    <div className="divider" />
                    <h3>Automated price updates</h3>
                    <p className="muted-copy">
                      The backend price service can ingest a configured HTTP
                      provider and refresh each market every minute. Demo mode
                      publishes illustrative fixtures; it is not a live exchange
                      feed.
                    </p>
                  </section>
                  <div className="stack">
                    <section className="panel">
                      <h2>{stock?.ticker || "Stock"} · current valuation</h2>
                      <dl>
                        <dt>Native price</dt>
                        <dd>
                          {stock ? fmt(stock.native) : "—"} {country?.currency}
                        </dd>
                        <dt>USD value</dt>
                        <dd>
                          {stock?.usd != null
                            ? `$${fmt(stock.usd)}`
                            : "Unavailable"}
                        </dd>
                        <dt>USDT value</dt>
                        <dd>
                          {stock && fresh(stock)
                            ? `${fmt(stock.price!)} USDT`
                            : "Stale / not published"}
                        </dd>
                        <dt>Last observation</dt>
                        <dd>
                          {stock?.updatedAt
                            ? new Date(stock.updatedAt * 1000).toLocaleString()
                            : "None"}
                        </dd>
                      </dl>
                      <div className="chart">
                        {ticks.length ? (
                          <svg
                            viewBox="0 0 400 110"
                            role="img"
                            aria-label="Recorded price observations"
                          >
                            <polyline
                              points={chart
                                .map(
                                  (v, i) =>
                                    `${chart.length === 1 ? 200 : 10 + (i * 380) / (chart.length - 1)},${95 - ((v - low) / range) * 80}`,
                                )
                                .join(" ")}
                              fill="none"
                              stroke="#85aaff"
                              strokeWidth="2.5"
                            />
                            {chart.length === 1 && (
                              <circle cx="200" cy="95" r="3" fill="#85aaff" />
                            )}
                          </svg>
                        ) : (
                          <p>No recorded price history yet.</p>
                        )}
                      </div>
                      <small className="muted-copy">
                        Recorded offchain observations, not a forecast.
                      </small>
                    </section>
                    <section className="panel">
                      <h2>Freshness configuration</h2>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(() => {
                            const n = Number(maxAge);
                            if (!Number.isInteger(n) || n < 30 || n > 86400)
                              throw Error("Use 30–86,400 seconds.");
                            return send("setMaxPriceAge", [BigInt(n)]);
                          });
                        }}
                      >
                        <label>
                          Maximum age (seconds)
                          <input
                            value={maxAge}
                            onChange={(e) => setMaxAge(e.target.value)}
                          />
                        </label>
                        <button
                          className="button secondary"
                          disabled={busy || !owner}
                        >
                          Update maximum age
                        </button>
                      </form>
                    </section>
                  </div>
                </div>
              )}
              {tab === "Treasury" && (
                <>
                  <div className="metrics">
                    <Metric
                      label="CONNECTED WALLET USDT"
                      value={treasury ? fmt(treasury.balance, 6) : "Loading…"}
                    />
                    <Metric
                      label="SETTLEMENT TOKEN"
                      value={
                        config.settlementTokenIsDemo
                          ? "Atlas demo USDT"
                          : "Configured USDT"
                      }
                      note="6 decimals"
                    />
                  </div>
                  <div className="two-column">
                    <section className="panel">
                      <h2>Token distribution</h2>
                      <p className="muted-copy">
                        Transfers spend the connected wallet’s own tokens.
                        Minting requires the settlement token’s MINTER_ROLE.
                      </p>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void distribute("transfer");
                        }}
                      >
                        <label>
                          Recipient wallet
                          <input
                            required
                            value={recipient}
                            onChange={(e) => setRecipient(e.target.value)}
                            placeholder="0x…"
                          />
                        </label>
                        <label>
                          USDT amount
                          <input
                            required
                            value={tokenAmount}
                            onChange={(e) => setTokenAmount(e.target.value)}
                            inputMode="decimal"
                          />
                        </label>
                        <div className="button-row">
                          <button
                            className="button"
                            disabled={busy || account === zeroAddress}
                          >
                            Transfer USDT
                          </button>
                          {config.settlementTokenIsDemo &&
                            treasury?.canMint && (
                              <button
                                type="button"
                                className="button secondary"
                                disabled={busy}
                                onClick={() => void distribute("mint")}
                              >
                                Mint demo USDT
                              </button>
                            )}
                        </div>
                      </form>
                      <div className="divider" />
                      <h3>Demo minter authorization</h3>
                      <label>
                        Wallet to grant / revoke minter access
                        <input
                          value={roleAccount}
                          onChange={(e) => setRoleAccount(e.target.value)}
                          placeholder="0x…"
                        />
                      </label>
                      <div className="button-row">
                        {[true, false].map((grant) => (
                          <button
                            key={String(grant)}
                            className="button secondary"
                            disabled={
                              busy ||
                              !treasury?.admin ||
                              !config.settlementTokenIsDemo
                            }
                            onClick={() =>
                              void run(async () => {
                                if (
                                  !isAddress(roleAccount) ||
                                  roleAccount === zeroAddress
                                )
                                  throw Error("Enter a valid wallet.");
                                await write(
                                  config.atlasUSDT,
                                  grant ? "grantRole" : "revokeRole",
                                  [hash("MINTER_ROLE"), roleAccount],
                                  account,
                                  setTx,
                                  abis.AtlasUSDT as Abi,
                                );
                                await loadTreasury();
                              })
                            }
                          >
                            {grant ? "Grant minter" : "Revoke minter"}
                          </button>
                        ))}
                      </div>
                    </section>
                    <section className="panel">
                      <h2>Recent settlement transfers</h2>
                      <p className="muted-copy">
                        Latest 30 events in a 500-block window.
                      </p>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>From</th>
                              <th>To</th>
                              <th>USDT</th>
                            </tr>
                          </thead>
                          <tbody>
                            {transfers.map((t, i) => (
                              <tr key={`${t.hash}-${i}`}>
                                <td>
                                  {t.from === zeroAddress
                                    ? "Mint"
                                    : short(t.from)}
                                </td>
                                <td>
                                  <a
                                    href={`https://sepolia.etherscan.io/tx/${t.hash}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {short(t.to)}
                                  </a>
                                </td>
                                <td>{fmt(t.value, 6)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {!transfers.length && (
                        <p className="empty">
                          No transfer events in this window.
                        </p>
                      )}
                    </section>
                  </div>
                </>
              )}
              {tab === "Access" && (
                <div className="two-column">
                  <section className="panel">
                    <div className="panel-title">
                      <h2>Delegate market functionality</h2>
                      <ShieldCheck size={18} />
                    </div>
                    <p className="muted-copy">
                      Only the current owner can grant or revoke access.
                      Permissions apply only to this country contract.
                    </p>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void roleChange(true);
                      }}
                    >
                      <label>
                        Permission
                        <select
                          value={role}
                          onChange={(e) => setRole(e.target.value as Role)}
                        >
                          {roles.map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Operator wallet
                        <input
                          required
                          value={roleAccount}
                          onChange={(e) => setRoleAccount(e.target.value)}
                          placeholder="0x…"
                        />
                      </label>
                      <div className="button-row">
                        <button className="button" disabled={busy || !owner}>
                          Grant permission
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busy || !owner}
                          onClick={() => void roleChange(false)}
                        >
                          Revoke permission
                        </button>
                      </div>
                    </form>
                    <div className="divider" />
                    <h3>Your active permissions</h3>
                    {roles.map((r) => (
                      <div className="permission" key={r}>
                        <span>{r}</span>
                        <span
                          className={
                            owner || data.roles[r] ? "positive" : "muted"
                          }
                        >
                          {owner
                            ? "Owner access"
                            : data.roles[r]
                              ? "Granted"
                              : "Not granted"}
                        </span>
                      </div>
                    ))}
                  </section>
                  <section className="panel">
                    <h2>Transfer country ownership</h2>
                    <dl>
                      <dt>Current owner</dt>
                      <dd>
                        <AddressLink address={data.owner} />
                      </dd>
                      <dt>Pending owner</dt>
                      <dd>
                        {data.pendingOwner === zeroAddress ? (
                          "None"
                        ) : (
                          <AddressLink address={data.pendingOwner} />
                        )}
                      </dd>
                    </dl>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(() => {
                          if (!isAddress(newOwner) || newOwner === zeroAddress)
                            throw Error("Enter a valid nonzero new owner.");
                          return send("transferOwnership", [newOwner]);
                        });
                      }}
                    >
                      <label>
                        New owner wallet
                        <input
                          value={newOwner}
                          onChange={(e) => setNewOwner(e.target.value)}
                          placeholder="0x…"
                          required
                        />
                      </label>
                      <button
                        className="button secondary"
                        disabled={busy || !owner}
                      >
                        Propose ownership transfer
                      </button>
                    </form>
                    <p className="subtle-note">
                      The new owner must accept from their wallet. Existing
                      delegated roles remain until explicitly revoked.
                    </p>
                    <button
                      className="button"
                      disabled={
                        busy ||
                        account.toLowerCase() !==
                          data.pendingOwner.toLowerCase()
                      }
                      onClick={() => void run(() => send("acceptOwnership"))}
                    >
                      Accept pending ownership
                    </button>
                  </section>
                </div>
              )}
              {tab === "Upgrades" && (
                <div className="two-column">
                  <section className="panel">
                    <div className="panel-title">
                      <h2>Upgrade this country market</h2>
                      <LockKeyhole size={18} />
                    </div>
                    <p className="muted-copy">
                      The proxy address and balances stay in place. Only this
                      market’s owner can change its implementation. Delegated
                      admins cannot upgrade.
                    </p>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void upgrade();
                      }}
                    >
                      <label>
                        New implementation address
                        <input
                          required
                          value={candidate}
                          onChange={(e) => setCandidate(e.target.value)}
                          placeholder="0x…"
                        />
                      </label>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={ack}
                          onChange={(e) => setAck(e.target.checked)}
                        />
                        <span>
                          I have validated the candidate’s storage layout and
                          tested the upgrade against the deployed version.
                        </span>
                      </label>
                      <button
                        className="button"
                        disabled={busy || !owner || !ack}
                      >
                        Review upgrade in wallet
                      </button>
                    </form>
                    <div className="subtle-note">
                      An incompatible or malicious implementation can corrupt
                      balances or permissions. A UUPS UUID check alone does not
                      establish storage compatibility.
                    </div>
                  </section>
                  <section className="panel">
                    <h2>Upgrade boundaries</h2>
                    <dl>
                      <dt>Selected proxy</dt>
                      <dd>
                        <AddressLink address={country!.address} />
                      </dd>
                      <dt>Implementation version</dt>
                      <dd>{data.version}</dd>
                      <dt>Upgrade authority</dt>
                      <dd>
                        <AddressLink address={data.owner} />
                      </dd>
                    </dl>
                    <p className="muted-copy">
                      Compile and run storage-layout validation before deploying
                      a new implementation. Upgrading one country does not
                      upgrade the other four markets.
                    </p>
                    <h3>Owner-controlled engine access</h3>
                    <p className="muted-copy">
                      Current engine: <AddressLink address={data.engine} />.
                      Changing this engine requires a reserve and position
                      migration plan; the dashboard does not silently replace
                      it.
                    </p>
                  </section>
                </div>
              )}
              <footer>
                Market Control · independent operations dashboard{" "}
                <span>Demo synthetic assets · no legal equity ownership</span>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
function StockTable({
  rows,
  fresh,
  toggle,
  disabled,
}: {
  rows: Stock[];
  fresh: (s: Stock) => boolean;
  toggle?: (s: Stock) => void;
  disabled?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Asset / company</th>
            <th>Exchange</th>
            <th>Native price</th>
            <th>USDT price</th>
            <th>Supply</th>
            <th>Status</th>
            {toggle && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.stockId}>
              <td>
                <strong>{s.ticker}</strong>
                <small>{s.companyName}</small>
              </td>
              <td>{s.exchange}</td>
              <td>{s.native ? fmt(s.native) : "—"}</td>
              <td>{fresh(s) ? fmt(s.price!) : "Unavailable"}</td>
              <td>{fmt(s.supply, 18, 4)}</td>
              <td>
                <span
                  className={`pill ${!s.active ? "muted" : fresh(s) ? "positive" : "warning"}`}
                >
                  {!s.active
                    ? "Disabled"
                    : fresh(s)
                      ? "Fresh"
                      : "Stale / unpriced"}
                </span>
              </td>
              {toggle && (
                <td>
                  <button
                    className="text-button"
                    disabled={disabled}
                    onClick={() => toggle(s)}
                  >
                    {s.active ? "Disable" : "Activate"}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
