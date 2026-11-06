"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  FlaskConical,
  Loader2,
  Pencil,
  Play,
  Rocket,
  ShieldCheck,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard/shell";
import { useAtlas } from "@/components/atlas/provider";
import { StrategyChart } from "./chart";
import { BacktestPanel } from "./backtest";
import { PortfolioPlan } from "./portfolio";
import { ConvertDialog } from "./convert";
import { api } from "@/lib/api";
import type { Generated } from "@/lib/strategies";
import { useStrategyStore } from "@/components/strategies/ui";
import {
  DEMO_UI,
  bpsPct,
  describeAllocation,
  describeEntry,
  describeExit,
  intentApi,
  num,
  requestAusdtPermission,
  signAuthorization,
  usd,
  type CreateResult,
  type Evaluation,
  type Intent,
  type ParseResult,
  paperBridge,
  type Backtest,
  type BacktestDays,
} from "@/lib/intent/client";

const EXAMPLES = [
  "Buy Apple with 1,000 USDT now. Max slippage 0.5%. Sell at +8% or -3%.",
  "Buy 500 USDT of Nvidia if price falls below $180.",
  "Buy Apple with 1,000 USDT after 30 seconds and sell 10 seconds after buying",
  "Invest 10% of my portfolio in TCS now.",
  "Sell my Apple position if profit reaches 12%.",
];
const STEPS = [
  "Reading your instruction",
  "Matching the asset and market",
  "Checking your risk limits",
  "Simulating the fill",
];
interface Msg {
  id: number;
  role: "user" | "ai";
  text: string;
  bullets?: string[];
  tone?: "error";
  /** Shows the clarifying options under this message. */
  clarify?: boolean;
}
type RunTab = "backtest" | "paper" | "deploy";
const RUN_TABS = [
  ["backtest", FlaskConical, "Backtest"],
  ["paper", Play, "Paper trade"],
  ["deploy", Rocket, "Deploy"],
] as const;
const DISCLAIMER =
  "Atlas AI converts your instructions into trading rules. It does not guarantee returns.";

export function DemoBanner({ simulated }: { simulated: boolean }) {
  if (!DEMO_UI && !simulated) return null;
  return (
    <div className="intent-demo-banner" role="note">
      <strong>Investor Demo</strong> — fixture prices and a simulated execution
      ledger. Nothing here moves real funds.
    </div>
  );
}

