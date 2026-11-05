"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, RefreshCw } from "lucide-react";
import { getAddress, zeroAddress } from "viem";
import { useAtlas } from "@/components/atlas/provider";
import { countryStocks } from "@/lib/protocol/countries";
import {
  fetchConfig,
  configuredAddresses,
  protocolError,
  type StockView,
} from "@/lib/protocol/client";
import { fmt } from "./shared";
import { useReferencePrices } from "@/lib/protocol/reference-prices";
import { useStockSessions } from "@/lib/protocol/stock-sessions";
import { ExchangeStatus, SessionReference } from "./session-reference";

export function MarketStocks({
  region,
  name,
}: {
  region: string;
  name: string;
}) {
  const { wallet } = useAtlas();
  const references = useReferencePrices();
  const sessions = useStockSessions();
  const [assets, setAssets] = useState<StockView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [clock, setClock] = useState(0);
  const account = wallet?.address;
  useEffect(() => {
    let active = true;
    setAssets([]);
    setError("");
    setLoading(true);
    async function load() {
      try {
        const config = await fetchConfig();
        if (!config.configured || !configuredAddresses(config))
          throw new Error(
            config.message || "The stock market deployment is not configured.",
          );
        const country = config.countries.find((c) => c.region === region);
        if (!country)
          throw new Error("This country has no configured stock market.");
        const rows = await countryStocks(
          { countries: [country], tradingEngine: config.tradingEngine },
          account ? getAddress(account) : zeroAddress,
        );
        if (active) {
          setAssets(rows);
          setClock(Math.floor(Date.now() / 1000));
        }
      } catch (e) {
        if (active) setError(protocolError(e));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [region, account, retry]);
  useEffect(() => {
    const timer = setInterval(
      () => setClock(Math.floor(Date.now() / 1000)),
      15000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <section className="market-stocks" aria-label={`${name} onboarded stocks`}>
      <div className="market-stocks-heading">
        <h3>
          Onboarded stocks{" "}
          {!loading && !error && (
            <span className="count-badge">{assets.length}</span>
          )}
        </h3>
        <button
          className="text-button"
          aria-label="Refresh onboarded stocks"
          disabled={loading}
          onClick={() => setRetry((value) => value + 1)}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {loading ? (
        <p className="market-stocks-message" role="status">
          <Loader2 size={16} className="spin" /> Loading {name} stocks…
        </p>
      ) : error ? (
        <div className="error-box" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : assets.length === 0 ? (
        <p className="market-stocks-message">
          No stocks have been onboarded for this market yet.
        </p>
      ) : (
        <ul className="market-stock-list">
          {assets.map((stock) => {
            const session = sessions.stocks.find(
              (s) => s.stockId === stock.stockId,
            );
            const reference = references.find(
              (r) => r.stockId === stock.stockId,
            );
            const fresh =
              stock.active && stock.price !== null && stock.validUntil > clock;
            const params = new URLSearchParams({
              market: region,
              stock: stock.stockId,
            });
            return (
              <li key={stock.stockId}>
                <Link href={`/trade?${params}`} className="market-stock-link">
                  <div className="market-stock-name">
                    <strong>{stock.ticker}</strong>
                    <span>{stock.companyName}</span>
                    <small>
                      {stock.exchange} · {stock.nativeCurrency}
                    </small>
                    <ExchangeStatus market={session?.market} />
                  </div>
                  <div className="market-stock-value">
                    <strong>
                      {fresh
                        ? `${fmt(stock.price!, 8, 4)} USDT`
                        : reference
                          ? `${fmt(BigInt(reference.priceUSDT), 8, 4)} USDT`
                          : "Price unavailable"}
                    </strong>
                    <small className={fresh ? "positive" : "muted"}>
                      {!stock.active
                        ? "Disabled"
                        : fresh
                          ? "Quote available"
                          : reference
                            ? "Provider reference · onchain quote expired"
                            : "Needs a fresh quote"}
                    </small>
                    {!fresh && reference && (
                      <small>
                        As of{" "}
                        {new Date(reference.timestamp * 1000).toLocaleString()}
                      </small>
                    )}
                    {account && (
                      <small>You hold {fmt(stock.balance, 18, 6)}</small>
                    )}
                    <span>
                      View stock <ArrowUpRight size={13} />
                    </span>
                  </div>
                </Link>
                <SessionReference session={session} />
              </li>
            );
          })}
        </ul>
      )}
      <p className="market-stocks-note">
        Recorded close and opening prices show the dated source session. They
        are historical references. {sessions.error} Sepolia stock
        representations. Buying and selling require a fresh quote and an enabled
        market.
      </p>
      <Link
        className="btn secondary full"
        href={`/trade?market=${encodeURIComponent(region)}`}
      >
        Open {name} trading <ArrowUpRight size={16} />
      </Link>
    </section>
  );
}
