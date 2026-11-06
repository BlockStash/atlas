"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  AtSign,
  Bot,
  Braces,
  Check,
  Globe2,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Lock,
  PieChart,
  Plus,
  Sparkles,
  Trash2,
  User,
  Wand2,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import {
  ASSETS,
  CREATOR_FEE_BPS,
  MARKET_FLAG,
  MARKET_LABEL,
  PERIODS,
  describeRule,
  generateSpec,
  isEns,
  normalizeWeights,
  simulate,
  strategyHandle,
  validateSpec,
  type Frequency,
  type RiskProfile,
  type StrategyIcon,
  type StrategySpec,
  type Visibility,
  iconKey,
  pickIcon,
} from "@/lib/strategies";
import { IconPicker, StrategyIconBadge } from "./icon";
import {
  AllocationBar,
  EquityChart,
  Ret,
  assetColor,
  useStrategyStore,
} from "./ui";

export interface EditorValue {
  /** Set when editing an existing strategy, so its own icon is not counted as taken. */
  id?: string;
  icon?: StrategyIcon | null;
  name: string;
  tagline: string;
  prompt: string;
  spec: StrategySpec;
  visibility: Visibility;
}

interface Message {
  id: number;
  role: "user" | "ai";
  text: string;
  bullets?: string[];
}

