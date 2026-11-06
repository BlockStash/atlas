"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FlaskConical, Loader2, Play, Rocket } from "lucide-react";
import {
  CREATOR_FEE_BPS,
  MARKET_FLAG,
  describeRule,
  pct,
  performanceFor,
  sameAddress,
  usd,
  type Performance,
  type Strategy,
} from "@/lib/strategies";
import { useAtlas } from "@/components/atlas/provider";
import { StrategyIconBadge } from "@/components/strategies/icon";
import {
  AllocationBar,
  EnsHandle,
  EquityChart,
  ReturnsRow,
  assetColor,
  useStrategyStore,
} from "@/components/strategies/ui";

type Tab = "backtest" | "paper" | "deploy";
const TABS = [
  ["backtest", FlaskConical, "Backtest"],
  ["paper", Play, "Paper trade"],
  ["deploy", Rocket, "Deploy"],
] as const;
const BACKTEST_CAPITAL = 10_000;

/**
 * A multi-stock plan built from the chat prompt as an executable Atlas strategy:
 * saved privately, backtested automatically, then paper traded or deployed from right here.
 */
export function PortfolioPlan({ strategyId }: { strategyId: string }) {
  const { wallet, toast } = useAtlas();
  const store = useStrategyStore();
  const s = store.get(strategyId);
  const [tab, setTab] = useState<Tab>("backtest");
  const [perf, setPerf] = useState<Performance | null>(null);
  const [testing, setTesting] = useState(false);
  const [amount, setAmount] = useState("1000");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ran = useRef<string | null>(null);

  // Backtest automatically once the strategy exists, so the graph shows straight away.
  useEffect(() => {
    if (!s || ran.current === s.id) return;
    ran.current = s.id;
    setTesting(true);
    store
      .runBacktest(s.id, BACKTEST_CAPITAL)
      .then(setPerf, (e: Error) => setError(e.message))
      .finally(() => setTesting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.id]);

  if (!s)
    return (
      <div className="studio-empty">
        <Loader2 className="spin" size={22} />
        <p>Saving your strategy…</p>
      </div>
    );

  const spec = s.spec;
  const bt = perf ?? performanceFor(s, "backtest");
  const value = Number(amount);
  const fee =
    tab === "deploy" && !sameAddress(s.originalCreator.address, wallet?.address)
      ? (value * CREATOR_FEE_BPS) / 10_000
      : 0;
  const positions = store.positions.filter((p) => p.strategyId === s.id);

  async function start(mode: "paper" | "live") {
    setError(null);
    if (!(value >= spec.execution.minDeployment))
      return setError(`Minimum is ${spec.execution.minDeployment} aUSDT.`);
    setBusy(true);
    try {
      await store.start(s!.id, mode, value);
      setAck(false);
      toast(
        mode === "paper"
          ? `Paper trade started on “${s!.name}” with ${usd(value)} virtual aUSDT.`
          : `Deployed ${usd(value)} aUSDT to “${s!.name}” (demo).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="portfolio-head">
        <StrategyIconBadge icon={s.icon} size={48} />
        <div>
          <h3>{s.name}</h3>
          <p className="muted">{s.tagline}</p>
          <div className="portfolio-ids">
            <EnsHandle ens={s.ens} />
            <span className="muted">
              Saved privately ·{" "}
              <Link className="text-button" href={`/strategies/${s.id}`}>
                open strategy page
              </Link>
            </span>
          </div>
        </div>
      </div>

      <div className="portfolio-alloc">
        <AllocationBar universe={spec.universe} />
        <ul>
          {spec.universe.map((a, i) => (
            <li key={a.symbol}>
              <i style={{ background: assetColor(i) }} />
              <span>
                {MARKET_FLAG[a.market]} <b>{a.symbol}</b>{" "}
                <span className="muted">{a.name}</span>
              </span>
              <strong>{a.weight}%</strong>
            </li>
          ))}
        </ul>
      </div>

      <dl className="run-facts portfolio-facts">
        <dt>Risk profile</dt>
        <dd className="capitalize">{spec.riskProfile}</dd>
        <dt>Rebalance</dt>
        <dd className="capitalize">
          {spec.rebalance.frequency} · ±{spec.rebalance.driftTolerancePct}%
          drift
        </dd>
        <dt>Stop loss</dt>
        <dd>{spec.risk.stopLossPct ? `−${spec.risk.stopLossPct}%` : "None"}</dd>
        <dt>Take profit</dt>
        <dd>
          {spec.risk.takeProfitPct ? `+${spec.risk.takeProfitPct}%` : "None"}
        </dd>
        {spec.rules.length > 0 && (
          <>
            <dt>Rules</dt>
            <dd>
              {spec.rules.map((r) => (
                <div key={r.id}>{describeRule(r)}</div>
              ))}
            </dd>
          </>
        )}
      </dl>

      <section className="run-trade">
        <h3>Run this strategy</h3>
        <div className="ens-tabs run-tabs" role="tablist">
          {TABS.map(([t, Icon, label]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "active" : ""}
              onClick={() => {
                setTab(t);
                setError(null);
                setAck(false);
              }}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === "backtest" && (
          <div className="bt-panel">
            <header className="bt-head">
              <div>
                <span className="eyebrow">BACKTEST BEFORE YOU DEPLOY</span>
                <h3>1 year on {usd(BACKTEST_CAPITAL, 0)} aUSDT</h3>
              </div>
              {testing && <Loader2 className="spin" size={16} />}
            </header>
            {!bt ? (
              <div className="bt-skeleton" aria-label="Running backtest" />
            ) : (
              <div className={testing ? "bt-body loading" : "bt-body"}>
                <EquityChart curve={bt.curve} height={220} />
                <ReturnsRow perf={bt} />
                <dl className="bt-stats">
                  <div>
                    <dt>Total return</dt>
                    <dd
                      className={bt.totalReturn >= 0 ? "positive" : "negative"}
                    >
                      {pct(bt.totalReturn)}
                    </dd>
                  </div>
                  <div>
                    <dt>Ending value</dt>
                    <dd>{usd(bt.value)}</dd>
                  </div>
                  <div>
                    <dt>Max drawdown</dt>
                    <dd className="negative">
                      −{(bt.maxDrawdown * 100).toFixed(1)}%
                    </dd>
                  </div>
                </dl>
                <p className="intent-disclaimer">
                  Simulated backtest of this spec for demo purposes. Not
                  historical performance and not a forecast.
                </p>
              </div>
            )}
          </div>
        )}

        {(tab === "paper" || tab === "deploy") && (
          <div className="run-card">
            <p>
              {tab === "paper"
                ? "Paper trade this strategy with virtual aUSDT. It tracks the same rules and rebalancing as a live deployment."
                : "Deploy aUSDT from your vault into this strategy. Atlas holds the weights, rebalances and applies your risk rules."}
            </p>
            <label className="portfolio-amount">
              <span>Amount (aUSDT)</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) =>
                  setAmount(e.target.value.replace(/[^\d.]/g, ""))
                }
              />
              <small className="muted">
                Minimum {spec.execution.minDeployment} aUSDT
                {fee > 0 &&
                  ` · ${CREATOR_FEE_BPS / 100}% creator fee ${usd(fee)} aUSDT`}
              </small>
            </label>
            {tab === "deploy" && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                I reviewed the allocation and rules. Returns are not guaranteed.
              </label>
            )}
            <div className="intent-actions">
              <button
                className="btn primary"
                disabled={busy || !(value > 0) || (tab === "deploy" && !ack)}
                onClick={() => void start(tab === "paper" ? "paper" : "live")}
              >
                {tab === "paper" ? <Play size={14} /> : <Rocket size={14} />}{" "}
                {busy
                  ? "Starting…"
                  : tab === "paper"
                    ? "Start paper trade"
                    : `Deploy ${value > 0 ? usd(value) : ""} aUSDT`}
              </button>
            </div>
          </div>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        {positions.length > 0 && (
          <ul className="portfolio-positions">
            {positions.map((p) => (
              <li key={p.id}>
                <span className={`strategy-mode ${p.mode}`}>
                  {p.mode === "live" ? "Live" : "Paper"}
                </span>
                {usd(p.capital)} aUSDT · started{" "}
                {new Date(p.startedAt).toLocaleDateString()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
