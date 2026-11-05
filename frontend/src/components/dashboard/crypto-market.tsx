"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Info, Loader2, Search } from "lucide-react";
import { Metric } from "@/components/protocol/shared";
import { useAtlas } from "@/components/atlas/provider";
import { api } from "@/lib/api";

type Asset = {
  symbol: string;
  name: string;
  category: string;
  color: string;
  priceMicros: string;
  change24h: number;
};
type Account = {
  cashMicros: string;
  holdings: Record<string, { quantity: string; costMicros: string }>;
};
type Market = { feeBps: number; assets: Asset[]; account: Account };
type Trade = {
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  grossMicros: string;
  feeMicros: string;
};

const QTY = 100_000_000n,
  USD = 1_000_000n;
const usd = (micros: bigint, digits = 2) =>
  (Number(micros) / Number(USD)).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const price = (micros: bigint) => usd(micros, micros < 10n * USD ? 4 : 2);
const qty = (units: bigint, max = 8) =>
  (Number(units) / Number(QTY)).toLocaleString("en-US", {
    maximumFractionDigits: max,
  });
/** Exact decimal string for an 8-decimal quantity (no grouping, safe to re-parse). */
const exact = (units: bigint) => {
  const whole = units / QTY,
    fraction = (units % QTY).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
};
/** Parses a user decimal into integer units; null when invalid. */
function toUnits(value: string, decimals: number) {
  if (!/^\d+(\.\d*)?$/.test(value.trim())) return null;
  const [whole = "0", fraction = ""] = value.trim().split(".");
  if (fraction.length > decimals) return null;
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}
const categories = [
  "All",
  "Layer 1",
  "Layer 2",
  "DeFi",
  "Oracle",
  "Stablecoin",
  "Real-world asset",
];

