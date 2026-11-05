"use client";
import { StockPriceHistory } from "./history";
import { useEffect, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import {
  useProtocol,
  ProtocolFrame,
  SetupState,
  TransactionStatus,
  Metric,
  fmt,
} from "./shared";
import {
  stocks,
  read,
  write,
  approve,
  approveCountry,
  units,
  protocolError,
  type StockView,
  type TxState,
} from "@/lib/protocol/client";
const regions = [
  ["all", "All markets"],
  ["india", "India"],
  ["usa", "United States"],
  ["uk", "United Kingdom"],
  ["singapore", "Singapore"],
  ["europe", "Europe"],
];
export function TradingPage() {
  const p = useProtocol();
  const [observations, setAssets] = useState<StockView[]>([]),
    [clock, setClock] = useState(0),
    [region, setRegion] = useState("all"),
    [selected, setSelected] = useState<string | null>(null),
    [side, setSide] = useState<"buy" | "sell">("buy"),
    [quantity, setQuantity] = useState("1"),
    [quote, setQuote] = useState<{
      quantity: bigint;
      assets: bigint;
      fee: bigint;
      shares: bigint;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tx, setTx] = useState<TxState | null>(null);
  useEffect(() => {
    const update = () => setClock(Math.floor(Date.now() / 1000));
    update();
    const timer = setInterval(update, 15000);
    return () => clearInterval(timer);
  }, []);
  const assets = observations.map((s) =>
    s.validUntil < clock ? { ...s, price: null } : s,
  );
  const asset = assets.find((s) => s.stockId === selected),
    filtered = assets.filter((s) => region === "all" || s.region === region),
    held = assets.filter((s) => s.balance > 0n);
  useEffect(() => {
    if (!p.config?.configured || !p.account) return;
    let active = true;
    stocks(p.config, p.account)
      .then((value) => {
        if (active) setAssets(value);
      })
      .catch((e) => {
        if (active) setError(protocolError(e));
      });
    return () => {
      active = false;
    };
  }, [p.config, p.account]);
  async function refresh() {
    await p.reload();
    if (p.config && p.account) setAssets(await stocks(p.config, p.account));
  }
  async function preview() {
    setBusy(true);
    setError("");
    try {
      if (!asset || !p.config) throw new Error("Select a stock.");
      const amount = units(quantity, 18);
      if (side === "sell" && amount > asset.balance)
        throw new Error("The quantity exceeds your holding.");
      const result = (await read(
        p.config,
        "tradingEngine",
        side === "buy" ? "quoteBuy" : "quoteSell",
        [asset.token, asset.stockId, amount],
      )) as readonly [bigint, bigint, bigint];
      setQuote({
        quantity: amount,
        assets: result[0],
        fee: result[1],
        shares: result[2],
      });
    } catch (e) {
      setError(protocolError(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!p.config || !p.account || !asset || !quote) return;
    setBusy(true);
    setError("");
    setTx(null);
    try {
      const deadline = BigInt(clock + 600);
      if (side === "buy") {
        const maximum = (quote.shares * 1005n + 999n) / 1000n;
        await approve(
          p.config,
          p.account,
          "atlasVault",
          p.config.tradingEngine,
          maximum,
          setTx,
        );
        await write(
          p.config,
          p.account,
          "tradingEngine",
          "buy",
          [asset.token, asset.stockId, quote.quantity, maximum, deadline],
          setTx,
        );
      } else {
        await approveCountry(p.config, p.account, asset.token, setTx);
        await write(
          p.config,
          p.account,
          "tradingEngine",
          "sell",
          [
            asset.token,
            asset.stockId,
            quote.quantity,
            (quote.shares * 995n) / 1000n,
            deadline,
          ],
          setTx,
        );
      }
      setQuote(null);
      await refresh();
    } catch (e) {
      setTx((current) =>
        current && current.state !== "confirmed"
          ? { ...current, state: "failed" }
          : current,
      );
      setError(protocolError(e));
    } finally {
      setBusy(false);
    }
  }
  const hasStaleHoldings = held.some((s) => s.price === null),
    holdingValue = held.reduce(
      (sum, s) =>
        sum +
        (s.price === null
          ? 0n
          : (s.balance * s.price) / 100000000000000000000n),
      0n,
    ),
    pnl = p.data ? holdingValue + p.data.sellAssets - p.data.buyAssets : 0n;
  return (
    <ProtocolFrame>
      <main className="protocol-content">
        <div className="section-heading">
          <div>
            <span className="eyebrow">FIVE MARKET CONTRACTS</span>
            <h1>Demo synthetic stocks</h1>
            <p>
              Trade stock representations with vault shares. Quotes and reserves
              are enforced onchain.
            </p>
          </div>
          <button
            className="btn secondary small"
            onClick={() => refresh().catch((e) => setError(protocolError(e)))}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        {!p.config?.configured || !p.data ? (
          <SetupState
            loading={p.loading}
            config={p.config}
            error={p.error}
            retry={p.reload}
          />
        ) : (
          <>
            <div className="protocol-metrics">
              <Metric
                label="AVAILABLE BUYING POWER"
                value={`${fmt(p.data.underlying)} USDT`}
              />
              <Metric
                label="STOCK MARKET VALUE"
                value={
                  hasStaleHoldings
                    ? "Price unavailable"
                    : `${fmt(holdingValue)} USDT`
                }
                note="Indicative value; sells require reserve liquidity"
              />
              <Metric
                label="INDICATIVE P/L"
                value={
                  hasStaleHoldings ? "Price unavailable" : `${fmt(pnl)} USDT`
                }
                note="Market value + net sells − buys; excludes transferred-in cost basis"
              />
            </div>
            <div className="protocol-trading-layout">
              <section>
                <div className="protocol-filters">
                  {regions.map(([id, label]) => (
                    <button
                      className={region === id ? "active" : ""}
                      key={id}
                      onClick={() => setRegion(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="panel table-scroll">
                  <table className="protocol-stock-table">
                    <thead>
                      <tr>
                        <th>Stock</th>
                        <th>Market</th>
                        <th>USDT price</th>
                        <th>Your holding</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((s) => (
                        <tr key={s.stockId}>
                          <td>
                            <strong>{s.ticker}</strong>
                            <small>{s.companyName}</small>
                          </td>
                          <td>
                            {s.exchange}
                            <small>{s.nativeCurrency}</small>
                          </td>
                          <td>
                            {s.price === null
                              ? "Unavailable"
                              : fmt(s.price, 8, 4)}
                          </td>
                          <td>{fmt(s.balance, 18, 6)}</td>
                          <td>
                            <span
                              className={
                                !s.active
                                  ? "negative"
                                  : s.price === null
                                    ? "negative"
                                    : "positive"
                              }
                            >
                              {!s.active
                                ? "Disabled"
                                : s.price === null
                                  ? "Stale / no quote"
                                  : "Price fresh"}
                            </span>
                          </td>
                          <td>
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => {
                                setSelected(s.stockId);
                                setQuote(null);
                                setError("");
                                setTx(null);
                                if (
                                  window.matchMedia("(max-width:1100px)")
                                    .matches
                                )
                                  document
                                    .getElementById("protocol-order")
                                    ?.scrollIntoView({
                                      behavior: "smooth",
                                      block: "start",
                                    });
                              }}
                            >
                              Trade
                              <ArrowRight size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {assets.length === 0 && (
                    <p className="protocol-loading">
                      Loading stocks from the five market contracts…
                    </p>
                  )}
                </div>
                <section className="panel protocol-allocation">
                  <h2>Stock and country allocation</h2>
                  {held.length === 0 ? (
                    <p>
                      Your synthetic holdings will appear after your first buy.
                    </p>
                  ) : (
                    <>
                      {held.map((s) => (
                        <div key={s.stockId}>
                          <span>
                            {s.ticker} · {s.region}
                          </span>
                          <strong>
                            {s.price === null
                              ? "Price unavailable"
                              : `${fmt((s.balance * s.price) / 100000000000000000000n)} USDT`}
                          </strong>
                        </div>
                      ))}
                      {regions.slice(1).map(([id, label]) => {
                        const value = held
                          .filter((s) => s.region === id)
                          .reduce(
                            (sum, s) =>
                              sum +
                              (s.price === null
                                ? 0n
                                : (s.balance * s.price) /
                                  100000000000000000000n),
                            0n,
                          );
                        return (
                          <div key={id}>
                            <span>{label}</span>
                            <strong>
                              {holdingValue === 0n
                                ? "0"
                                : Number((value * 10000n) / holdingValue) / 100}
                              %
                            </strong>
                          </div>
                        );
                      })}
                    </>
                  )}
                </section>
              </section>
              <aside id="protocol-order" className="panel protocol-order">
                <h2>{asset ? asset.ticker : "Choose an asset"}</h2>
                <p>
                  {asset
                    ? asset.companyName
                    : "Select a stock to review an executable quote."}
                </p>
                {asset && (
                  <>
                    <span className="demo-badge">
                      DEMO SYNTHETIC · {asset.nativeCurrency}
                    </span>
                    <div className="ens-tabs">
                      {(["buy", "sell"] as const).map((value) => (
                        <button
                          className={side === value ? "active" : ""}
                          disabled={busy}
                          key={value}
                          onClick={() => {
                            setSide(value);
                            setQuote(null);
                          }}
                        >
                          {value === "buy" ? "Buy" : "Sell"}
                        </button>
                      ))}
                    </div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void preview();
                      }}
                    >
                      <label>
                        Stock quantity
                        <input
                          required
                          inputMode="decimal"
                          value={quantity}
                          disabled={busy || !!quote}
                          onChange={(e) => {
                            setQuantity(e.target.value);
                            setQuote(null);
                          }}
                        />
                      </label>
                      {!quote && (
                        <button
                          className="btn primary full"
                          disabled={
                            busy || !!p.wallet?.demo || p.data.enginePaused
                          }
                        >
                          Review {side}
                        </button>
                      )}
                    </form>
                    {p.data.enginePaused && (
                      <p className="error-box">Trading is paused.</p>
                    )}
                    {quote && (
                      <div className="protocol-review">
                        <dl>
                          <dt>Gross value</dt>
                          <dd>{fmt(quote.assets)} USDT</dd>
                          <dt>Fee</dt>
                          <dd>{fmt(quote.fee, 6, 6)} USDT</dd>
                          <dt>
                            {side === "buy"
                              ? "Shares spent"
                              : "Shares received"}
                          </dt>
                          <dd>{fmt(quote.shares, 12, 6)} aUSDT</dd>
                        </dl>
                        <small>
                          0.5% quote protection. Selling requires operator
                          approval for this market contract; you can revoke it
                          in your wallet. Sells return vault shares and require
                          sufficient reserve liquidity.
                        </small>
                        <div>
                          <button
                            className="btn secondary small"
                            disabled={busy}
                            onClick={() => setQuote(null)}
                          >
                            Edit
                          </button>
                          <button
                            className="btn primary small"
                            disabled={busy}
                            onClick={submit}
                          >
                            Approve & {side}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {asset && <StockPriceHistory stockId={asset.stockId} />}
                <TransactionStatus tx={tx} error={error} />
                <p className="protocol-legal">
                  These assets are demo synthetic representations. They do not
                  confer legal ownership of real-world stocks.
                </p>
              </aside>
            </div>
          </>
        )}
      </main>
    </ProtocolFrame>
  );
}
