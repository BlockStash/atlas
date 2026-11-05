"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import type { MarketPreference } from "@/lib/types";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Coins,
  Compass,
  Globe2,
  ShieldCheck,
  X,
} from "lucide-react";
import { OnchainPortfolio } from "@/components/protocol/portfolio";
import { ProtocolSummary } from "@/components/protocol/summary";
import { MarketStocks } from "@/components/protocol/market-stocks";
import {
  useStockSessions,
  regionMarketState,
} from "@/lib/protocol/stock-sessions";
import { ENSIdentity } from "@/components/wallet/ens-identity";
import { SepoliaWallet } from "@/components/wallet/sepolia-wallet";
import { DashboardShell } from "./shell";
import { CryptoMarket } from "./crypto-market";
import { useRouter } from "next/navigation";
import { useAtlas } from "@/components/atlas/provider";
import { MarketCard, Ticker } from "@/components/atlas/ui";
import { markets } from "@/lib/data";
import { api } from "@/lib/api";
function WelcomeTour() {
  const { state, update } = useAtlas();
  const [started, setStarted] = useState(false),
    [step, setStep] = useState(0);
  const items = [
    {
      title: "Your world, in one place.",
      copy: "Explore stocks across five international markets. Your selected markets are always shown first.",
      target: "tour-markets",
    },
    {
      title: "A pulse on every market.",
      copy: "The market clock shows local exchange times and the latest reported open or closed status.",
      target: "tour-clock",
    },
    {
      title: "Your crypto, connected.",
      copy: "Your wallet USDT, vault shares and Sepolia ETH balances appear here directly from the blockchain.",
      target: "tour-balances",
    },
    {
      title: "The bigger picture.",
      copy: "Track your portfolio and global exposure from a single workspace.",
      target: "tour-portfolio",
    },
  ];
  useEffect(() => {
    if (!started) return;
    const element = document.getElementById(items[step].target);
    element?.classList.add("tour-highlight");
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    return () => element?.classList.remove("tour-highlight");
  }, [started, step]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state.productTourComplete) return null;
  function finish() {
    update({ productTourComplete: true });
    setStarted(false);
  }
  return (
    <AnimatePresence>
      {
        <motion.aside
          role="dialog"
          aria-label="Atlas product tour"
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="tour-card"
        >
          <button
            className="tour-close"
            aria-label="Skip tour"
            onClick={finish}
          >
            <X size={16} />
          </button>
          <span className="tour-icon">
            <Compass size={22} />
          </span>
          <span className="eyebrow">
            {started ? `DISCOVER ATLAS / 0${step + 1}` : "A LITTLE ORIENTATION"}
          </span>
          <h3>{started ? items[step].title : "Meet your global workspace."}</h3>
          <p>
            {started
              ? items[step].copy
              : "Take a quick tour of your portfolio, global markets, and crypto balances."}
          </p>
          <div className="tour-actions">
            <button className="text-button" onClick={finish}>
              Skip tour
            </button>
            <button
              className="btn primary small"
              onClick={() => {
                if (!started) setStarted(true);
                else if (step === 3) finish();
                else setStep(step + 1);
              }}
            >
              {started ? (step === 3 ? "Finish" : "Next") : "Show me around"}
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="tour-dots">
            {items.map((_, i) => (
              <span className={i === step ? "active" : ""} key={i} />
            ))}
          </div>
        </motion.aside>
      }
    </AnimatePresence>
  );
}
export function Dashboard({
  view = "dashboard",
}: {
  view?: "dashboard" | "markets" | "portfolio" | "wallet";
}) {
  const { wallet, state, toast, ready } = useAtlas();
  const sessions = useStockSessions();
  const [marketData, setMarketData] = useState<MarketPreference[]>(markets);
  const [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [activeMarket, setActiveMarket] = useState<string | null>(null),
    [marketTab, setMarketTab] = useState<"global" | "crypto">("global"),
    [retry, setRetry] = useState(0);
  const router = useRouter();
  useEffect(() => {
    if (view !== "markets") return;
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "crypto") setMarketTab("crypto");
  }, [view]);
  function selectTab(tab: "global" | "crypto") {
    setMarketTab(tab);
    window.history.replaceState(
      null,
      "",
      tab === "crypto" ? "/markets?tab=crypto" : "/markets",
    );
  }
  function openMarket(id: string) {
    if (id !== "crypto") return setActiveMarket(id);
    if (view === "markets") selectTab("crypto");
    else router.push("/markets?tab=crypto");
  }
  useEffect(() => {
    if (!ready || !wallet) return;
    let alive = true;
    api<{ markets: (MarketPreference & { timezone: string })[] }>("/markets")
      .then((m) => {
        if (alive) {
          setMarketData(
            m.markets.map((item) => ({ ...item, zone: item.timezone })),
          );
          setError("");
        }
      })
      .catch((e) => {
        if (alive)
          setError(
            e instanceof Error ? e.message : "Could not load your portfolio.",
          );
      });
    return () => {
      alive = false;
    };
  }, [ready, wallet, retry]);
  const sorted = [...marketData]
    .sort(
      (a, b) =>
        Number(state.selectedMarkets.includes(b.id)) -
        Number(state.selectedMarkets.includes(a.id)),
    )
    .filter((m) =>
      `${m.name} ${m.exchange} ${m.index}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const current = marketData.find((m) => m.id === activeMarket);
  return (
    <DashboardShell search={query} onSearch={setQuery}>
      <motion.main
        className="dashboard-content"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <div className="page-heading">
          <div>
            <div className="eyebrow">
              <span className="status-dot" />
              YOUR GLOBAL PERSPECTIVE
            </div>
            <h1>
              {view === "dashboard"
                ? "Welcome to Atlas"
                : view === "markets"
                  ? "A world of opportunity"
                  : view === "portfolio"
                    ? "Your global portfolio"
                    : "Your wallet, connected"}
              <span className="heading-period">.</span>
            </h1>
            <p>
              {view === "dashboard"
                ? "Every market. Every opportunity. One connected experience."
                : view === "markets"
                  ? "Five stock markets and crypto. A single point of access."
                  : view === "portfolio"
                    ? "A clear view of your investments across borders."
                    : "Your crypto assets, together in one place."}
            </p>
          </div>
          <span className="verified-label">
            <ShieldCheck size={15} />
            {state.worldIdVerified
              ? "World ID verified"
              : state.passkeyVerified
                ? "Passkey verified"
                : "Wallet connected"}
            {state.worldIdVerifiedDemo && <small>DEMO</small>}
          </span>
        </div>
        {view === "markets" && <ProtocolSummary />}
        {error && (
          <div className="error-box dashboard-error" role="alert">
            {error}
            <button
              className="text-button"
              onClick={() => setRetry((r) => r + 1)}
            >
              Retry
              <ArrowRight size={14} />
            </button>
          </div>
        )}
        {(view === "dashboard" || view === "portfolio") && <OnchainPortfolio />}
        {view === "markets" && (
          <div className="ens-tabs market-tabs" role="tablist">
            {(
              [
                ["global", "Global markets"],
                ["crypto", "Crypto tokens & assets"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={marketTab === id}
                className={marketTab === id ? "active" : ""}
                onClick={() => selectTab(id)}
              >
                {id === "global" ? <Globe2 size={14} /> : <Coins size={14} />}
                {label}
              </button>
            ))}
          </div>
        )}
        {view === "markets" && marketTab === "crypto" && (
          <CryptoMarket query={query} />
        )}
        {(view === "dashboard" ||
          (view === "markets" && marketTab === "global")) && (
          <section className="market-overview" id="tour-markets">
            <div className="section-heading">
              <div>
                <h2>
                  {view === "markets" ? "Global markets" : "Your markets"}
                  <span className="count-badge">{sorted.length}</span>
                </h2>
                <p>
                  {view === "markets"
                    ? "Explore the exchanges connecting your global portfolio."
                    : "Your selected markets first. The rest of the world, one click away."}
                </p>
              </div>
              {view === "dashboard" ? (
                <Link href="/markets" className="text-button">
                  Explore all markets
                  <ArrowRight size={14} />
                </Link>
              ) : (
                <span className="demo-badge">
                  EXCHANGE STATUS · TWELVE DATA
                </span>
              )}
            </div>
            <div className="market-card-grid">
              {sorted.map((m) => (
                <MarketCard
                  key={m.id}
                  market={m}
                  marketState={regionMarketState(sessions.stocks, m.id)}
                  selected={state.selectedMarkets.includes(m.id)}
                  onClick={() => openMarket(m.id)}
                />
              ))}
            </div>
            {!sorted.length && (
              <div className="empty-state">
                <Globe2 />
                <h3>No matching markets</h3>
                <p>Try a country or exchange, like India or NASDAQ.</p>
                <button className="text-button" onClick={() => setQuery("")}>
                  Clear search
                </button>
              </div>
            )}
          </section>
        )}
        {view === "wallet" && (
          <>
            <div className="wallet-details panel">
              <div className="section-heading">
                <h2>Connected wallet</h2>
                <span className="connected-pill">
                  <Check size={12} />
                  Connected
                </span>
              </div>
              <div className="wallet-address-full">
                <span className="avatar">A</span>
                <div>
                  <strong>{wallet?.address}</strong>
                  <span>
                    {wallet?.network}
                    {wallet?.demo ? " · Investor demo wallet" : ""}
                  </span>
                </div>
                <button
                  className="btn secondary small"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(wallet?.address || "")
                      .then(() => toast("Wallet address copied."))
                      .catch(() => toast("Could not copy the address."));
                  }}
                >
                  Copy
                </button>
              </div>
              <p>
                <ShieldCheck size={15} />
                Atlas never has access to your wallet private keys.
              </p>
            </div>
            <div className="panel ens-wallet-panel">
              <ENSIdentity />
            </div>
            <SepoliaWallet />
            <OnchainPortfolio view="wallet" />
            <div className="wallet-explanation panel">
              <ShieldCheck size={27} />
              <div>
                <h3>Your wallet. Your control.</h3>
                <p>
                  Token balances and stock positions are read from your
                  connected Sepolia wallet. The transfer panel above sends
                  Sepolia test ETH.
                </p>
              </div>
            </div>
          </>
        )}
        {view === "dashboard" && (
          <section className="insight-banner">
            <span className="insight-icon">
              <Globe2 size={24} />
            </span>
            <div>
              <span className="eyebrow">BORDERLESS BY DESIGN</span>
              <h3>Your next opportunity could be anywhere.</h3>
              <p>
                Explore five global markets with the simplicity of one wallet.
              </p>
            </div>
            <Link href="/markets" className="btn secondary small">
              Discover markets
              <ArrowUpRight size={15} />
            </Link>
            <Globe2 className="banner-globe" size={145} strokeWidth={0.5} />
          </section>
        )}
        <div className="dashboard-ticker">
          <Ticker />
        </div>
      </motion.main>
      {view === "dashboard" && <WelcomeTour />}
      <Dialog.Root
        open={!!current}
        onOpenChange={(open) => {
          if (!open) setActiveMarket(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="market-detail-backdrop" />
          {current && (
            <Dialog.Content className="market-detail panel">
              <Dialog.Close
                aria-label="Close market details"
                className="dialog-close"
              >
                <X size={20} />
              </Dialog.Close>
              <span className="flag large">{current.flag}</span>
              <span className="eyebrow">
                GLOBAL MARKET / {current.currency}
              </span>
              <Dialog.Title>{current.name}</Dialog.Title>
              <Dialog.Description>{current.exchange}</Dialog.Description>
              <MarketStocks
                key={current.id}
                region={current.id}
                name={current.name}
              />
            </Dialog.Content>
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </DashboardShell>
  );
}
