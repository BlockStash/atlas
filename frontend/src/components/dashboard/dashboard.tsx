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
  ChevronDown,
  Compass,
  Globe2,
  Info,
  Layers3,
  ShieldCheck,
  X,
} from "lucide-react";
import { ProtocolSummary } from "@/components/protocol/summary";
import { ENSIdentity } from "@/components/wallet/ens-identity";
import { SepoliaWallet } from "@/components/wallet/sepolia-wallet";
import { DashboardShell } from "./shell";
import { useAtlas } from "@/components/atlas/provider";
import { MarketCard, Ticker } from "@/components/atlas/ui";
import { markets } from "@/lib/data";
import { api } from "@/lib/api";
type Portfolio = {
  totalValue: number;
  todayChange: number;
  todayChangePercent: number;
  balances: {
    symbol: string;
    name: string;
    balance: number;
    price: number;
    value: number;
  }[];
  positions: {
    symbol: string;
    name: string;
    market: string;
    shares: number;
    value: number;
    change: number;
  }[];
  history: number[];
};
const usd = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    v,
  );
function PortfolioChart({ period }: { period: string }) {
  const paths: Record<string, string> = {
    "1D": "M0 120 20 118 30 125 43 110 55 115 63 103 75 106 85 90 95 97 110 83 125 90 136 72 146 85 160 62 175 66 185 53 200 58 215 42 225 50 240 27 250 34 265 20 278 27 290 11 310 15 320 5",
    "1W": "M0 125 25 100 40 109 60 102 85 118 110 74 130 80 150 55 170 65 195 33 220 48 245 24 270 29 295 9 320 5",
    "1M": "M0 130 24 121 38 125 56 100 75 105 95 80 113 100 135 74 156 65 173 76 190 52 215 61 235 28 255 34 280 20 300 24 320 5",
    "1Y": "M0 140 24 130 45 138 65 115 90 124 115 90 140 99 165 70 190 82 215 49 240 60 270 27 290 35 320 5",
    ALL: "M0 145 25 135 48 138 77 119 100 125 127 94 150 104 180 75 205 89 240 52 265 61 290 22 320 5",
  };
  return (
    <svg
      className="portfolio-chart"
      viewBox="0 0 320 170"
      preserveAspectRatio="none"
      aria-label={`Illustrative portfolio performance over ${period}`}
      role="img"
    >
      <defs>
        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#6b95ed" stopOpacity=".21" />
          <stop offset="1" stopColor="#6b95ed" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[30, 75, 120, 165].map((y) => (
        <line
          key={y}
          x1="0"
          x2="320"
          y1={y}
          y2={y}
          stroke="#9baec3"
          strokeOpacity=".07"
          strokeDasharray="3 4"
        />
      ))}
      <path d={`${paths[period]} L320 170 L0 170Z`} fill="url(#chart-fill)" />
      <motion.path
        key={period}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7 }}
        d={paths[period]}
        stroke="#7ea6ff"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        fill="none"
      />
      <circle cx="320" cy="5" r="3" fill="#a3c0ff" />
    </svg>
  );
}
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
      copy: "The market clock shows local times. Open and closed indicators are illustrative in this investor preview.",
      target: "tour-clock",
    },
    {
      title: "Your crypto, connected.",
      copy: "Your USDT and ATLAS balances live here. All balances in this preview are simulated.",
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
  const [marketData, setMarketData] = useState<MarketPreference[]>(markets);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null),
    [error, setError] = useState(""),
    [period, setPeriod] = useState("1M"),
    [query, setQuery] = useState(""),
    [activeMarket, setActiveMarket] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!ready || !wallet) return;
    let alive = true;
    Promise.all([
      api<Portfolio>("/portfolio"),
      api<{ markets: (MarketPreference & { timezone: string })[] }>("/markets"),
    ])
      .then(([p, m]) => {
        if (alive) {
          setPortfolio(p);
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
                  ? "Five markets. A single point of access."
                  : view === "portfolio"
                    ? "A clear view of your investments across borders."
                    : "Your crypto assets, together in one place."}
            </p>
          </div>
          <span className="verified-label">
            <ShieldCheck size={15} />
            World ID verified{state.worldIdVerifiedDemo && <small>DEMO</small>}
          </span>
        </div>
        <ProtocolSummary />
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
        {(view === "dashboard" || view === "portfolio") && (
          <div className="summary-grid">
            <section className="portfolio-panel panel" id="tour-portfolio">
              <div className="panel-header">
                <span>
                  <span className="tiny-icon">
                    <Layers3 size={14} />
                  </span>
                  GLOBAL PORTFOLIO
                </span>
                <span className="demo-badge">DEMO PORTFOLIO</span>
              </div>
              <div className="portfolio-main">
                <div className="portfolio-amount">
                  {portfolio ? (
                    usd(portfolio.totalValue)
                  ) : (
                    <span className="skeleton amount-skeleton" />
                  )}
                  <span>
                    USD
                    <ChevronDown size={12} />
                  </span>
                </div>
                <div className="portfolio-movement">
                  <span>
                    <ArrowUpRight size={14} />
                    {portfolio
                      ? `+${usd(portfolio.todayChange)} (+${portfolio.todayChangePercent}%)`
                      : "Loading…"}
                  </span>
                  <small>today</small>
                </div>
              </div>
              <div className="chart-area">
                <PortfolioChart period={period} />
                <div className="chart-labels">
                  <span>{period === "1D" ? "09:00" : "Oct 06"}</span>
                  <span>{period === "1D" ? "12:00" : "Oct 13"}</span>
                  <span>{period === "1D" ? "15:00" : "Oct 20"}</span>
                  <span>{period === "1D" ? "18:00" : "Oct 27"}</span>
                  <span>{period === "1D" ? "Now" : "Nov 05"}</span>
                </div>
              </div>
              <div className="portfolio-panel-footer">
                <div className="period-selector">
                  {["1D", "1W", "1M", "1Y", "ALL"].map((p) => (
                    <button
                      key={p}
                      className={p === period ? "active" : ""}
                      onClick={() => setPeriod(p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <Link href="/portfolio">
                  View portfolio
                  <ArrowUpRight size={13} />
                </Link>
              </div>
            </section>
            <div className="balances-column" id="tour-balances">
              <div className="balance-column-title">
                <span>YOUR CRYPTO BALANCES</span>
                <Info size={13} />
              </div>
              {(
                portfolio?.balances || [
                  {
                    symbol: "USDT",
                    name: "Tether USD",
                    balance: 0,
                    price: 1,
                    value: 0,
                  },
                  {
                    symbol: "ATLAS",
                    name: "Atlas Coin",
                    balance: 0,
                    price: 2,
                    value: 0,
                  },
                ]
              ).map((balance) => (
                <section key={balance.symbol} className="balance-card panel">
                  <div className="balance-card-heading">
                    <span
                      className={`token-icon ${balance.symbol.toLowerCase()}`}
                    >
                      {balance.symbol === "USDT" ? "₮" : "A"}
                    </span>
                    <div>
                      <strong>{balance.symbol}</strong>
                      <span>{balance.name}</span>
                    </div>
                    <span className="balance-demo">DEMO</span>
                  </div>
                  <div className="balance-value">
                    {portfolio ? (
                      balance.balance.toLocaleString("en-US", {
                        maximumFractionDigits: 2,
                      })
                    ) : (
                      <span className="skeleton" />
                    )}
                    <span>{balance.symbol}</span>
                  </div>
                  <footer>
                    <span>≈ {portfolio ? usd(balance.value) : "—"}</span>
                    <span>
                      {balance.symbol === "ATLAS"
                        ? "$2.00 demo price"
                        : "Dollar-pegged"}
                    </span>
                  </footer>
                </section>
              ))}
            </div>
          </div>
        )}
        {(view === "dashboard" || view === "markets") && (
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
                <span className="demo-badge">DEMO MARKET STATUS</span>
              )}
            </div>
            <div className="market-card-grid">
              {sorted.map((m) => (
                <MarketCard
                  key={m.id}
                  market={m}
                  selected={state.selectedMarkets.includes(m.id)}
                  onClick={() => setActiveMarket(m.id)}
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
        {(view === "portfolio" || view === "dashboard") && (
          <section className="holdings-panel panel">
            <div className="section-heading">
              <div>
                <h2>Across your portfolio</h2>
                <p>A snapshot of your global positions.</p>
              </div>
              <span className="demo-badge">ILLUSTRATIVE HOLDINGS</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Market</th>
                    <th>Shares</th>
                    <th>Position value</th>
                    <th>Today</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio?.positions.map((h, i) => (
                    <tr key={h.symbol}>
                      <td>
                        <span className={`stock-avatar stock-${i}`}>
                          {h.symbol.slice(0, 1)}
                        </span>
                        <span>
                          <strong>{h.symbol}</strong>
                          <small>{h.name}</small>
                        </span>
                      </td>
                      <td>
                        {markets.find((m) => m.id === h.market)?.flag}{" "}
                        {markets.find((m) => m.id === h.market)?.name}
                      </td>
                      <td className="mono">{h.shares.toFixed(2)}</td>
                      <td className="mono">{usd(h.value)}</td>
                      <td className={h.change >= 0 ? "positive" : "negative"}>
                        {h.change >= 0 ? "+" : ""}
                        {h.change.toFixed(2)}%
                      </td>
                    </tr>
                  )) ||
                    [0, 1, 2].map((i) => (
                      <tr key={i}>
                        <td colSpan={5}>
                          <span className="skeleton row-skeleton" />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="holdings-footnote">
              <Info size={13} />
              Sample positions are a subset of the illustrative portfolio.
            </div>
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
            <div className="wallet-balance-grid">
              {portfolio?.balances.map((b) => (
                <div className="balance-card panel" key={b.symbol}>
                  <div className="balance-card-heading">
                    <span className={`token-icon ${b.symbol.toLowerCase()}`}>
                      {b.symbol === "USDT" ? "₮" : "A"}
                    </span>
                    <strong>{b.symbol}</strong>
                    <span className="demo-badge">DEMO</span>
                  </div>
                  <div className="balance-value">
                    {b.balance.toLocaleString()}
                    <span>{b.symbol}</span>
                  </div>
                  <footer>
                    ≈ {usd(b.value)}
                    <span>{usd(b.price)} demo price</span>
                  </footer>
                </div>
              )) || <div className="skeleton wallet-skeleton" />}
            </div>
            <div className="wallet-explanation panel">
              <ShieldCheck size={27} />
              <div>
                <h3>Your wallet. Your control.</h3>
                <p>
                  USDT and ATLAS balances are simulated. Use the Sepolia test
                  wallet above for real test ETH transfers.
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
              <span className={`market-status ${current.open ? "" : "closed"}`}>
                {current.open ? "● OPEN" : "○ CLOSED"} · DEMO STATUS
              </span>
              <div className="market-index">
                <span>{current.index}</span>
                <strong>{current.value}</strong>
                <span
                  className={
                    current.change.startsWith("−") ? "negative" : "positive"
                  }
                >
                  {current.change} today
                </span>
              </div>
              <PortfolioChart period="1M" />
              <p className="market-detail-note">
                Market prices and charts are illustrative. Stock discovery and
                crypto-powered investment are the next stage of Atlas.
              </p>
              <button
                className="btn secondary full"
                onClick={() =>
                  toast(
                    `${current.name} is ${state.selectedMarkets.includes(current.id) ? "already in your markets" : "available in your onboarding preferences"}.`,
                  )
                }
              >
                Explore your global perspective
                <ArrowUpRight size={16} />
              </button>
            </Dialog.Content>
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </DashboardShell>
  );
}