const STARTERS = [
  "Safe dividend income from Indian and UK bluechips, rebalance quarterly with an 8% stop loss",
  "Aggressive AI tech momentum across US and Europe, add on RSI oversold, weekly rebalance",
  "60% BTC 40% ETH, buy the 15% dip, take profit at 40%",
  "Diversified global balanced portfolio with a small crypto sleeve, monthly rebalance",
];
const REFINES = [
  "Make it more conservative",
  "Rebalance weekly",
  "Add a 10% stop loss",
  "Add BTC",
  "Buy the 10% dip",
  "Add a trend filter",
];
const STEPS = [
  "Reading your intent",
  "Selecting assets across markets",
  "Setting risk and rebalance rules",
  "Compiling atlas.strategy/v1 spec",
  "Simulating one year of returns",
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Tab = "overview" | "allocation" | "rules" | "json";

function summarize(spec: StrategySpec) {
  const markets = [...new Set(spec.universe.map((a) => a.market))]
    .map((m) => MARKET_LABEL[m])
    .join(", ");
  return `A ${spec.riskProfile} strategy with ${spec.universe.length} assets across ${markets}. It rebalances ${spec.rebalance.frequency}${spec.risk.stopLossPct ? `, with a ${spec.risk.stopLossPct}% stop loss` : ""}${spec.rules.length ? ` and ${spec.rules.length} signal rule${spec.rules.length === 1 ? "" : "s"}` : ""}.`;
}

function diff(prev: StrategySpec, next: StrategySpec) {
  const out: string[] = [];
  const before = new Set(prev.universe.map((a) => a.symbol));
  const after = new Set(next.universe.map((a) => a.symbol));
  const added = [...after].filter((s) => !before.has(s));
  const removed = [...before].filter((s) => !after.has(s));
  if (added.length) out.push(`Added ${added.join(", ")}`);
  if (removed.length) out.push(`Removed ${removed.join(", ")}`);
  if (prev.riskProfile !== next.riskProfile)
    out.push(`Risk ${prev.riskProfile} → ${next.riskProfile}`);
  if (prev.rebalance.frequency !== next.rebalance.frequency)
    out.push(
      `Rebalance ${prev.rebalance.frequency} → ${next.rebalance.frequency}`,
    );
  if (prev.risk.stopLossPct !== next.risk.stopLossPct)
    out.push(
      `Stop loss ${prev.risk.stopLossPct ?? "off"}% → ${next.risk.stopLossPct ?? "off"}%`,
    );
  if (prev.rules.length !== next.rules.length)
    out.push(`Signal rules ${prev.rules.length} → ${next.rules.length}`);
  return out.length ? out : ["No structural change — weights refreshed"];
}

export function StrategyStudio({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  showVisibility = true,
  autoPrompt,
}: {
  autoPrompt?: string;
  initial?: EditorValue;
  submitLabel: string;
  onSubmit: (v: EditorValue) => void;
  onCancel?: () => void;
  showVisibility?: boolean;
}) {
  const { state } = useAtlas();
  const ensName = isEns(state.ensName) ? state.ensName : null;
  const [messages, setMessages] = useState<Message[]>(() => [
    {
      id: 0,
      role: "ai",
      text: initial
        ? `Loaded “${initial.name}”. Tell me what to change, for example “make it more conservative” or “add 10% BTC”.`
        : "Hi! I'm Atlas AI. Describe the strategy you want: markets, assets or sectors, risk, rebalance cadence, stop loss, or signals like RSI, dips and trends. I'll build it on the right.",
    },
    ...(initial
      ? [{ id: 1, role: "user" as const, text: initial.prompt }]
      : []),
  ]);
  const [turns, setTurns] = useState<string[]>(initial ? [initial.prompt] : []),
    [draft, setDraft] = useState(""),
    [step, setStep] = useState<number | null>(null),
    [spec, setSpec] = useState<StrategySpec | null>(initial?.spec ?? null),
    [name, setName] = useState(initial?.name ?? ""),
    [nameTouched, setNameTouched] = useState(!!initial),
    [tagline, setTagline] = useState(initial?.tagline ?? ""),
    [visibility, setVisibility] = useState<Visibility>(
      initial?.visibility ?? "private",
    ),
    [tab, setTab] = useState<Tab>("overview"),
    [json, setJson] = useState(
      initial ? JSON.stringify(initial.spec, null, 2) : "",
    ),
    [error, setError] = useState(""),
    [addSymbol, setAddSymbol] = useState(""),
    [icon, setIcon] = useState<StrategyIcon | null>(initial?.icon ?? null),
    [pickerOpen, setPickerOpen] = useState(false);
  const store = useStrategyStore();
  const otherIcons = useMemo(
    () =>
      store.strategies.filter((x) => x.id !== initial?.id).map((x) => x.icon),
    [store.strategies, initial?.id],
  );
  const takenIcons = useMemo(
    () => new Set(otherIcons.map(iconKey)),
    [otherIcons],
  );
  // Until the user picks one, show the unique default the strategy will be saved with.
  const shownIcon = icon ?? pickIcon(name || "new strategy", otherIcons);
  const thread = useRef<HTMLDivElement>(null);
  const thinking = step !== null;

  useEffect(() => {
    thread.current?.scrollTo({
      top: thread.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, step]);

  const preview = useMemo(
    () =>
      spec
        ? simulate(
            spec,
            `preview:${JSON.stringify(spec)}`,
            365,
            10_000,
            "backtest",
            "",
          )
        : null,
    [spec],
  );
  const handle = strategyHandle(name || "my strategy", ensName);
  const total = spec?.universe.reduce((t, a) => t + a.weight, 0) ?? 0;

  // A prompt handed over from the home page is sent once, as if typed.
  const autoSent = useRef(false);
  useEffect(() => {
    if (!autoPrompt || initial || autoSent.current) return;
    autoSent.current = true;
    const t = setTimeout(() => void send(autoPrompt), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrompt]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || thinking) return;
    if (!turns.length && t.length < 12)
      return setError("Describe the strategy in a sentence or two.");
    setError("");
    setDraft("");
    const nextTurns = [...turns, t];
    setTurns(nextTurns);
    setMessages((m) => [...m, { id: Date.now(), role: "user", text: t }]);
    // Mock of POST /strategies/compile — the backend will call an LLM constrained to the spec schema.
    for (let i = 0; i < STEPS.length; i++) {
      setStep(i);
      await sleep(320);
    }
    const g = generateSpec(nextTurns.join(". "));
    const prev = spec;
    setSpec(g.spec);
    setJson(JSON.stringify(g.spec, null, 2));
    if (!nameTouched) setName(g.suggestedName);
    if (!nameTouched || !tagline) setTagline(g.tagline);
    setStep(null);
    setMessages((m) => [
      ...m,
      {
        id: Date.now() + 1,
        role: "ai",
        text: prev
          ? "Updated your strategy. Here's what changed:"
          : `${summarize(g.spec)} I named it “${nameTouched ? name : g.suggestedName}”, and you can rename it on the right.`,
        bullets: prev ? diff(prev, g.spec) : g.assumptions,
      },
    ]);
  }

  const edit = (fn: (s: StrategySpec) => StrategySpec) => {
    if (!spec) return;
    const next = fn(structuredClone(spec));
    setSpec(next);
    setJson(JSON.stringify(next, null, 2));
  };

  function switchTab(next: Tab) {
    if (tab === "json" && next !== "json") {
      try {
        const res = validateSpec(JSON.parse(json));
        if (res.error) return setError(res.error);
        setSpec(res.spec!);
      } catch {
        return setError("Fix the JSON before leaving this tab.");
      }
    }
    setError("");
    setTab(next);
  }

  function submit() {
    if (!spec) return;
    let final = spec;
    if (tab === "json") {
      try {
        const res = validateSpec(JSON.parse(json));
        if (res.error) return setError(res.error);
        final = res.spec!;
      } catch {
        return setError("JSON is not valid.");
      }
    }
    const res = validateSpec(final);
    if (res.error) return setError(res.error);
    if (name.trim().length < 4)
      return setError("Give the strategy a name of at least 4 characters.");
    setError("");
    onSubmit({
      name: name.trim(),
      tagline: tagline.trim(),
      prompt: turns.join(". "),
      spec: final,
      visibility,
      icon: shownIcon,
    });
  }

  return (
    <div className="studio">
      {/* ─────────── Left: you give ─────────── */}
      <section className="panel studio-chat">
        <header className="studio-pane-head">
          <span className="studio-pane-icon you">
            <User size={15} />
          </span>
          <div>
            <strong>You describe</strong>
            <small>Plain English in, structured strategy out</small>
          </div>
        </header>
        <div className="studio-thread" ref={thread}>
          {messages.map((m) => (
            <div key={m.id} className={`studio-msg ${m.role}`}>
              {m.role === "ai" && (
                <span className="studio-avatar">
                  <Sparkles size={14} />
                </span>
              )}
              <div className="studio-bubble">
                <p>{m.text}</p>
                {m.bullets && m.bullets.length > 0 && (
                  <ul>
                    {m.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
          {thinking && (
            <div className="studio-msg ai">
              <span className="studio-avatar pulse">
                <Sparkles size={14} />
              </span>
              <div className="studio-bubble studio-steps">
                {STEPS.map((label, i) => (
                  <span
                    key={label}
                    className={i < step! ? "done" : i === step ? "now" : ""}
                  >
                    {i < step! ? (
                      <Check size={13} />
                    ) : i === step ? (
                      <Loader2 className="spin" size={13} />
                    ) : (
                      <i />
                    )}
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="studio-suggest">
          {(turns.length ? REFINES : STARTERS).map((s) => (
            <button key={s} disabled={thinking} onClick={() => void send(s)}>
              {turns.length ? <Wand2 size={12} /> : null}
              {s}
            </button>
          ))}
        </div>
        <form
          className="studio-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            rows={2}
            value={draft}
            disabled={thinking}
            placeholder={
              turns.length
                ? "Refine it: “drop crypto”, “add 20% NVDA”, “quarterly”…"
                : "e.g. Hold the top US and European AI stocks, trim on RSI above 70, 12% stop loss"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
          />
          <button
            className="studio-send"
            aria-label="Send"
            disabled={thinking || !draft.trim()}
          >
            {thinking ? (
              <Loader2 className="spin" size={17} />
            ) : (
              <ArrowUp size={17} />
            )}
          </button>
        </form>
        {!spec && error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
      </section>

      {/* ─────────── Right: you get ─────────── */}
      <section className={`panel studio-output ${thinking ? "thinking" : ""}`}>
        <header className="studio-pane-head">
          <span className="studio-pane-icon ai">
            <Bot size={15} />
          </span>
          <div>
            <strong>Atlas AI builds</strong>
            <small>
              {spec
                ? "Live strategy · edit anything below"
                : "Your strategy will appear here"}
            </small>
          </div>
          {onCancel && (
            <button className="text-button studio-cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
        </header>

        {!spec ? (
          <div className="studio-empty">
            <div className="studio-orb">
              <Sparkles size={30} />
            </div>
            <h3>{thinking ? "Building your strategy…" : "Nothing yet"}</h3>
            <p>
              Start on the left. Atlas AI turns your words into a strategy with
              assets, weights, rules, risk limits and an ENS name, then
              simulates a year of returns.
            </p>
            <div className="studio-skeleton">
              <i />
              <i />
              <i />
            </div>
          </div>
        ) : (
          <div className="studio-body">
            <div className="studio-name-row">
              <button
                type="button"
                className="studio-icon-button"
                aria-label="Change strategy icon"
                aria-expanded={pickerOpen}
                title="Change icon"
                onClick={() => setPickerOpen(!pickerOpen)}
              >
                <StrategyIconBadge icon={shownIcon} size={52} />
                <span>Icon</span>
              </button>
              <input
                className="studio-name"
                value={name}
                maxLength={60}
                aria-label="Strategy name"
                placeholder="Name your fund"
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
            </div>
            {pickerOpen && (
              <IconPicker
                value={shownIcon}
                taken={takenIcons}
                onChange={(next) => setIcon(next)}
              />
            )}
            <div className="studio-ens">
              <AtSign size={14} />
              {handle ? (
                <>
                  <span className="ens-chip handle">{handle}</span>
                  <span className="positive">Linked to your ENS</span>
                </>
              ) : (
                <>
                  <span className="muted">No ENS linked</span>
                  <Link className="text-button" href="/wallet">
                    Link ENS to get <code>name.you.eth</code>
                  </Link>
                </>
              )}
            </div>
            <input
              className="studio-tagline"
              value={tagline}
              maxLength={100}
              aria-label="Short description"
              placeholder="Short description"
              onChange={(e) => setTagline(e.target.value)}
            />

            <div className="ens-tabs studio-tabs">
              {(
                [
                  ["overview", LayoutDashboard, "Overview"],
                  ["allocation", PieChart, "Allocation"],
                  ["rules", ListChecks, "Rules & risk"],
                  ["json", Braces, "JSON"],
                ] as const
              ).map(([id, Icon, label]) => (
                <button
                  key={id}
                  className={tab === id ? "active" : ""}
                  onClick={() => switchTab(id)}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>

            {tab === "overview" && preview && (
              <div className="studio-overview">
                <div className="studio-preview-head">
                  <span>1-year simulated backtest · 10,000 aUSDT</span>
                  <strong>
                    <Ret v={preview.totalReturn} />
                  </strong>
                </div>
                <EquityChart curve={preview.curve} height={150} />
                <dl className="strategy-returns four">
                  {PERIODS.map((p) => (
                    <div key={p}>
                      <dt>{p}</dt>
                      <dd>
                        <Ret v={preview.returns[p]} />
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>Max DD</dt>
                    <dd className="negative">
                      -{(preview.maxDrawdown * 100).toFixed(1)}%
                    </dd>
                  </div>
                </dl>
                <AllocationBar universe={spec.universe} />
                <div className="studio-legend">
                  {spec.universe.map((a, i) => (
                    <span key={a.symbol}>
                      <i style={{ background: assetColor(i) }} />
                      {a.symbol} {a.weight}%
                    </span>
                  ))}
                </div>
                <dl className="strategy-risk">
                  <div>
                    <dt>Risk</dt>
                    <dd className="capitalize">{spec.riskProfile}</dd>
                  </div>
                  <div>
                    <dt>Rebalance</dt>
                    <dd className="capitalize">{spec.rebalance.frequency}</dd>
                  </div>
                  <div>
                    <dt>Stop loss</dt>
                    <dd>
                      {spec.risk.stopLossPct
                        ? `${spec.risk.stopLossPct}%`
                        : "Off"}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

            {tab === "allocation" && (
              <>
                <div className="strategy-table-wrap">
                  <table className="strategy-table">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Market</th>
                        <th>Weight %</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {spec.universe.map((a, i) => (
                        <tr key={a.symbol}>
                          <td>
                            <strong>{a.symbol}</strong> <small>{a.name}</small>
                          </td>
                          <td>{MARKET_FLAG[a.market]}</td>
                          <td>
                            <input
                              className="strategy-weight"
                              type="number"
                              min={0}
                              max={100}
                              step={0.5}
                              value={a.weight}
                              onChange={(e) =>
                                edit((s) => {
                                  s.universe[i].weight = Math.max(
                                    0,
                                    Number(e.target.value) || 0,
                                  );
                                  return s;
                                })
                              }
                            />
                          </td>
                          <td>
                            <button
                              className="text-button"
                              aria-label={`Remove ${a.symbol}`}
                              disabled={spec.universe.length < 2}
                              onClick={() =>
                                edit((s) => ({
                                  ...s,
                                  universe: s.universe.filter(
                                    (_, j) => j !== i,
                                  ),
                                }))
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="strategy-weight-bar">
                  <span
                    className={
                      Math.abs(total - 100) > 0.5 ? "negative" : "positive"
                    }
                  >
                    Total {total.toFixed(1)}%
                  </span>
                  {Math.abs(total - 100) > 0.5 && (
                    <button
                      className="text-button"
                      onClick={() =>
                        edit((s) => ({
                          ...s,
                          universe: normalizeWeights(s.universe),
                        }))
                      }
                    >
                      Scale to 100%
                    </button>
                  )}
                  <select
                    value={addSymbol}
                    onChange={(e) => setAddSymbol(e.target.value)}
                    aria-label="Add asset"
                  >
                    <option value="">Add asset…</option>
                    {ASSETS.filter(
                      (a) => !spec.universe.some((u) => u.symbol === a.symbol),
                    ).map((a) => (
                      <option key={a.symbol} value={a.symbol}>
                        {MARKET_FLAG[a.market]} {a.symbol} — {a.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn secondary small"
                    disabled={!addSymbol}
                    onClick={() => {
                      const a = ASSETS.find((x) => x.symbol === addSymbol);
                      if (a)
                        edit((s) => ({
                          ...s,
                          universe: normalizeWeights([
                            ...s.universe.map((u) => ({
                              ...u,
                              weight: u.weight * 0.9,
                            })),
                            { ...a, weight: 10 },
                          ]),
                        }));
                      setAddSymbol("");
                    }}
                  >
                    <Plus size={14} /> Add
                  </button>
                </div>
              </>
            )}

            {tab === "rules" && (
              <>
                <div className="strategy-param-grid">
                  <label>
                    Risk profile
                    <select
                      value={spec.riskProfile}
                      onChange={(e) =>
                        edit((s) => ({
                          ...s,
                          riskProfile: e.target.value as RiskProfile,
                        }))
                      }
                    >
                      <option value="conservative">Conservative</option>
                      <option value="balanced">Balanced</option>
                      <option value="aggressive">Aggressive</option>
                    </select>
                  </label>
                  <label>
                    Rebalance
                    <select
                      value={spec.rebalance.frequency}
                      onChange={(e) =>
                        edit((s) => ({
                          ...s,
                          rebalance: {
                            ...s.rebalance,
                            frequency: e.target.value as Frequency,
                          },
                        }))
                      }
                    >
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                    </select>
                  </label>
                  <NumberField
                    label="Drift tolerance %"
                    value={spec.rebalance.driftTolerancePct}
                    onChange={(v) =>
                      edit((s) => ({
                        ...s,
                        rebalance: {
                          ...s.rebalance,
                          driftTolerancePct: v ?? 5,
                        },
                      }))
                    }
                  />
                  <NumberField
                    label="Stop loss %"
                    value={spec.risk.stopLossPct}
                    optional
                    onChange={(v) =>
                      edit((s) => ({
                        ...s,
                        risk: { ...s.risk, stopLossPct: v },
                      }))
                    }
                  />
                  <NumberField
                    label="Take profit %"
                    value={spec.risk.takeProfitPct}
                    optional
                    onChange={(v) =>
                      edit((s) => ({
                        ...s,
                        risk: { ...s.risk, takeProfitPct: v },
                      }))
                    }
                  />
                  <NumberField
                    label="Max per asset %"
                    value={spec.risk.maxAssetWeightPct}
                    onChange={(v) =>
                      edit((s) => ({
                        ...s,
                        risk: { ...s.risk, maxAssetWeightPct: v ?? 35 },
                      }))
                    }
                  />
                  <NumberField
                    label="Cash buffer %"
                    value={spec.risk.cashBufferPct}
                    onChange={(v) =>
                      edit((s) => ({
                        ...s,
                        risk: { ...s.risk, cashBufferPct: v ?? 0 },
                      }))
                    }
                  />
                  <NumberField
                    label="Min deploy (aUSDT)"
                    value={spec.execution.minDeployment}
                    onChange={(v) =>
                      edit((s) => ({
                        ...s,
                        execution: { ...s.execution, minDeployment: v ?? 50 },
                      }))
                    }
                  />
                </div>
                <ul className="strategy-rules">
                  {spec.rules.length ? (
                    spec.rules.map((r) => (
                      <li key={r.id}>
                        <span>{describeRule(r)}</span>
                        <button
                          className="text-button"
                          aria-label="Remove rule"
                          onClick={() =>
                            edit((s) => ({
                              ...s,
                              rules: s.rules.filter((x) => x.id !== r.id),
                            }))
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    ))
                  ) : (
                    <li className="muted">
                      No signal rules. It holds target weights and rebalances{" "}
                      {spec.rebalance.frequency}. Ask Atlas AI to add RSI, dip
                      or trend rules.
                    </li>
                  )}
                </ul>
              </>
            )}

            {tab === "json" && (
              <textarea
                className="strategy-json"
                spellCheck={false}
                rows={20}
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
            )}

            {showVisibility && (
              <div className="strategy-visibility-pick">
                <button
                  className={visibility === "private" ? "active" : ""}
                  onClick={() => setVisibility("private")}
                >
                  <Lock size={16} />
                  <span>
                    <strong>Private</strong>
                    <small>Only you can see, run and deploy it.</small>
                  </span>
                </button>
                <button
                  className={visibility === "public" ? "active" : ""}
                  onClick={() => setVisibility("public")}
                >
                  <Globe2 size={16} />
                  <span>
                    <strong>Public</strong>
                    <small>
                      Listed in Explore. You earn {CREATOR_FEE_BPS / 100}% of
                      funds others deploy.
                    </small>
                  </span>
                </button>
              </div>
            )}

            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            <div className="studio-save">
              <small className="muted">
                Sending a new instruction rebuilds the spec and replaces manual
                edits.
              </small>
              <button
                className="btn primary"
                disabled={thinking}
                onClick={submit}
              >
                <Check size={16} /> {submitLabel}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  optional,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  optional?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={0}
        step={0.5}
        value={value ?? ""}
        placeholder={optional ? "Off" : undefined}
        onChange={(e) =>
          onChange(
            e.target.value === ""
              ? optional
                ? null
                : 0
              : Math.max(0, Number(e.target.value)),
          )
        }
      />
    </label>
  );
}
