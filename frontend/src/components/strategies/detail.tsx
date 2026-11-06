"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Copy,
  FlaskConical,
  GitFork,
  Globe2,
  Loader2,
  Lock,
  Pencil,
  Play,
  Rocket,
  Square,
  Trash2,
  Coins,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { DashboardShell } from "@/components/dashboard/shell";
import {
  CREATOR_FEE_BPS,
  MARKET_FLAG,
  PERIODS,
  creatorFee,
  iconKey as iconKeyOf,
  describeRule,
  performanceFor,
  positionPerformance,
  pct,
  sameAddress,
  usd,
  type Performance,
  type RunMode,
  type Strategy,
} from "@/lib/strategies";
import { StrategyStudio } from "./studio";
import { IconPicker, StrategyIconBadge } from "./icon";
import {
  CreatorName,
  EnsHandle,
  EquityChart,
  MarketChips,
  MODE_LABEL,
  Ret,
  VisibilityBadge,
  useStrategyStore,
} from "./ui";

const MODES: RunMode[] = ["backtest", "paper", "live"];
/** Demo-only buying power until this reads the Atlas Vault. */
const DEMO_BUYING_POWER = 25_000;

export function StrategyDetailPage({ id }: { id: string }) {
  const { wallet, toast } = useAtlas();
  const store = useStrategyStore();
  const router = useRouter();
  const params = useSearchParams();
  const s = store.get(id);
  const [editing, setEditing] = useState(params.get("edit") === "1");
  const [adhoc, setAdhoc] = useState<Performance | null>(null);
  const [mode, setMode] = useState<RunMode | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [iconPicker, setIconPicker] = useState(false);

  if (!store.loaded) return <DashboardShell>{null}</DashboardShell>;
  if (!s)
    return (
      <DashboardShell>
        <main className="protocol-content">
          <div className="panel protocol-empty">
            <h2>
              {store.error ? "Couldn’t load strategies" : "Strategy not found"}
            </h2>
            <p>
              {store.error ??
                "It may be private, deleted, or the link is wrong."}
            </p>
            <Link className="btn secondary small" href="/strategies">
              Back to strategies
            </Link>
          </div>
        </main>
      </DashboardShell>
    );

  const owner = sameAddress(s.creator.address, wallet?.address);
  const perf: Record<RunMode, Performance | null> = {
    backtest: adhoc ?? performanceFor(s, "backtest"),
    paper: performanceFor(s, "paper"),
    live: performanceFor(s, "live"),
  };
  const active: RunMode =
    mode ??
    (MODES.slice()
      .reverse()
      .find((m) => perf[m]) ||
      "backtest");
  const current = perf[active];
  const positions = store.positions.filter((p) => p.strategyId === s.id);

  async function clone() {
    try {
      const copy = await store.clone(s!.id);
      toast("Cloned to My strategies. Tweak it before deploying.");
      router.push(`/strategies/${copy.id}?edit=1`);
      setEditing(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not clone this strategy.");
    }
  }

  if (editing && owner)
    return (
      <DashboardShell>
        <main className="protocol-content strategies-page studio-page">
          <button
            className="text-button strategy-back"
            onClick={() => setEditing(false)}
          >
            <ArrowLeft size={13} /> Back to strategy
          </button>
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                EDIT STRATEGY{s.forkedFrom ? " · CLONE" : ""}
              </span>
              <h1>Refine with Atlas AI</h1>
              <p>
                {s.forkedFrom ? (
                  <>
                    Cloned from “{s.forkedFrom.name}”. Tweak the prompt, weights
                    or rules —{" "}
                    <CreatorName
                      name={s.originalCreator.name}
                      address={s.originalCreator.address}
                    />{" "}
                    still earns {CREATOR_FEE_BPS / 100}% when you deploy.
                  </>
                ) : (
                  "Changing the allocation or rules resets the backtest and paper track record."
                )}
              </p>
            </div>
          </div>
          <StrategyStudio
            initial={s}
            showVisibility={false}
            submitLabel="Save changes"
            onCancel={() => setEditing(false)}
            onSubmit={async (v) => {
              try {
                await store.update(s.id, {
                  name: v.name,
                  tagline: v.tagline,
                  prompt: v.prompt,
                  spec: v.spec,
                  ...(v.icon ? { icon: v.icon } : {}),
                });
              } catch (e) {
                return toast(
                  e instanceof Error ? e.message : "Could not save changes.",
                );
              }
              setEditing(false);
              setAdhoc(null);
              toast("Strategy updated.");
              router.replace(`/strategies/${s.id}`);
            }}
          />
        </main>
      </DashboardShell>
    );

  return (
    <DashboardShell>
      <main className="protocol-content strategies-page">
        <Link
          className="text-button strategy-back"
          href={owner ? "/strategies/mine" : "/strategies"}
        >
          <ArrowLeft size={13} />{" "}
          {owner ? "My strategies" : "Explore strategies"}
        </Link>
        <div className="section-heading strategy-detail-head">
          <div>
            <span className="eyebrow">
              {s.spec.riskProfile.toUpperCase()} ·{" "}
              {s.spec.rebalance.frequency.toUpperCase()} REBALANCE ·{" "}
              {s.spec.universe.length} ASSETS
            </span>
            <div className="strategy-title-row">
              {owner ? (
                <button
                  type="button"
                  className="strategy-icon-edit"
                  aria-label="Change strategy icon"
                  aria-expanded={iconPicker}
                  title="Change icon"
                  onClick={() => setIconPicker(!iconPicker)}
                >
                  <StrategyIconBadge icon={s.icon} size={60} />
                  <Pencil size={12} />
                </button>
              ) : (
                <StrategyIconBadge icon={s.icon} size={60} />
              )}
              <h1>{s.name}</h1>
            </div>
            {owner && iconPicker && (
              <IconPicker
                value={s.icon}
                taken={
                  new Set(
                    store.strategies
                      .filter((x) => x.id !== s.id)
                      .map((x) => iconKeyOf(x.icon)),
                  )
                }
                onChange={(icon) => {
                  store.update(s.id, { icon }).then(
                    () => toast("Icon updated."),
                    (e: Error) => toast(e.message),
                  );
                }}
              />
            )}
            <p>{s.tagline}</p>
            <div className="strategy-byline">
              <EnsHandle ens={s.ens} />
              <VisibilityBadge visibility={s.visibility} />
              <span>
                by{" "}
                <CreatorName
                  name={s.creator.name}
                  address={s.creator.address}
                  you={owner}
                />
              </span>
              {s.forkedFrom && (
                <Link href={`/strategies/${s.forkedFrom.id}`}>
                  <GitFork size={12} /> forked from {s.forkedFrom.name}
                </Link>
              )}
              <MarketChips markets={s.spec.universe.map((a) => a.market)} />
            </div>
          </div>
          <div className="strategy-head-actions">
            <Link className="text-button" href="/paper">
              Test in Paper Trading ↗
            </Link>
            {owner ? (
              <>
                <button
                  className="btn secondary small"
                  onClick={() => setEditing(true)}
                >
                  <Pencil size={14} /> Edit
                </button>
                <button
                  className="btn secondary small"
                  onClick={() => {
                    const next =
                      s.visibility === "public" ? "private" : "public";
                    store.setVisibility(s.id, next).then(
                      () =>
                        toast(
                          next === "public"
                            ? `Published. Others can now clone and deploy it — you earn ${CREATOR_FEE_BPS / 100}% of their deployments.`
                            : "Strategy is private again. Existing deployments by others keep running.",
                        ),
                      (e: Error) => toast(e.message),
                    );
                  }}
                >
                  {s.visibility === "public" ? (
                    <Lock size={14} />
                  ) : (
                    <Globe2 size={14} />
                  )}
                  {s.visibility === "public" ? "Make private" : "Make public"}
                </button>
                <button
                  className="btn secondary small"
                  aria-label="Delete strategy"
                  onClick={() => {
                    if (s.stats.deployers > 0)
                      return toast(
                        "Others have deployed this strategy — make it private instead of deleting.",
                      );
                    store.remove(s.id).then(
                      () => {
                        toast("Strategy deleted.");
                        router.push("/strategies/mine");
                      },
                      (e: Error) => toast(e.message),
                    );
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </>
            ) : (
              <button className="btn primary small" onClick={clone}>
                <GitFork size={14} /> Clone & tweak
              </button>
            )}
          </div>
        </div>

        <div className="protocol-trading-layout strategy-detail-layout">
          <div className="strategy-detail-main">
            <section className="panel strategy-perf">
              <div className="strategy-perf-head">
                <h2>Performance</h2>
                <div className="ens-tabs">
                  {MODES.map((m) => (
                    <button
                      key={m}
                      className={active === m ? "active" : ""}
                      onClick={() => setMode(m)}
                    >
                      {MODE_LABEL[m]}
                      {!perf[m] && <small> · none</small>}
                    </button>
                  ))}
                </div>
              </div>
              {current ? (
                <>
                  <div className="strategy-perf-stats">
                    {PERIODS.map((p) => (
                      <div key={p}>
                        <span>{p} return</span>
                        <strong>
                          <Ret v={current.returns[p]} />
                        </strong>
                      </div>
                    ))}
                    <div>
                      <span>Max drawdown</span>
                      <strong className="negative">
                        {current.days
                          ? `-${(current.maxDrawdown * 100).toFixed(1)}%`
                          : "—"}
                      </strong>
                    </div>
                    <div>
                      <span>Sharpe</span>
                      <strong>
                        {current.days > 20 ? current.sharpe.toFixed(2) : "—"}
                      </strong>
                    </div>
                  </div>
                  <EquityChart curve={current.curve} height={190} />
                  <p className="strategy-perf-note">
                    {active === "backtest"
                      ? `Simulated over the last 365 days on ${usd(current.capital, 0)} aUSDT → ${usd(current.value)} (${pct(current.totalReturn)}).`
                      : `Running ${current.days} day${current.days === 1 ? "" : "s"} since ${new Date(current.startedAt).toLocaleDateString()} on ${usd(current.capital, 0)} aUSDT → ${usd(current.value)} (${pct(current.totalReturn)}). Periods appear once enough history exists.`}
                  </p>
                </>
              ) : (
                <div className="strategy-chart-empty" style={{ height: 230 }}>
                  {active === "backtest"
                    ? "No backtest yet — run one from the panel on the right."
                    : active === "paper"
                      ? owner
                        ? "Not paper traded yet. Start a paper trade to build a forward track record."
                        : "The creator hasn’t published a paper-trading record."
                      : owner
                        ? "Not deployed yet. Deploy real assets when you trust the results."
                        : "The creator hasn’t deployed this strategy with real funds."}
                </div>
              )}
            </section>

            <section className="panel strategy-compare">
              <h2>Track record</h2>
              <table className="strategy-table">
                <thead>
                  <tr>
                    <th>Mode</th>
                    {PERIODS.map((p) => (
                      <th key={p}>{p}</th>
                    ))}
                    <th>Since start</th>
                  </tr>
                </thead>
                <tbody>
                  {MODES.map((m) => (
                    <tr key={m}>
                      <td>
                        <span className={`strategy-mode ${m}`}>
                          {MODE_LABEL[m]}
                        </span>
                      </td>
                      {PERIODS.map((p) => (
                        <td key={p}>
                          <Ret v={perf[m]?.returns[p]} />
                        </td>
                      ))}
                      <td>
                        <Ret v={perf[m]?.totalReturn} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {positions.length > 0 && (
              <section className="panel strategy-compare">
                <h2>Your positions</h2>
                <table className="strategy-table">
                  <thead>
                    <tr>
                      <th>Mode</th>
                      <th>Started</th>
                      <th>Capital</th>
                      <th>Value</th>
                      <th>Return</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => {
                      const pp = positionPerformance(s, p);
                      return (
                        <tr key={p.id}>
                          <td>
                            <span className={`strategy-mode ${p.mode}`}>
                              {p.mode === "live" ? "Live" : "Paper"}
                            </span>
                          </td>
                          <td>{new Date(p.startedAt).toLocaleDateString()}</td>
                          <td>{usd(p.capital)}</td>
                          <td>{usd(pp.value)}</td>
                          <td>
                            <Ret v={pp.totalReturn} />
                          </td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => {
                                store.stop(p.id).then(
                                  () =>
                                    toast(
                                      p.mode === "live"
                                        ? "Withdrawal queued (demo) — funds return to your vault balance."
                                        : "Paper trade stopped.",
                                    ),
                                  (e: Error) => toast(e.message),
                                );
                              }}
                            >
                              <Square size={11} />{" "}
                              {p.mode === "live" ? "Withdraw" : "Stop"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}

            <section className="panel strategy-spec">
              <div className="strategy-perf-head">
                <h2>Strategy definition</h2>
                <div className="strategy-spec-actions">
                  <button
                    className="text-button"
                    onClick={() => setShowJson(!showJson)}
                  >
                    {showJson ? "Hide" : "View"} JSON spec
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      navigator.clipboard
                        ?.writeText(JSON.stringify(s.spec, null, 2))
                        .then(
                          () => toast("Spec copied."),
                          () => toast("Could not copy."),
                        );
                    }}
                  >
                    <Copy size={12} /> Copy
                  </button>
                </div>
              </div>
              <blockquote className="strategy-quote">“{s.prompt}”</blockquote>
              {showJson ? (
                <pre className="strategy-json">
                  {JSON.stringify(s.spec, null, 2)}
                </pre>
              ) : (
                <>
                  <h3>Allocation</h3>
                  <div className="strategy-alloc">
                    {s.spec.universe.map((a) => (
                      <div key={a.symbol}>
                        <span>
                          {MARKET_FLAG[a.market]} <strong>{a.symbol}</strong>{" "}
                          <small>{a.name}</small>
                        </span>
                        <i style={{ width: `${a.weight}%` }} />
                        <b>{a.weight}%</b>
                      </div>
                    ))}
                  </div>
                  <h3>Rules</h3>
                  <ul className="strategy-rules">
                    {s.spec.rules.length ? (
                      s.spec.rules.map((r) => (
                        <li key={r.id}>{describeRule(r)}</li>
                      ))
                    ) : (
                      <li className="muted">
                        No signal rules — holds target weights.
                      </li>
                    )}
                    <li>
                      Rebalance {s.spec.rebalance.frequency} or when any weight
                      drifts more than {s.spec.rebalance.driftTolerancePct}%.
                    </li>
                  </ul>
                  <h3>Risk controls</h3>
                  <dl className="strategy-risk">
                    <div>
                      <dt>Stop loss</dt>
                      <dd>
                        {s.spec.risk.stopLossPct
                          ? `${s.spec.risk.stopLossPct}%`
                          : "Off"}
                      </dd>
                    </div>
                    <div>
                      <dt>Take profit</dt>
                      <dd>
                        {s.spec.risk.takeProfitPct
                          ? `${s.spec.risk.takeProfitPct}%`
                          : "Off"}
                      </dd>
                    </div>
                    <div>
                      <dt>Max per asset</dt>
                      <dd>{s.spec.risk.maxAssetWeightPct}%</dd>
                    </div>
                    <div>
                      <dt>Cash buffer</dt>
                      <dd>{s.spec.risk.cashBufferPct}%</dd>
                    </div>
                    <div>
                      <dt>Max slippage</dt>
                      <dd>{s.spec.execution.maxSlippageBps / 100}%</dd>
                    </div>
                    <div>
                      <dt>Min deployment</dt>
                      <dd>{s.spec.execution.minDeployment} aUSDT</dd>
                    </div>
                  </dl>
                </>
              )}
            </section>
          </div>

          <aside className="strategy-side">
            <RunPanel
              s={s}
              owner={owner}
              account={wallet?.address}
              onBacktest={async (capital) => {
                const r = await store.runBacktest(s.id, capital);
                if (!owner) setAdhoc(r);
                else setAdhoc(null);
                setMode("backtest");
                toast(`Backtest complete: ${pct(r.totalReturn)} over 1 year.`);
              }}
              onStart={async (m, amount) => {
                await store.start(s.id, m, amount);
                setMode(owner ? m : active);
                toast(
                  m === "paper"
                    ? "Paper trade started with virtual funds."
                    : `Deployed ${usd(amount)} aUSDT (demo).`,
                );
              }}
            />
            <section className="panel protocol-explainer strategy-economics">
              <h2>
                <Coins size={17} /> Creator economics
              </h2>
              <p>
                Whenever someone deploys real funds into this strategy — or any
                clone of it —{" "}
                <CreatorName
                  name={s.originalCreator.name}
                  address={s.originalCreator.address}
                  you={sameAddress(s.originalCreator.address, wallet?.address)}
                />{" "}
                receive
                {sameAddress(s.originalCreator.address, wallet?.address)
                  ? ""
                  : "s"}{" "}
                {CREATOR_FEE_BPS / 100}% of the amount deployed, paid once at
                deployment.
              </p>
              <dl className="strategy-risk">
                <div>
                  <dt>Deployed by others</dt>
                  <dd>{usd(s.stats.aum, 0)} aUSDT</dd>
                </div>
                <div>
                  <dt>Deployers</dt>
                  <dd>{s.stats.deployers}</dd>
                </div>
                <div>
                  <dt>Clones</dt>
                  <dd>{s.stats.clones}</dd>
                </div>
                <div>
                  <dt>Creator earned</dt>
                  <dd>{usd(s.stats.creatorEarnings)} aUSDT</dd>
                </div>
              </dl>
              {owner && s.visibility === "private" && (
                <small className="muted">
                  Private — publish it to let others discover, clone and deploy
                  it.
                </small>
              )}
            </section>
          </aside>
        </div>
      </main>
    </DashboardShell>
  );
}

function RunPanel({
  s,
  owner,
  account,
  onBacktest,
  onStart,
}: {
  s: Strategy;
  owner: boolean;
  account?: string;
  onBacktest: (capital: number) => Promise<void>;
  onStart: (mode: "paper" | "live", amount: number) => Promise<void>;
}) {
  const [tab, setTab] = useState<"backtest" | "paper" | "deploy">("backtest"),
    [amount, setAmount] = useState("10000"),
    [review, setReview] = useState(false),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const value = Number(amount);
  const feeApplies = !sameAddress(s.originalCreator.address, account);
  const fee = tab === "deploy" && feeApplies ? creatorFee(value || 0) : 0;
  const net = (value || 0) - fee;

  async function go() {
    setError("");
    if (!(value > 0)) return setError("Enter an amount greater than zero.");
    if (tab !== "backtest" && value < s.spec.execution.minDeployment)
      return setError(`Minimum is ${s.spec.execution.minDeployment} aUSDT.`);
    if (tab === "deploy" && value > DEMO_BUYING_POWER)
      return setError("Amount exceeds your vault buying power.");
    if (tab === "deploy" && !review) return setReview(true);
    setBusy(true);
    try {
      if (tab === "backtest") await onBacktest(value);
      else await onStart(tab === "paper" ? "paper" : "live", value);
      setReview(false);
      setAck(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel protocol-order strategy-run">
      <h2>Run this strategy</h2>
      <div className="ens-tabs">
        {(
          [
            ["backtest", FlaskConical, "Backtest"],
            ["paper", Play, "Paper trade"],
            ["deploy", Rocket, "Deploy"],
          ] as const
        ).map(([t, Icon, label]) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            disabled={busy}
            onClick={() => {
              setTab(t);
              setReview(false);
              setError("");
              setAmount(t === "deploy" ? "1000" : "10000");
            }}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>
      <p>
        {tab === "backtest" ? (
          "Replay the strategy over the last year of prices to see 3M, 6M and 1Y returns, drawdown and Sharpe."
        ) : tab === "paper" ? (
          "Run the strategy forward with virtual aUSDT. Nothing is bought, but trades and returns are tracked live."
        ) : (
          <>
            Buy the real assets with aUSDT from your Atlas Vault.{" "}
            {feeApplies ? (
              <>
                {CREATOR_FEE_BPS / 100}% goes to{" "}
                <CreatorName
                  name={s.originalCreator.name}
                  address={s.originalCreator.address}
                />
                , the original creator.
              </>
            ) : (
              "You are the original creator, so no creator fee applies."
            )}
          </>
        )}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <label>
          {tab === "backtest"
            ? "Starting capital (aUSDT)"
            : tab === "paper"
              ? "Virtual capital (aUSDT)"
              : "Amount to deploy (aUSDT)"}
          <input
            inputMode="decimal"
            value={amount}
            disabled={busy || review}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
        {tab === "deploy" && (
          <small className="muted">
            Vault buying power (demo): {usd(DEMO_BUYING_POWER)} aUSDT
          </small>
        )}
        {tab === "deploy" && review && (
          <div className="protocol-review">
            <h3>Review deployment</h3>
            <dl>
              <dt>Amount</dt>
              <dd>{usd(value)} aUSDT</dd>
              <dt>Creator fee ({CREATOR_FEE_BPS / 100}%)</dt>
              <dd>
                {fee ? (
                  <>
                    {usd(fee, 4)} →{" "}
                    <CreatorName
                      name={s.originalCreator.name}
                      address={s.originalCreator.address}
                    />
                  </>
                ) : (
                  "None"
                )}
              </dd>
              <dt>Invested</dt>
              <dd>{usd(net)} aUSDT</dd>
              <dt>Max slippage</dt>
              <dd>{s.spec.execution.maxSlippageBps / 100}%</dd>
            </dl>
            <div className="strategy-alloc small">
              {s.spec.universe.map((a) => (
                <div key={a.symbol}>
                  <span>
                    {MARKET_FLAG[a.market]} {a.symbol}
                  </span>
                  <i style={{ width: `${a.weight}%` }} />
                  <b>{usd((net * a.weight) / 100)}</b>
                </div>
              ))}
            </div>
            <label className="strategy-ack">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I understand this buys real (synthetic) assets and returns are not
              guaranteed.
            </label>
            <small>
              Demo build: no transaction is sent. The backend will route this
              through the vault and trading engine.
            </small>
          </div>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="strategy-run-actions">
          {review && (
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => setReview(false)}
            >
              Edit
            </button>
          )}
          <button
            className="btn primary full"
            disabled={busy || (review && !ack)}
          >
            {busy ? (
              <Loader2 className="spin" size={15} />
            ) : review ? (
              <Check size={15} />
            ) : null}
            {busy
              ? tab === "backtest"
                ? "Running backtest…"
                : tab === "paper"
                  ? "Starting…"
                  : "Deploying…"
              : tab === "backtest"
                ? "Run backtest"
                : tab === "paper"
                  ? "Start paper trade"
                  : review
                    ? "Confirm deployment"
                    : "Review deployment"}
          </button>
        </div>
      </form>
      {!owner && tab === "backtest" && (
        <small className="muted">
          Your backtest is shown to you only; the creator’s published record
          stays unchanged.
        </small>
      )}
    </section>
  );
}