export function CryptoMarket({ query = "" }: { query?: string }) {
  const { toast } = useAtlas();
  const [market, setMarket] = useState<Market | null>(null),
    [loadError, setLoadError] = useState(""),
    [category, setCategory] = useState("All"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState("BTC"),
    [side, setSide] = useState<"buy" | "sell">("buy"),
    [amount, setAmount] = useState("100"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [last, setLast] = useState<Trade | null>(null),
    [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    api<Market>("/crypto")
      .then((m) => {
        if (!alive) return;
        setMarket(m);
        setLoadError("");
      })
      .catch((e) => {
        if (alive)
          setLoadError(
            e instanceof Error ? e.message : "Could not load crypto markets.",
          );
      });
    return () => {
      alive = false;
    };
  }, [retry]);

  const filter = `${query} ${search}`.trim().toLowerCase();
  const assets = useMemo(
    () =>
      (market?.assets ?? []).filter(
        (a) =>
          (category === "All" || a.category === category) &&
          (!filter ||
            `${a.symbol} ${a.name} ${a.category}`
              .toLowerCase()
              .includes(filter)),
      ),
    [market, category, filter],
  );
  const asset = market?.assets.find((a) => a.symbol === selected);
  const holding = BigInt(market?.account.holdings[selected]?.quantity ?? "0");
  const cash = BigInt(market?.account.cashMicros ?? "0");
  const holdingsValue = (market?.assets ?? []).reduce(
    (sum, a) =>
      sum +
      (BigInt(market?.account.holdings[a.symbol]?.quantity ?? "0") *
        BigInt(a.priceMicros)) /
        QTY,
    0n,
  );
  const costBasis = Object.values(market?.account.holdings ?? {}).reduce(
    (sum, h) => sum + BigInt(h.costMicros),
    0n,
  );

  // Live estimate of what the order will do, mirroring the server's math.
  const estimate = useMemo(() => {
    if (!asset || !market) return null;
    const p = BigInt(asset.priceMicros),
      fee = BigInt(market.feeBps);
    if (side === "buy") {
      const spend = toUnits(amount, 6);
      if (spend === null || spend <= 0n) return null;
      const f = (spend * fee + 9_999n) / 10_000n;
      return {
        fee: f,
        receive: `${qty(((spend - f) * QTY) / p)} ${asset.symbol}`,
        invalid: spend > cash ? "Not enough simulated USDT." : "",
      };
    }
    const units = toUnits(amount, 8);
    if (units === null || units <= 0n) return null;
    const gross = (units * p) / QTY,
      f = (gross * fee + 9_999n) / 10_000n;
    return {
      fee: f,
      receive: usd(gross - f),
      invalid:
        units > holding ? `You hold ${qty(holding)} ${asset.symbol}.` : "",
    };
  }, [asset, market, side, amount, cash, holding]);

  function choose(symbol: string) {
    setSelected(symbol);
    setError("");
    setLast(null);
    if (window.matchMedia("(max-width:1100px)").matches)
      document
        .getElementById("crypto-order")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function submit() {
    if (!asset) return;
    setBusy(true);
    setError("");
    setLast(null);
    try {
      const result = await api<{ account: Account; trade: Trade }>(
        "/crypto/trade",
        { symbol: asset.symbol, side, amount: amount.trim() },
      );
      setMarket((m) => (m ? { ...m, account: result.account } : m));
      setLast(result.trade);
      toast(
        `${side === "buy" ? "Bought" : "Sold"} ${qty(BigInt(result.trade.quantity), 6)} ${asset.symbol} (simulated).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trade failed.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError)
    return (
      <div className="error-box dashboard-error" role="alert">
        {loadError}
        <button className="text-button" onClick={() => setRetry((r) => r + 1)}>
          Retry
          <ArrowRight size={14} />
        </button>
      </div>
    );
  if (!market)
    return (
      <p className="protocol-loading">
        <Loader2 className="spin" size={14} /> Loading crypto markets…
      </p>
    );

  const held = market.assets.filter((a) => market.account.holdings[a.symbol]);
  return (
    <section className="crypto-market">
      <div className="protocol-metrics">
        <Metric
          label="SIMULATED BUYING POWER"
          value={`${usd(cash)}`}
          note="Demo USDT balance for crypto. Starts at $10,000."
        />
        <Metric label="CRYPTO HOLDINGS" value={usd(holdingsValue)} />
        <Metric
          label="UNREALIZED P/L"
          value={`${holdingsValue - costBasis >= 0n ? "+" : "−"}${usd(
            holdingsValue - costBasis >= 0n
              ? holdingsValue - costBasis
              : costBasis - holdingsValue,
          )}`}
          note="Holdings value minus what you paid, fees included."
        />
      </div>
      <div className="protocol-trading-layout">
        <section>
          <div className="crypto-toolbar">
            <div className="protocol-filters">
              {categories.map((c) => (
                <button
                  key={c}
                  className={category === c ? "active" : ""}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <label className="crypto-search">
              <Search size={14} />
              <input
                placeholder="Search tokens"
                aria-label="Search tokens"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          <div className="panel table-scroll">
            <table className="protocol-stock-table crypto-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Category</th>
                  <th>Price</th>
                  <th>24h</th>
                  <th>Your holding</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => {
                  const h = BigInt(
                    market.account.holdings[a.symbol]?.quantity ?? "0",
                  );
                  return (
                    <tr
                      key={a.symbol}
                      className={a.symbol === selected ? "selected" : ""}
                    >
                      <td>
                        <span className="crypto-asset">
                          <span
                            className="crypto-avatar"
                            style={{
                              color: a.color,
                              borderColor: `${a.color}55`,
                            }}
                          >
                            {a.symbol.slice(0, 1)}
                          </span>
                          <span>
                            <strong>{a.symbol}</strong>
                            <small>{a.name}</small>
                          </span>
                        </span>
                      </td>
                      <td>{a.category}</td>
                      <td className="mono">{price(BigInt(a.priceMicros))}</td>
                      <td
                        className={
                          a.change24h > 0
                            ? "positive"
                            : a.change24h < 0
                              ? "negative"
                              : ""
                        }
                      >
                        {a.change24h > 0 ? "+" : a.change24h < 0 ? "−" : ""}
                        {Math.abs(a.change24h).toFixed(2)}%
                      </td>
                      <td className="mono">{h ? qty(h, 6) : "—"}</td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => choose(a.symbol)}
                        >
                          Trade
                          <ArrowRight size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!assets.length && (
              <p className="protocol-loading">No tokens match your search.</p>
            )}
          </div>
          <section className="panel protocol-allocation">
            <h2>Your crypto</h2>
            {held.length === 0 ? (
              <p>Your tokens will appear here after your first buy.</p>
            ) : (
              held.map((a) => {
                const h = BigInt(market.account.holdings[a.symbol]!.quantity);
                return (
                  <div key={a.symbol}>
                    <span>
                      {qty(h, 6)} {a.symbol}
                    </span>
                    <strong>{usd((h * BigInt(a.priceMicros)) / QTY)}</strong>
                  </div>
                );
              })
            )}
          </section>
        </section>
        <aside id="crypto-order" className="panel protocol-order">
          <h2>{asset?.symbol ?? "Choose a token"}</h2>
          <p>
            {asset
              ? `${asset.name} · ${price(BigInt(asset.priceMicros))}`
              : "Select a token to trade."}
          </p>
          {asset && (
            <>
              <span className="demo-badge">SIMULATED · NOT ON-CHAIN</span>
              <div className="ens-tabs">
                {(["buy", "sell"] as const).map((value) => (
                  <button
                    key={value}
                    className={side === value ? "active" : ""}
                    disabled={busy}
                    onClick={() => {
                      setSide(value);
                      setAmount(
                        value === "buy" ? "100" : holding ? exact(holding) : "",
                      );
                      setError("");
                      setLast(null);
                    }}
                  >
                    {value === "buy" ? "Buy" : "Sell"}
                  </button>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <label>
                  {side === "buy"
                    ? "Amount to spend (USDT)"
                    : `Quantity to sell (${asset.symbol})`}
                  <input
                    required
                    inputMode="decimal"
                    value={amount}
                    disabled={busy}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setError("");
                      setLast(null);
                    }}
                  />
                </label>
                <div className="crypto-quick">
                  {side === "buy"
                    ? ["50", "100", "500", "1000"].map((v) => (
                        <button
                          type="button"
                          key={v}
                          onClick={() => setAmount(v)}
                        >
                          ${v}
                        </button>
                      ))
                    : [25, 50, 100].map((pct) => (
                        <button
                          type="button"
                          key={pct}
                          disabled={!holding}
                          onClick={() =>
                            setAmount(exact((holding * BigInt(pct)) / 100n))
                          }
                        >
                          {pct === 100 ? "Max" : `${pct}%`}
                        </button>
                      ))}
                </div>
                <div className="protocol-review">
                  <dl>
                    <dt>You receive</dt>
                    <dd>{estimate?.receive ?? "—"}</dd>
                    <dt>Fee ({market.feeBps / 100}%)</dt>
                    <dd>{estimate ? usd(estimate.fee, 4) : "—"}</dd>
                    <dt>{side === "buy" ? "Available" : "You hold"}</dt>
                    <dd>
                      {side === "buy"
                        ? usd(cash)
                        : `${qty(holding)} ${asset.symbol}`}
                    </dd>
                  </dl>
                </div>
                {estimate?.invalid && (
                  <p className="inline-message">{estimate.invalid}</p>
                )}
                <button
                  className="btn primary full"
                  disabled={busy || !estimate || !!estimate.invalid}
                >
                  {busy ? <Loader2 className="spin" size={16} /> : null}
                  {side === "buy"
                    ? `Buy ${asset.symbol}`
                    : `Sell ${asset.symbol}`}
                </button>
              </form>
              {error && (
                <p className="error-box" role="alert">
                  {error}
                </p>
              )}
              {last && (
                <p className="protocol-tx" role="status">
                  <Check size={14} />
                  {last.side === "buy" ? "Bought" : "Sold"}{" "}
                  {qty(BigInt(last.quantity), 6)} {last.symbol} for{" "}
                  {usd(BigInt(last.grossMicros))}
                </p>
              )}
            </>
          )}
          <p className="protocol-legal">
            <Info size={11} /> Crypto trading in Atlas is simulated. Prices are
            illustrative and no tokens move on-chain. Balances are saved to your
            Atlas profile.
          </p>
        </aside>
      </div>
    </section>
  );
}