export function NewIntentPage() {
  const { wallet, toast } = useAtlas();
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: 0,
      role: "ai",
      text: "Hi! I’m Atlas AI. Tell me what to trade: the stock, how much, when to enter (now, after a delay, at a price or a time) and when to exit (take profit, stop loss, or after a hold time). Markets are open 24/7, so trades execute as soon as your conditions are met.",
    },
  ]);
  const [step, setStep] = useState(0);
  const msgId = useRef(0);
  const thread = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [draft, setDraft] = useState<Intent | null>(null);
  const [ev, setEv] = useState<Evaluation | null>(null);
  const [parseHash, setParseHash] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [ack, setAck] = useState(false);
  const [signing, setSigning] = useState<
    "idle" | "creating" | "signing" | "permission" | "activating"
  >("idle");
  const [sim, setSim] = useState(false);
  /** Live mode: the vault lacks aUSDT, so convert USDT first. */
  const [converting, setConverting] = useState(false);
  /** Set when the prompt was a multi-stock portfolio, built as a strategy. */
  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const strategies = useStrategyStore();
  // Run this trade: backtest (default, so the graph shows right after generating), paper or deploy.
  const [runTab, setRunTab] = useState<RunTab>("backtest");
  const [btDays, setBtDays] = useState<BacktestDays>(90);
  const [bt, setBt] = useState<Backtest | null>(null);
  const [btLoading, setBtLoading] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [paperAck, setPaperAck] = useState(false);
  const [paperBusy, setPaperBusy] = useState(false);
  const btSeq = useRef(0);
  const seq = useRef(0);

  useEffect(() => {
    intentApi
      .config()
      .then((c) => setSim(c.executionMode === "SIMULATED"))
      .catch(() => undefined);
  }, []);

  const clarifying = result?.status === "CLARIFICATION_NEEDED" ? result : null;
  useEffect(() => {
    thread.current?.scrollTo({
      top: thread.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, busy]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(
      () => setStep((v) => Math.min(v + 1, STEPS.length - 1)),
      450,
    );
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    if (!draft || !ev?.valid || !ev.simulation) {
      setBt(null);
      setBtError(
        ev && !ev.valid ? "Fix the issues above to backtest this plan." : null,
      );
      return;
    }
    const id = ++btSeq.current;
    setBtLoading(true);
    setBtError(null);
    intentApi
      .backtest(draft, btDays)
      .then((r) => id === btSeq.current && setBt(r.backtest))
      .catch(
        (e: Error) =>
          id === btSeq.current && (setBt(null), setBtError(e.message)),
      )
      .finally(() => id === btSeq.current && setBtLoading(false));
    // `ev` is re-evaluated after every edit to `draft`, so it is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ev, btDays]);

  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : "Something went wrong.");
  };
  const say = (m: Omit<Msg, "id">) =>
    setMessages((list) => [...list, { ...m, id: ++msgId.current }]);

  /**
   * Sends one chat turn. `full` is the complete instruction Atlas parses; `shown` is what appears
   * in the thread (a clarification answer shows just the answer, but parses with the original).
   */
  const send = async (full: string, shown = full) => {
    const text = full.trim();
    if (busy || text.length < 2) return;
    // A reply to a clarifying question extends the original instruction.
    const instruction =
      clarifying && full === shown
        ? `${prompt.trim().replace(/\.$/, "")}. ${text}`
        : text;
    say({ role: "user", text: shown.trim() });
    setInput("");
    setPrompt(instruction);
    setBusy(true);
    setStep(0);
    setError(null);
    setResult(null);
    setDraft(null);
    setEv(null);
    setEditing(false);
    setRunTab("backtest");
    setPaperAck(false);
    setPortfolioId(null);
    try {
      const [r] = await Promise.all([
        intentApi.parse(instruction),
        new Promise((done) => setTimeout(done, 900)), // Let the steps read.
      ]);
      setResult(r);
      if (r.status === "OK") {
        setDraft(r.intent);
        setEv(r.evaluation);
        setParseHash(r.parseHash);
        const issues = [
          ...(r.evaluation?.issues ?? []),
          ...(r.evaluation?.blockingRisk ?? []),
        ];
        say({
          role: "ai",
          text:
            r.evaluation?.summary ??
            `Here’s your ${r.intent.side.toLowerCase()} plan for ${r.intent.asset.companyName}.`,
          bullets: [
            `${r.intent.asset.companyName} (${r.intent.asset.symbol}) · ${r.intent.asset.market}`,
            ...(r.intent.metadata.defaultsApplied.length
              ? [
                  `Defaults applied: ${r.intent.metadata.defaultsApplied.join(", ")}`,
                ]
              : []),
            issues.length
              ? `${issues.length} issue${issues.length > 1 ? "s" : ""} to fix before signing — see the right.`
              : "Review the preview on the right, edit anything, then confirm & sign.",
          ],
        });
      } else if (r.status === "PORTFOLIO_STRATEGY") {
        // Multi-stock basket: build an executable strategy from the prompt right here.
        setResult(null);
        const g = await api<Generated>("/strategies/generate", {
          prompt: instruction.slice(0, 1000),
        });
        const created = await strategies.create({
          name: g.suggestedName,
          tagline: g.tagline,
          prompt: instruction.slice(0, 1000),
          spec: g.spec,
          visibility: "private",
        });
        setPortfolioId(created.id);
        say({
          role: "ai",
          text: `Built “${created.name}” from your prompt: ${g.tagline}. It’s saved privately and backtesting now; paper trade or deploy it on the right.`,
          bullets: [
            g.spec.universe.map((a) => `${a.symbol} ${a.weight}%`).join(" · "),
            ...g.assumptions,
          ],
        });
      } else if (r.status === "CLARIFICATION_NEEDED") {
        const lastAi = [...messages] // Thread as of this send, before the reply.
          .reverse()
          .find((m) => m.role === "ai");
        if (lastAi?.clarify && lastAi.text.startsWith(r.question)) {
          // Same question again: stop appending to a request Atlas can't resolve.
          setResult(null);
          say({
            role: "ai",
            text: `I still can’t tell: ${r.question.replace(/\?$/, "").toLowerCase()}. Let’s start fresh — describe the whole trade in one message.`,
            bullets: [
              "Buy Apple with 1,000 USDT now, sell at +8% or −3%",
              "Buy 500 USDT of Nvidia if the price falls below $180",
              "For several stocks, describe the split and I’ll build a strategy",
            ],
          });
        } else say({ role: "ai", text: r.question, clarify: true });
      } else {
        say({
          role: "ai",
          tone: "error",
          text: r.reason.startsWith("ATLAS doesn")
            ? r.reason
            : `Atlas can’t do that yet: ${r.reason}`,
        });
      }
    } catch (e) {
      say({
        role: "ai",
        tone: "error",
        text: e instanceof Error ? e.message : "Something went wrong.",
      });
    } finally {
      setBusy(false);
    }
  };
  // Manual edits change the structured intent directly, then Atlas re-validates and re-simulates it.
  const revalidate = useCallback(async (next: Intent) => {
    const id = ++seq.current;
    try {
      const e = await intentApi.evaluate(next);
      if (id === seq.current) setEv(e);
    } catch (e) {
      if (id === seq.current) fail(e);
    }
  }, []);
  const update = (fn: (i: Intent) => Intent) => {
    if (!draft) return;
    const next = fn(structuredClone(draft));
    next.metadata.parser = "manual";
    setDraft(next);
    setEv(null);
    void revalidate(next);
  };

  const sign = async () => {
    if (!draft || !wallet) return;
    setError(null);
    const funding = ev?.funding;
    // Live mode spends aUSDT: top up the vault first when it is short.
    if (funding && Number(funding.shortfallUSDT) > 0) {
      setConfirm(false);
      setConverting(true);
      return;
    }
    try {
      setSigning("creating");
      const created: CreateResult = await intentApi.create(draft, parseHash);
      setSigning("signing");
      const signature =
        wallet.demo && created.demoSignatureAllowed
          ? "DEMO"
          : await signAuthorization(wallet.address, created.typedData);
      // Live mode: MetaMask grants the Atlas executor an aUSDT allowance for this strategy only.
      let permission;
      if (funding) {
        setSigning("permission");
        permission = await requestAusdtPermission(
          wallet.address,
          funding,
          draft.constraints.validUntil ??
            Math.floor(Date.now() / 1000) + 86_400,
          draft.asset.symbol,
        );
      }
      setSigning("activating");
      await intentApi.activate(created.id, signature, permission);
      toast(
        funding
          ? "Strategy activated. Atlas will execute it on Sepolia with your aUSDT."
          : "Strategy activated. Atlas is now watching the conditions.",
      );
      router.push("/intent");
    } catch (e) {
      fail(e);
      setSigning("idle");
    }
  };

  const blocking = ev ? [...ev.issues, ...ev.blockingRisk] : [];
  const canConfirm = !!ev && ev.valid && !!ev.simulation && signing === "idle";
  const exitBps = (type: "TAKE_PROFIT_BPS" | "STOP_LOSS_BPS") => {
    const c = draft?.exitConditions.find((e) => e.type === type);
    return c && "value" in c ? c.value : undefined;
  };

  const startPaper = async () => {
    if (!draft || !ev?.simulation) return;
    setPaperBusy(true);
    setError(null);
    try {
      const p = await paperBridge.preview({
        symbol: draft.asset.symbol,
        notionalUSDT: Number(ev.simulation.estimatedNotionalUSDT),
        maxSlippageBps: draft.constraints.maxSlippageBps,
        takeProfitBps: exitBps("TAKE_PROFIT_BPS"),
        stopLossBps: exitBps("STOP_LOSS_BPS"),
      });
      await paperBridge.confirm(p.order.id, p.confirmationToken);
      toast(
        `Paper trade started: ${num(p.order.quantity, 4)} ${p.order.draft.symbol} with paper USDT${p.defaults.length ? ` (defaults: ${p.defaults.join(", ")})` : ""}.`,
      );
      router.push("/paper");
    } catch (e) {
      fail(e);
    } finally {
      setPaperBusy(false);
    }
  };

  return (
    <DashboardShell>
      <main className="protocol-content strategies-page studio-page intent-page">
        <div className="studio-title">
          <Link className="text-button" href="/intent">
            <ArrowLeft size={14} /> My Atlas AI trades
          </Link>
          <h1>
            <Sparkles size={24} /> Trade with Atlas AI
          </h1>
          <p>
            Describe your trade on the left and watch Atlas AI build the plan on
            the right. Nothing is active until you review, confirm and sign.
          </p>
        </div>
        <DemoBanner simulated={sim} />
        <div className="studio">
          {/* ─────────── Left: you describe ─────────── */}
          <section className="panel studio-chat">
            <header className="studio-pane-head">
              <span className="studio-pane-icon you">
                <User size={15} />
              </span>
              <div>
                <strong>You describe</strong>
                <small>Plain English in, structured trade out</small>
              </div>
            </header>
            <div className="studio-thread" ref={thread}>
              {messages.map((m, i) => (
                <div key={m.id} className={`studio-msg ${m.role}`}>
                  {m.role === "ai" && (
                    <span className="studio-avatar">
                      <Sparkles size={14} />
                    </span>
                  )}
                  <div className={`studio-bubble ${m.tone ?? ""}`}>
                    <p>{m.text}</p>
                    {m.bullets && m.bullets.length > 0 && (
                      <ul>
                        {m.bullets.map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                    )}
                    {/* Only the latest question stays answerable. */}
                    {m.clarify && clarifying && i === messages.length - 1 && (
                      <ClarifyOptions
                        result={clarifying}
                        onPick={(text) =>
                          void send(
                            `${prompt.trim().replace(/\.$/, "")} ${text}`,
                            text,
                          )
                        }
                      />
                    )}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="studio-msg ai">
                  <span className="studio-avatar pulse">
                    <Sparkles size={14} />
                  </span>
                  <div className="studio-bubble studio-steps">
                    {STEPS.map((label, i) => (
                      <span
                        key={label}
                        className={i < step ? "done" : i === step ? "now" : ""}
                      >
                        {i < step ? (
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
            {!draft && !portfolioId && (
              <div className="studio-suggest">
                {EXAMPLES.map((e) => (
                  <button key={e} disabled={busy} onClick={() => void send(e)}>
                    {e}
                  </button>
                ))}
              </div>
            )}
            <form
              className="studio-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <textarea
                rows={2}
                value={input}
                maxLength={600}
                disabled={busy}
                aria-label="Describe your trade"
                placeholder={
                  clarifying
                    ? "Answer Atlas AI, or pick an option above…"
                    : draft
                      ? "Describe a different trade, or edit the plan on the right…"
                      : "e.g. Buy Apple with 1,000 USDT now. Sell at +8% or -3%."
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
              />
              <button
                className="studio-send"
                aria-label="Send"
                disabled={busy || input.trim().length < 2}
              >
                {busy ? (
                  <Loader2 className="spin" size={17} />
                ) : (
                  <ArrowUp size={17} />
                )}
              </button>
            </form>
            <p className="intent-disclaimer studio-disclaimer">
              <ShieldCheck size={13} /> {DISCLAIMER}
            </p>
          </section>

          {/* ─────────── Right: Atlas AI builds ─────────── */}
          <section
            className={`panel studio-output ${busy ? "thinking" : ""}`}
            aria-live="polite"
          >
            <header className="studio-pane-head">
              <span className="studio-pane-icon ai">
                <Bot size={15} />
              </span>
              <div>
                <strong>Atlas AI builds</strong>
                <small>
                  {portfolioId
                    ? "Executable strategy · backtest, paper trade or deploy"
                    : draft
                      ? "Live trade plan · edit anything below"
                      : "Your trade plan will appear here"}
                </small>
              </div>
              <button
                className="text-button studio-cancel"
                onClick={() => router.push("/intent")}
              >
                Cancel
              </button>
            </header>
            {portfolioId ? (
              <div className="studio-body intent-body">
                <PortfolioPlan strategyId={portfolioId} />
              </div>
            ) : !draft ? (
              <div className="studio-empty">
                <div className="studio-orb">
                  <Sparkles size={30} />
                </div>
                <h3>{busy ? "Building your trade…" : "Nothing yet"}</h3>
                <p>
                  Start on the left. Atlas AI turns your words into a trade plan
                  with the asset, size, entry and exit rules and risk limits,
                  then simulates the fill before you sign.
                </p>
                <div className="studio-skeleton">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            ) : (
              <div className="studio-body intent-body">
                {error && (
                  <div className="error-box" role="alert">
                    {error}
                  </div>
                )}
                {draft && (
                  <>
                    <StrategyCard intent={draft} ev={ev} />
                    {draft.metadata.defaultsApplied.length > 0 && (
                      <p className="intent-note">
                        Atlas applied defaults you didn’t specify:{" "}
                        {draft.metadata.defaultsApplied
                          .map((d) =>
                            d === "maxSlippageBps"
                              ? "max slippage 1%"
                              : d === "validUntil"
                                ? "valid for 24 hours"
                                : d,
                          )
                          .join(", ")}
                        . Edit them below.
                      </p>
                    )}
                    {ev?.summary && (
                      <div className="intent-summary">
                        <span className="eyebrow">ATLAS AI SUMMARY</span>
                        <p>{ev.summary}</p>
                      </div>
                    )}
                    {blocking.length > 0 && (
                      <ul className="intent-issues" role="alert">
                        {blocking.map((b, i) => (
                          <li key={i}>
                            <AlertTriangle size={13} /> {b.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    {ev?.simulation && (
                      <>
                        <StrategyChart
                          symbol={draft.asset.symbol}
                          current={ev.price?.priceUSDT}
                          entry={ev.simulation.estimatedEntryPrice}
                          takeProfit={ev.simulation.estimatedTakeProfitPrice}
                          stopLoss={ev.simulation.estimatedStopLossPrice}
                        />
                        <div className="intent-metrics">
                          <M
                            l="Estimated shares"
                            v={num(ev.simulation.estimatedQuantity, 4)}
                          />
                          <M
                            l="Estimated entry value"
                            v={usd(ev.simulation.estimatedNotionalUSDT)}
                          />
                          <M
                            l="Estimated fee"
                            v={usd(ev.simulation.estimatedFeesUSDT, 4)}
                          />
                          <M
                            l="Estimated slippage"
                            v={`${usd(ev.simulation.estimatedSlippageUSDT, 4)} (${bpsPct(ev.simulation.estimatedSlippageBps)})`}
                          />
                          <M
                            l="Potential profit at target"
                            v={usd(ev.simulation.estimatedProfitAtTargetUSDT)}
                          />
                          <M
                            l="Max configured loss"
                            v={usd(
                              ev.simulation.estimatedLossAtStopUSDT ??
                                ev.risk?.estimatedMaxLossUSDT,
                            )}
                          />
                          <M
                            l="Exposure after trade"
                            v={`${ev.simulation.exposureAfterTradePercent}%`}
                          />
                          <M
                            l="Market"
                            v={
                              ev.market?.open
                                ? "Open"
                                : ev.simulation.marketStatus
                                    .replace("_", " ")
                                    .toLowerCase()
                            }
                          />
                        </div>
                        {ev.simulation.warnings.length > 0 && (
                          <ul className="intent-warnings">
                            {ev.simulation.warnings.map((w, i) => (
                              <li
                                key={i}
                                className={`sev-${w.severity.toLowerCase()}`}
                              >
                                <AlertTriangle size={13} /> <b>{w.severity}</b>{" "}
                                {w.message}
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="intent-disclaimer">
                          {ev.simulation.disclaimer}
                        </p>
                      </>
                    )}
                    {editing && <EditForm intent={draft} onChange={update} />}

                    <section className="run-trade">
                      <h3>Run this trade</h3>
                      <div className="ens-tabs run-tabs" role="tablist">
                        {RUN_TABS.map(([t, Icon, label]) => (
                          <button
                            key={t}
                            role="tab"
                            aria-selected={runTab === t}
                            className={runTab === t ? "active" : ""}
                            onClick={() => setRunTab(t)}
                          >
                            <Icon size={14} /> {label}
                          </button>
                        ))}
                      </div>
                      {runTab === "backtest" && (
                        <BacktestPanel
                          bt={bt}
                          days={btDays}
                          loading={btLoading}
                          error={btError}
                          onDays={setBtDays}
                        />
                      )}
                      {runTab === "paper" && (
                        <div className="run-card">
                          <p>
                            Run this exact plan on the Paper Trading simulator
                            with paper USDT. It buys at the next simulated
                            minute with your spend, slippage cap and exits, and
                            you can speed up the clock to watch it play out.
                          </p>
                          <dl className="run-facts">
                            <dt>Spend</dt>
                            <dd>
                              {usd(ev?.simulation?.estimatedNotionalUSDT)} paper
                              USDT
                            </dd>
                            <dt>Take profit</dt>
                            <dd>
                              {exitBps("TAKE_PROFIT_BPS") !== undefined
                                ? `+${bpsPct(exitBps("TAKE_PROFIT_BPS")!)}`
                                : "+10% (default)"}
                            </dd>
                            <dt>Stop loss</dt>
                            <dd>
                              {exitBps("STOP_LOSS_BPS") !== undefined
                                ? `−${bpsPct(exitBps("STOP_LOSS_BPS")!)}`
                                : "−5% (default)"}
                            </dd>
                            <dt>Max slippage</dt>
                            <dd>
                              {draft.constraints.maxSlippageBps !== undefined
                                ? bpsPct(draft.constraints.maxSlippageBps)
                                : "1% (default)"}
                            </dd>
                          </dl>
                          {draft.side !== "BUY" ? (
                            <p className="bt-empty">
                              Paper Trading runs buy plans. Backtest this sell
                              plan instead.
                            </p>
                          ) : (
                            <label className="check-row">
                              <input
                                type="checkbox"
                                checked={paperAck}
                                onChange={(e) => setPaperAck(e.target.checked)}
                              />
                              I understand this uses paper USDT on a simulated
                              clock, not live prices or funds.
                            </label>
                          )}
                        </div>
                      )}
                      {runTab === "deploy" && (
                        <div className="run-card">
                          <p>
                            Deploying activates this plan for real: you review
                            the exact rules, then sign an authorization with
                            your wallet. Atlas then watches the conditions and
                            executes within your limits.
                          </p>
                          {bt && (
                            <p className="muted">
                              Backtest ({bt.days} days): target hit{" "}
                              {bt.stats.takeProfitPct.toFixed(0)}%, stop hit{" "}
                              {bt.stats.stopLossPct.toFixed(0)}%, median P&amp;L{" "}
                              {usd(String(bt.stats.medianPnlUSDT))}.
                            </p>
                          )}
                        </div>
                      )}
                    </section>

                    <div className="intent-actions">
                      <button
                        className="btn secondary"
                        onClick={() => setEditing((v) => !v)}
                      >
                        <Pencil size={14} />{" "}
                        {editing ? "Done editing" : "Edit plan"}
                      </button>
                      {runTab === "backtest" && (
                        <>
                          <button
                            className="btn secondary"
                            disabled={!bt || draft.side !== "BUY"}
                            onClick={() => setRunTab("paper")}
                          >
                            <Play size={14} /> Paper trade
                          </button>
                          <button
                            className="btn primary"
                            disabled={!canConfirm}
                            onClick={() => setRunTab("deploy")}
                          >
                            <Rocket size={14} /> Deploy
                          </button>
                        </>
                      )}
                      {runTab === "paper" && (
                        <button
                          className="btn primary"
                          disabled={
                            !canConfirm ||
                            !paperAck ||
                            paperBusy ||
                            draft.side !== "BUY"
                          }
                          onClick={() => void startPaper()}
                        >
                          <Play size={14} />{" "}
                          {paperBusy ? "Starting…" : "Start paper trade"}
                        </button>
                      )}
                      {runTab === "deploy" && (
                        <button
                          className="btn primary"
                          disabled={!canConfirm}
                          onClick={() => {
                            setAck(false);
                            setConfirm(true);
                          }}
                        >
                          <Rocket size={14} /> Confirm &amp; sign
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        </div>

        <Dialog.Root
          open={confirm}
          onOpenChange={(o) => signing === "idle" && setConfirm(o)}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog intent-dialog">
              <Dialog.Close className="dialog-close" aria-label="Close">
                <X size={20} />
              </Dialog.Close>
              <span className="eyebrow">FINAL CONFIRMATION</span>
              <Dialog.Title>Review before you sign</Dialog.Title>
              <Dialog.Description>
                Signing authorizes exactly these rules, within these limits, and
                nothing more.
              </Dialog.Description>
              {draft && ev && (
                <dl className="intent-confirm">
                  <dt>Asset</dt>
                  <dd>
                    {draft.asset.companyName} ({draft.asset.symbol}) ·{" "}
                    {draft.asset.market}
                  </dd>
                  <dt>Action</dt>
                  <dd>{draft.side}</dd>
                  <dt>Maximum spend</dt>
                  <dd>{usd(ev.maxSpendUSDT)} USDT</dd>
                  <dt>Max slippage</dt>
                  <dd>
                    {draft.constraints.maxSlippageBps !== undefined
                      ? bpsPct(draft.constraints.maxSlippageBps)
                      : "—"}
                  </dd>
                  <dt>Entry rules</dt>
                  <dd>
                    {draft.entryConditions
                      .map((c) => describeEntry(c, draft.asset.market))
                      .join(" and ") || "—"}
                  </dd>
                  <dt>Exit rules</dt>
                  <dd>
                    {draft.exitConditions.map(describeExit).join(" · ") || "—"}
                  </dd>
                  <dt>Expires</dt>
                  <dd>
                    {draft.constraints.validUntil
                      ? new Date(
                          draft.constraints.validUntil * 1000,
                        ).toLocaleString()
                      : "—"}
                  </dd>
                  <dt>Warnings</dt>
                  <dd>
                    {ev.simulation?.warnings.length
                      ? ev.simulation.warnings.map((w) => w.message).join(" ")
                      : "None"}
                  </dd>
                </dl>
              )}
              <label className="intent-ack">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                I understand this strategy may result in losses.
              </label>
              {sim ? (
                <p className="intent-note">
                  Execution is simulated in this environment.
                </p>
              ) : (
                ev?.funding && (
                  <p className="intent-note">
                    Executes on Sepolia. After you sign, MetaMask asks you to
                    let the Atlas executor use up to{" "}
                    {usd(ev.funding.requiredUSDT)} of your aUSDT for this
                    strategy until it expires. Atlas buys, holds the stock for
                    the trade and returns the aUSDT when it sells.
                  </p>
                )
              )}
              {error && (
                <div className="error-box" role="alert">
                  {error}
                </div>
              )}
              <button
                className="btn primary full"
                disabled={!ack || signing !== "idle"}
                onClick={sign}
              >
                {signing === "idle"
                  ? "Sign Strategy"
                  : signing === "creating"
                    ? "Preparing…"
                    : signing === "signing"
                      ? "Check your wallet…"
                      : signing === "permission"
                        ? "Approve aUSDT permission in MetaMask…"
                        : "Activating…"}
              </button>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <ConvertDialog
          open={converting}
          funding={ev?.funding}
          account={wallet?.address}
          onClose={() => setConverting(false)}
          onConverted={() => {
            setConverting(false);
            toast("USDT converted to aUSDT. Review and sign your strategy.");
            if (draft)
              void revalidate(draft).then(() => {
                setAck(false);
                setConfirm(true);
              });
          }}
        />
      </main>
    </DashboardShell>
  );
}

function M({ l, v }: { l: string; v: string }) {
  return (
    <div className="intent-metric">
      <span>{l}</span>
      <strong>{v}</strong>
    </div>
  );
}

function ClarifyOptions({
  result,
  onPick,
}: {
  result: Extract<ParseResult, { status: "CLARIFICATION_NEEDED" }>;
  onPick: (append: string) => void;
}) {
  const [input, setInput] = useState<Record<string, string>>({});
  return (
    <div className="intent-options">
      {result.options.map((o) => (
        <div key={o.label} className="intent-option">
          {o.needsInput ? (
            <>
              <input
                aria-label={o.label}
                placeholder={
                  o.needsInput === "price"
                    ? "Price in USDT, e.g. 180"
                    : "UTC time, e.g. 2026-11-09T14:30Z"
                }
                value={input[o.label] ?? ""}
                onChange={(e) =>
                  setInput({ ...input, [o.label]: e.target.value })
                }
              />
              <button
                className="btn secondary small"
                disabled={!input[o.label]}
                onClick={() =>
                  onPick(
                    `${o.append} ${o.needsInput === "price" ? "$" : ""}${input[o.label]}`,
                  )
                }
              >
                {o.label}
              </button>
            </>
          ) : (
            <button
              className="btn secondary small"
              onClick={() => onPick(o.append)}
            >
              {o.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function StrategyCard({
  intent,
  ev,
}: {
  intent: Intent;
  ev: Evaluation | null;
}) {
  const sl = intent.exitConditions.find((e) => e.type === "STOP_LOSS_BPS");
  return (
    <div className="intent-card">
      <div className="intent-card-head">
        <div>
          <h3>{intent.asset.companyName.toUpperCase()}</h3>
          <span>
            {intent.asset.symbol} · {intent.asset.market}
          </span>
        </div>
        <span className={`intent-side ${intent.side.toLowerCase()}`}>
          {intent.side}
        </span>
      </div>
      <div className="intent-rows">
        <Row
          k="Allocation"
          v={describeAllocation(intent.allocation, intent.side)}
        />
        <Row
          k="Entry"
          v={
            intent.entryConditions
              .map((c) => describeEntry(c, intent.asset.market))
              .join(" and ") || "Immediately when valid"
          }
        />
        <Row
          k="Maximum slippage"
          v={
            intent.constraints.maxSlippageBps !== undefined
              ? bpsPct(intent.constraints.maxSlippageBps)
              : "—"
          }
        />
        <Row
          k="Exit"
          v={
            intent.exitConditions.length
              ? intent.exitConditions.map(describeExit).join(" · ")
              : "None"
          }
        />
        {!sl && intent.side === "BUY" && (
          <Row k="Stop loss" v="None set" warn />
        )}
        <Row
          k="Validity"
          v={
            intent.constraints.validUntil
              ? `Until ${new Date(intent.constraints.validUntil * 1000).toLocaleString()}`
              : "—"
          }
        />
        {ev?.price && (
          <Row
            k="Current price"
            v={`${usd(ev.price.priceUSDT)}${ev.price.source === "demo" ? " (demo price)" : ""}`}
          />
        )}
      </div>
    </div>
  );
}
function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className={`intent-row ${warn ? "warn" : ""}`}>
      <span>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

/** Direct edits of the structured intent: allocation, slippage, entry price, take profit, stop loss, expiry. */
function EditForm({
  intent,
  onChange,
}: {
  intent: Intent;
  onChange: (fn: (i: Intent) => Intent) => void;
}) {
  const tp = intent.exitConditions.find((e) => e.type === "TAKE_PROFIT_BPS");
  const sl = intent.exitConditions.find((e) => e.type === "STOP_LOSS_BPS");
  const entryPrice = intent.entryConditions.find(
    (e) => e.type === "PRICE_BELOW" || e.type === "PRICE_ABOVE",
  );
  const setExit = (
    type: "TAKE_PROFIT_BPS" | "STOP_LOSS_BPS",
    pctText: string,
  ) =>
    onChange((i) => {
      i.exitConditions = i.exitConditions.filter((e) => e.type !== type);
      const v = Math.round(Number(pctText) * 100);
      if (pctText !== "" && Number.isFinite(v) && v > 0)
        i.exitConditions.push({ type, value: v });
      return i;
    });
  const [hours, setHours] = useState(() =>
    intent.constraints.validUntil
      ? String(
          Math.max(
            1,
            Math.round(
              (intent.constraints.validUntil - Date.now() / 1000) / 3600,
            ),
          ),
        )
      : "24",
  );
  return (
    <fieldset className="intent-edit">
      <legend>Edit strategy</legend>
      <label>
        Allocation type
        <select
          value={intent.allocation.type}
          onChange={(e) =>
            onChange((i) => {
              i.allocation.type = e.target
                .value as Intent["allocation"]["type"];
              return i;
            })
          }
        >
          <option value="FIXED_USDT">Fixed USDT</option>
          <option value="PORTFOLIO_PERCENT">
            {intent.side === "SELL" ? "% of position" : "% of portfolio"}
          </option>
          {intent.side === "BUY" && (
            <option value="VAULT_PERCENT">% of vault</option>
          )}
        </select>
      </label>
      <label>
        Allocation value
        <input
          inputMode="decimal"
          value={intent.allocation.value}
          onChange={(e) =>
            onChange((i) => {
              i.allocation.value = e.target.value;
              return i;
            })
          }
        />
      </label>
      <label>
        Max slippage (%)
        <input
          inputMode="decimal"
          value={
            intent.constraints.maxSlippageBps !== undefined
              ? String(intent.constraints.maxSlippageBps / 100)
              : ""
          }
          onChange={(e) =>
            onChange((i) => {
              const v = Math.round(Number(e.target.value) * 100);
              if (v > 0) i.constraints.maxSlippageBps = v;
              else delete i.constraints.maxSlippageBps;
              return i;
            })
          }
        />
      </label>
      {entryPrice && "priceUSDT" in entryPrice && (
        <label>
          Entry price (USDT)
          <input
            inputMode="decimal"
            value={entryPrice.priceUSDT}
            onChange={(e) =>
              onChange((i) => {
                const c = i.entryConditions.find(
                  (x) => x.type === entryPrice.type,
                );
                if (c && "priceUSDT" in c) c.priceUSDT = e.target.value;
                return i;
              })
            }
          />
        </label>
      )}
      <label>
        Take profit (%)
        <input
          inputMode="decimal"
          value={tp && "value" in tp ? String(tp.value / 100) : ""}
          placeholder="none"
          onChange={(e) => setExit("TAKE_PROFIT_BPS", e.target.value)}
        />
      </label>
      <label>
        Stop loss (%)
        <input
          inputMode="decimal"
          value={sl && "value" in sl ? String(sl.value / 100) : ""}
          placeholder="none"
          onChange={(e) => setExit("STOP_LOSS_BPS", e.target.value)}
        />
      </label>
      <label>
        Valid for (hours)
        <input
          inputMode="numeric"
          value={hours}
          onChange={(e) => {
            setHours(e.target.value);
            onChange((i) => {
              const h = Number(e.target.value);
              if (h > 0)
                i.constraints.validUntil = Math.floor(
                  Date.now() / 1000 + h * 3600,
                );
              return i;
            });
          }}
        />
      </label>
    </fieldset>
  );
}
