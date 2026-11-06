"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ExternalLink, History, Sparkles } from "lucide-react";
import { intentApi, type TradeHistory } from "@/lib/intent/client";

const money = (v: string | number, digits = 2) =>
  Number(v).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const signed = (v: string) =>
  `${Number(v) >= 0 ? "+" : "−"}${money(Math.abs(Number(v)))}`;
const REASON: Record<string, string> = {
  TAKE_PROFIT: "Take profit",
  TAKE_PROFIT_BPS: "Take profit",
  STOP_LOSS: "Stop loss",
  STOP_LOSS_BPS: "Stop loss",
  TIME_EXIT: "Time exit",
  PRICE_ABOVE: "Price target",
  PRICE_BELOW: "Price floor",
  MANUAL: "Closed by you",
  MANUAL_CLOSE: "Closed by you",
};
const STEP_LABEL: Record<string, string> = {
  pull: "aUSDT in",
  buy: "Buy",
  change: "Change",
  refund: "Refund",
  sell: "Sell",
  payout: "aUSDT out",
};
const STEP_HELP: Record<string, string> = {
  pull: "Atlas executor took your aUSDT through your MetaMask permission",
  buy: "Executor bought the stock on the Atlas trading engine",
  change: "Unused aUSDT returned to you",
  refund: "Buy failed; your aUSDT was returned",
  sell: "Executor sold the stock",
  payout: "Sale proceeds sent to you as aUSDT",
};
const reasonLabel = (r: string | null) =>
  r ? (REASON[r] ?? r.replace(/_/g, " ").toLowerCase()) : "Exit";

/** Fills executed by the wallet's Atlas AI trade plans, shown on the portfolio. */
export function AtlasTradesPanel() {
  const [data, setData] = useState<TradeHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      intentApi
        .trades()
        .then((d) => live && (setData(d), setError(null)))
        .catch((e: Error) => live && setError(e.message));
    void load();
    const t = setInterval(load, 10_000); // Plans keep filling in the background.
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const s = data?.summary;
  return (
    <section className="holdings-panel panel atlas-trades">
      <div className="section-heading">
        <div>
          <h2>
            <Sparkles size={18} /> Atlas AI trades
          </h2>
          <p>Every buy and sell executed by your Atlas AI trade plans.</p>
        </div>
        <span className="demo-badge">{s?.count ?? 0} TRADES</span>
      </div>

      {s && s.count > 0 && (
        <dl className="trade-summary">
          <div>
            <dt>Realized P&amp;L</dt>
            <dd
              className={
                Number(s.realizedPnlUSDT) >= 0 ? "positive" : "negative"
              }
            >
              {signed(s.realizedPnlUSDT)} USDT
            </dd>
          </div>
          <div>
            <dt>Traded volume</dt>
            <dd>{money(s.volumeUSDT)} USDT</dd>
          </div>
          <div>
            <dt>Fees paid</dt>
            <dd>{money(s.feesUSDT, 4)} USDT</dd>
          </div>
          <div>
            <dt>Open positions</dt>
            <dd>{s.openPositions}</dd>
          </div>
        </dl>
      )}

      {error && !data && <p className="muted">{error}</p>}

      {data && data.trades.length > 0 && (
        <div className="table-scroll">
          <table className="trades-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Side</th>
                <th>Time</th>
                <th className="num">Shares</th>
                <th className="num">Price</th>
                <th className="num">Amount</th>
                <th className="num">Fee</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.trades.map((t, i) => (
                <tr key={t.id}>
                  <td>
                    <span className={`stock-avatar stock-${i % 4}`}>
                      {t.symbol.slice(0, 1)}
                    </span>
                    <span>
                      <strong>{t.symbol}</strong>
                      <small title={t.prompt}>{t.companyName}</small>
                    </span>
                  </td>
                  <td>
                    <span className={`trade-side ${t.side.toLowerCase()}`}>
                      {t.side}
                    </span>
                    <small>{t.kind === "ENTRY" ? "Entry" : "Exit"}</small>
                  </td>
                  <td>
                    {new Date(t.executedAt * 1000).toLocaleTimeString()}
                    <small>
                      {new Date(t.executedAt * 1000).toLocaleDateString()}
                    </small>
                  </td>
                  <td className="num mono">{Number(t.quantity).toFixed(4)}</td>
                  <td className="num mono">${money(t.priceUSDT)}</td>
                  <td className="num mono">{money(t.notionalUSDT)} USDT</td>
                  <td className="num mono">{money(t.feeUSDT, 4)}</td>
                  <td>
                    {t.kind === "EXIT" ? (
                      <>
                        {t.realizedPnlUSDT !== null && (
                          <span
                            className={
                              Number(t.realizedPnlUSDT) >= 0
                                ? "positive"
                                : "negative"
                            }
                          >
                            {signed(t.realizedPnlUSDT)} USDT
                          </span>
                        )}
                        <small>{reasonLabel(t.exitReason)}</small>
                      </>
                    ) : (
                      <span className="muted">Position opened</span>
                    )}
                    {t.mode === "SIMULATED" ? (
                      <small>Simulated</small>
                    ) : (
                      <span className="trade-txs">
                        {(t.transactions?.length
                          ? t.transactions
                          : t.txHash
                            ? [
                                {
                                  step: t.kind === "ENTRY" ? "buy" : "sell",
                                  txHash: t.txHash,
                                },
                              ]
                            : []
                        ).map((x) => (
                          <a
                            key={x.step}
                            className="trade-tx"
                            href={`https://sepolia.etherscan.io/tx/${x.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={STEP_HELP[x.step] ?? x.step}
                          >
                            {STEP_LABEL[x.step] ?? x.step}{" "}
                            <ExternalLink size={11} />
                          </a>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.trades.length === 0 && (
        <div className="empty-state">
          <History />
          <h3>No Atlas AI trades yet</h3>
          <p>Describe a trade and Atlas AI will execute it for you.</p>
          <Link className="btn secondary small" href="/intent/new">
            Trade with Atlas AI <ArrowUpRight size={14} />
          </Link>
        </div>
      )}

      <div className="holdings-footnote">
        <Link className="text-button" href="/intent">
          View all Atlas AI plans <ArrowUpRight size={13} />
        </Link>
      </div>
    </section>
  );
}
