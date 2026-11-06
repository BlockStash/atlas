"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Layers3,
  RefreshCw,
  ArrowUpRight,
  Wallet,
  Info,
  ExternalLink,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { api } from "@/lib/api";
import {
  formatPortfolioAmount as amount,
  portfolioAtTime,
  portfolioHistory,
  type PortfolioSnapshot,
  type PortfolioPoint,
} from "@/lib/portfolio";
export function OnchainPortfolio({
  view = "portfolio",
}: {
  view?: "portfolio" | "wallet";
}) {
  const { wallet, ready } = useAtlas();
  const address = wallet?.address;
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0),
    [period, setPeriod] = useState("ALL"),
    [clock, setClock] = useState(0);
  useEffect(() => {
    const tick = () => setClock(Math.floor(Date.now() / 1000));
    tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!ready || !address) return;
    let active = true,
      reading = false;
    setSnapshot(null);
    setError("");
    setLoading(true);
    const load = async () => {
      if (!active || reading) return;
      reading = true;
      setLoading(true);
      try {
        const data = await api<PortfolioSnapshot>("/portfolio");
        if (
          data.address.toLowerCase() !== address.toLowerCase() ||
          data.source !== "sepolia"
        )
          throw Error(
            "The portfolio account does not match your connected wallet. Reconnect and retry.",
          );
        if (active) {
          setSnapshot(data);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Could not read your holdings.",
          );
      } finally {
        reading = false;
        if (active) setLoading(false);
      }
    };
    const refresh = () => {
      void load();
    };
    void load();
    const timer = setInterval(refresh, 20000);
    window.addEventListener("focus", refresh);
    window.addEventListener("atlas-protocol-updated", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("atlas-protocol-updated", refresh);
    };
  }, [address, ready, retry]);
  const portfolio =
    snapshot && snapshot.address.toLowerCase() === address?.toLowerCase()
      ? portfolioAtTime(snapshot, clock)
      : null;
  const history = portfolio
    ? portfolioHistory(portfolio.history, period, portfolio.timestamp)
    : [];
  const balances = portfolio
    ? [
        {
          symbol: "USDT",
          name: "Wallet settlement tokens",
          raw: portfolio.walletUSDT,
          decimals: 6,
          note: "Available in your wallet",
          icon: "₮",
        },
        {
          symbol: "aUSDT",
          name: "Atlas Vault shares",
          raw: portfolio.vaultShares,
          decimals: 12,
          note: `Claim: ${amount(portfolio.vaultAssets, 6)} USDT`,
          icon: "a",
        },
        {
          symbol: "ETH",
          name: "Sepolia gas balance",
          raw: portfolio.walletETH,
          decimals: 18,
          note: "Shown separately from USDT value",
          icon: "Ξ",
        },
      ]
    : [];
  return (
    <div className="onchain-portfolio">
      <div className="onchain-toolbar">
        <div>
          <span className="status-dot" /> SEPOLIA HOLDINGS
          {portfolio && (
            <span className="onchain-account" title={portfolio.address}>
              {portfolio.address.slice(0, 6)}…{portfolio.address.slice(-4)}
            </span>
          )}
        </div>
        <button
          className="text-button"
          disabled={loading}
          onClick={() => setRetry((n) => n + 1)}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
          {loading ? "Reading chain…" : "Refresh balances"}
        </button>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
          {portfolio && " Showing the last confirmed read."}
          <button
            className="text-button"
            onClick={() => setRetry((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {!portfolio ? (
        <section className="panel protocol-empty">
          <Wallet size={28} />
          <h2>
            {loading
              ? "Reading your Sepolia holdings…"
              : "Portfolio unavailable"}
          </h2>
          <p>
            {loading
              ? "Checking your USDT, vault shares and stock balances across all five market contracts."
              : "Your balances will appear after the chain read succeeds. No sample balances are shown."}
          </p>
        </section>
      ) : (
        <>
          {portfolio.pricingMode === "historical-development" && (
            <p className="session-reference-note">
              Development valuation uses fixed historical stock prices. Wallet
              balances and stock quantities are read from Sepolia.
            </p>
          )}
          <div
            className={
              view === "portfolio" ? "summary-grid" : "onchain-wallet-summary"
            }
          >
            {view === "portfolio" && (
              <section className="portfolio-panel panel" id="tour-portfolio">
                <div className="panel-header">
                  <span>
                    <span className="tiny-icon">
                      <Layers3 size={14} />
                    </span>
                    GLOBAL PORTFOLIO
                  </span>
                  <span className="demo-badge">ONCHAIN · SEPOLIA</span>
                </div>
                <div className="portfolio-main">
                  <div className="portfolio-amount">
                    <span className="onchain-total">
                      {portfolio.totalValueUSDT === null
                        ? "Price unavailable"
                        : amount(portfolio.totalValueUSDT, 6, 2)}
                    </span>
                    <span>USDT</span>
                  </div>
                  <div className="onchain-breakdown">
                    <span>
                      Vault buying power{" "}
                      <strong>{amount(portfolio.vaultAssets, 6)} USDT</strong>
                    </span>
                    <span>
                      Stock value{" "}
                      <strong>
                        {portfolio.stockValueUSDT === null
                          ? "Needs a fresh quote"
                          : `${amount(portfolio.stockValueUSDT, 6)} USDT`}
                      </strong>
                    </span>
                  </div>
                  <p className="onchain-description">
                    Wallet USDT + your vault claim + stock holdings. ETH is
                    shown separately.
                  </p>
                  {portfolio.positions.some((p) => p.valueUSDT === null) && (
                    <p className="onchain-stale">
                      Your stock quantities are confirmed. An expired or
                      disabled price feed prevents a complete current valuation.
                    </p>
                  )}
                </div>
                <div className="chart-area onchain-chart">
                  <ValueChart points={history} />
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
                  <Link href="/trade">
                    Trade stocks
                    <ArrowUpRight size={13} />
                  </Link>
                </div>
                <p className="onchain-history-note">
                  Observed account value, including deposits and transfers.
                  Latest 500 recorded observations; history starts when balances
                  are first read.
                </p>
              </section>
            )}
            <div
              className={
                view === "portfolio" ? "balances-column" : "wallet-balance-grid"
              }
              id="tour-balances"
            >
              {view === "portfolio" && (
                <div className="balance-column-title">
                  <span>YOUR ONCHAIN BALANCES</span>
                  <Info size={13} />
                </div>
              )}
              {balances.map((b) => (
                <section key={b.symbol} className="balance-card panel">
                  <div className="balance-card-heading">
                    <span className={`token-icon ${b.symbol.toLowerCase()}`}>
                      {b.icon}
                    </span>
                    <div>
                      <strong>{b.symbol}</strong>
                      <span>{b.name}</span>
                    </div>
                    <span className="balance-demo">SEPOLIA</span>
                  </div>
                  <div className="balance-value" title={b.raw}>
                    {amount(b.raw, b.decimals)}
                    <span>{b.symbol}</span>
                  </div>
                  <footer>
                    <span>{b.note}</span>
                  </footer>
                </section>
              ))}
            </div>
          </div>
          <section className="holdings-panel panel">
            <div className="section-heading">
              <div>
                <h2>Your stock positions</h2>
                <p>
                  Balances held by this wallet in the deployed country
                  contracts.
                </p>
              </div>
              <span className="demo-badge">
                {portfolio.positions.length} POSITIONS
              </span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Market</th>
                    <th>Shares</th>
                    <th>Price / share</th>
                    <th>Position value</th>
                    <th>Quote</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio.positions.map((position, i) => (
                    <tr key={`${position.countryContract}-${position.stockId}`}>
                      <td>
                        <span className={`stock-avatar stock-${i % 4}`}>
                          {position.symbol.slice(0, 1)}
                        </span>
                        <span>
                          <strong>{position.symbol}</strong>
                          <small>{position.name}</small>
                        </span>
                      </td>
                      <td>
                        {position.marketName}
                        <small>{position.exchange}</small>
                      </td>
                      <td className="mono">
                        {amount(position.quantity, 18, 8)}
                      </td>
                      <td className="mono">
                        {position.priceUSDT === null
                          ? "Unavailable"
                          : `${amount(position.priceUSDT, 8)} USDT`}
                      </td>
                      <td className="mono">
                        {position.valueUSDT === null
                          ? "Unavailable"
                          : `${amount(position.valueUSDT, 6)} USDT`}
                      </td>
                      <td>
                        <span
                          className={
                            position.status === "fresh"
                              ? "positive"
                              : "negative"
                          }
                        >
                          {position.status === "fresh"
                            ? "Fresh"
                            : position.status === "disabled"
                              ? "Disabled"
                              : "Expired"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!portfolio.positions.length && (
              <div className="empty-state">
                <Layers3 />
                <h3>No stock positions in this wallet yet</h3>
                <p>
                  Connect the wallet used for your purchase, or buy a stock
                  using your vault balance.
                </p>
                <Link className="btn secondary small" href="/trade">
                  Browse stocks
                  <ArrowUpRight size={14} />
                </Link>
              </div>
            )}
            <div className="holdings-footnote">
              <Info size={13} />
              <span>
                Read at block {portfolio.blockNumber.toLocaleString()} ·{" "}
                {new Date(portfolio.timestamp * 1000).toLocaleString()} ·
                Sepolia synthetic assets
              </span>
              <a
                href={`https://sepolia.etherscan.io/address/${portfolio.address}`}
                target="_blank"
                rel="noreferrer"
                aria-label="View wallet on Sepolia"
              >
                <ExternalLink size={13} />
              </a>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
function ValueChart({ points }: { points: PortfolioPoint[] }) {
  if (points.length < 2)
    return (
      <div className="onchain-history-empty">
        <Layers3 size={22} />
        <p>
          {points.length
            ? "Your first portfolio observation is recorded. More observations will build your chart."
            : "No recorded observations in this period yet."}
        </p>
        <small>Past performance is not generated from sample data.</small>
      </div>
    );
  const values = points.map((p) => BigInt(p.valueUSDT)),
    low = values.reduce((a, b) => (a < b ? a : b)),
    high = values.reduce((a, b) => (a > b ? a : b)),
    range = high - low || 1n,
    first = points[0].timestamp,
    last = points[points.length - 1].timestamp,
    span = last - first || 1;
  const coords = points
    .map(
      (p, i) =>
        `${10 + ((p.timestamp - first) / span) * 600},${145 - Number(((values[i] - low) * 12000n) / range) / 100}`,
    )
    .join(" ");
  return (
    <>
      <svg
        className="portfolio-chart"
        viewBox="0 0 620 170"
        preserveAspectRatio="none"
        role="img"
        aria-label="Recorded onchain portfolio value in USDT"
      >
        {[25, 65, 105, 145].map((y) => (
          <line
            key={y}
            x1="10"
            x2="610"
            y1={y}
            y2={y}
            stroke="#9baec3"
            strokeOpacity=".1"
            strokeDasharray="3 4"
          />
        ))}
        <polyline
          points={coords}
          fill="none"
          stroke="#7ea6ff"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="chart-labels">
        <span>{new Date(first * 1000).toLocaleString()}</span>
        <span>{new Date(last * 1000).toLocaleString()}</span>
      </div>
    </>
  );
}
