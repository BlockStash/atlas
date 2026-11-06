"use client";
import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ExternalLink,
  Eye,
  Flag,
  PenLine,
  Rocket,
  Target,
  X,
  XCircle,
} from "lucide-react";
import { STAGE, TradeResult } from "@/components/intent/dashboard";
import {
  execFee,
  execQty,
  execValue,
  intentApi,
  type IntentEvent,
  type IntentView,
} from "@/lib/intent/client";
import type { ExecutablePlan } from "@/lib/strategy-core";

const DONE = ["COMPLETED"];
const BAD = ["FAILED", "INVALID", "CANCELLED", "EXPIRED"];
const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

/** Deployments of this strategy's plan: same stock and the same original prompt. */
export function useDeployments(plan: ExecutablePlan | undefined, bump = 0) {
  const [items, setItems] = useState<IntentView[] | null>(null);
  useEffect(() => {
    if (!plan) return;
    let live = true;
    const load = () =>
      intentApi
        .list()
        .then((r) => {
          if (!live) return;
          const sym = plan.intent.asset.symbol;
          const prompt = plan.intent.metadata.originalPrompt;
          setItems(
            r.intents
              .filter(
                (i) =>
                  i.intent.asset.symbol === sym &&
                  i.intent.metadata.originalPrompt === prompt &&
                  i.status !== "AWAITING_APPROVAL",
              )
              .sort((a, b) => b.createdAt - a.createdAt),
          );
        })
        .catch(() => live && setItems((x) => x ?? []));
    void load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [plan, bump]);
  return items;
}

export function statusOf(items: IntentView[] | null) {
  if (!items) return { tone: "idle", title: "Checking…", text: "" };
  const latest = items[0];
  if (!latest)
    return {
      tone: "idle",
      title: "Not deployed",
      text: "Run a backtest or paper trade, then deploy when you are ready.",
    };
  const st = STAGE[latest.status];
  return {
    tone: DONE.includes(latest.status)
      ? "done"
      : BAD.includes(latest.status)
        ? "bad"
        : "live",
    title: st?.title ?? label(latest.status),
    text:
      latest.error && !DONE.includes(latest.status)
        ? latest.error.message
        : (st?.text ?? ""),
  };
}

export function StatusCard({ items }: { items: IntentView[] | null }) {
  const s = statusOf(items);
  const latest = items?.[0];
  const Icon =
    s.tone === "done" || s.tone === "live"
      ? CheckCircle2
      : s.tone === "bad"
        ? XCircle
        : CircleDashed;
  return (
    <section className={`panel strategy-status st-${s.tone}`} role="status">
      <Icon size={24} />
      <div>
        <strong>{s.title}</strong>
        <span>{s.text}</span>
      </div>
      {latest && (
        <em className={`intent-status st-${latest.status.toLowerCase()}`}>
          {label(latest.status)}
        </em>
      )}
    </section>
  );
}

const shortWhen = (sec: number) =>
  new Date(sec * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function Deployment({ v, compact }: { v: IntentView; compact?: boolean }) {
  const tone = DONE.includes(v.status)
    ? "done"
    : BAD.includes(v.status)
      ? "bad"
      : "live";
  return (
    <article
      className={`strategy-deployment tone-${tone} ${compact ? "compact" : ""}`}
    >
      <header>
        <strong>
          {v.intent.asset.symbol}
          <span className={`deploy-side ${v.intent.side.toLowerCase()}`}>
            {v.intent.side}
          </span>
        </strong>
        <span className={`intent-status st-${v.status.toLowerCase()}`}>
          {label(v.status)}
        </span>
        <time dateTime={new Date(v.createdAt * 1000).toISOString()}>
          {shortWhen(v.createdAt)}
        </time>
      </header>
      {!compact && (
        <>
          <p className="intent-summary-line" title={v.summary}>
            {v.summary}
          </p>
          {v.error && !DONE.includes(v.status) && (
            <p className="intent-note">{v.error.message}</p>
          )}
          <TradeResult v={v} />
        </>
      )}
    </article>
  );
}

/**
 * Live status and trades of every deployment of this strategy. The newest run is shown in full;
 * earlier runs that ended without trading (cancelled, failed, expired) stay as one-line entries,
 * and anything beyond the first few is folded away.
 */
export function DeploymentsPanel({ items }: { items: IntentView[] | null }) {
  const [all, setAll] = useState(false);
  if (!items?.length) return null;
  const [latest, ...rest] = items;
  const shown = all ? rest : rest.slice(0, 3);
  return (
    <section className="panel strategy-deployments">
      <div className="strategy-deployments-head">
        <h2>Deployments</h2>
        <span className="muted">
          {items.length} run{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <Deployment v={latest!} />
      {rest.length > 0 && (
        <div className="strategy-deployments-earlier">
          <span className="eyebrow">Earlier runs</span>
          {shown.map((v) => (
            <Deployment key={v.id} v={v} compact={BAD.includes(v.status)} />
          ))}
          {rest.length > 3 && (
            <button className="text-button" onClick={() => setAll(!all)}>
              <ChevronDown size={14} className={all ? "flip" : ""} />
              {all ? "Show fewer" : `Show ${rest.length - 3} more`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface Row {
  at: number;
  title: string;
  detail?: string;
  tone: "ok" | "bad" | "info";
  icon?: "buy" | "sell";
}
const EVENT: Record<string, [string, Row["tone"]]> = {
  PROMPT_RECEIVED: ["Prompt received", "info"],
  INTENT_PARSED: ["Plan parsed", "info"],
  RISK_CHECKED: ["Risk checked", "info"],
  SIMULATION_COMPLETE: ["Simulation complete", "info"],
  USER_SIGNED: ["You signed the strategy", "ok"],
  STRATEGY_ACTIVATED: ["Strategy deployed", "ok"],
  ENTRY_CONDITION_MET: ["Entry condition met", "ok"],
  TRADE_SUBMITTED: ["Trade submitted", "info"],
  TRADE_CONFIRMED: ["Trade confirmed", "ok"],
  POSITION_MONITORING: ["Monitoring the position", "info"],
  EXIT_CONDITION_MET: ["Exit condition met", "ok"],
  POSITION_CLOSED: ["Position closed", "ok"],
  EXECUTION_FAILED: ["Execution failed", "bad"],
  EXECUTION_RETRY: ["Retrying execution", "bad"],
  ENTRY_BLOCKED: ["Entry blocked", "bad"],
  EXPIRED: ["Strategy expired", "bad"],
  CANCELLED: ["Strategy cancelled", "bad"],
  MANUAL_CLOSE_REQUESTED: ["Close requested", "info"],
  MANUAL_EDIT: ["Edited", "info"],
};

const STEPS = [
  {
    key: "sign",
    label: "Signed",
    hint: "You approved the rules",
    icon: PenLine,
    ev: ["USER_SIGNED"],
  },
  {
    key: "live",
    label: "Deployed",
    hint: "Atlas is watching",
    icon: Rocket,
    ev: ["STRATEGY_ACTIVATED"],
  },
  {
    key: "entry",
    label: "Entry met",
    hint: "Your entry rule hit",
    icon: Target,
    ev: ["ENTRY_CONDITION_MET"],
  },
  {
    key: "buy",
    label: "Bought",
    hint: "Shares purchased",
    icon: ArrowDownToLine,
    ev: ["TRADE_CONFIRMED"],
    exec: "ENTRY",
  },
  {
    key: "watch",
    label: "Monitoring",
    hint: "Waiting for your exit",
    icon: Eye,
    ev: ["POSITION_MONITORING"],
  },
  {
    key: "exit",
    label: "Exit met",
    hint: "Your exit rule hit",
    icon: Flag,
    ev: ["EXIT_CONDITION_MET"],
  },
  {
    key: "sell",
    label: "Sold",
    hint: "Result locked in",
    icon: ArrowUpFromLine,
    ev: ["POSITION_CLOSED"],
    exec: "EXIT",
  },
] as const;

/** An animated step tracker: finished steps tick, the current one pulses, the rest wait. */
function Pipeline({ v, events }: { v: IntentView; events: IntentEvent[] }) {
  const has = (t: readonly string[]) => events.some((e) => t.includes(e.type));
  const done = STEPS.map(
    (st) =>
      has(st.ev) ||
      ("exec" in st && v.executions.some((x) => x.kind === st.exec)) ||
      (st.key === "sign" && v.status !== "AWAITING_APPROVAL") ||
      (st.key === "live" && v.status !== "AWAITING_APPROVAL"),
  );
  // Steps complete in order; fill gaps so one missed event never leaves a hole.
  const last = done.lastIndexOf(true);
  const finished = DONE.includes(v.status);
  const failed = BAD.includes(v.status);
  const filled = STEPS.map((_, i) => i <= last || finished);
  const current = finished ? -1 : Math.min(last + 1, STEPS.length - 1);
  const pct = finished ? 100 : (Math.max(last, 0) / (STEPS.length - 1)) * 100;
  return (
    <div
      className={`pipe ${failed ? "failed" : ""} ${finished ? "finished" : ""}`}
      style={{ ["--pct" as string]: `${pct}%` }}
    >
      <div className="pipe-track" aria-hidden>
        <i />
      </div>
      <ol>
        {STEPS.map((st, i) => {
          const state = filled[i]
            ? "done"
            : i === current
              ? failed
                ? "bad"
                : "now"
              : "wait";
          const Icon = state === "done" ? Check : state === "bad" ? X : st.icon;
          return (
            <li key={st.key} className={state} style={{ ["--i" as string]: i }}>
              <span className="pipe-dot">
                <Icon size={15} />
              </span>
              <b>{st.label}</b>
              <small>
                {state === "now"
                  ? failed
                    ? "Stopped here"
                    : st.hint
                  : state === "done"
                    ? "Done"
                    : ""}
              </small>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Counts a number up so a result feels earned, not dropped. Honors reduced motion. */
function useCountUp(target: number, ms = 900) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      return setVal(target);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setVal(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return val;
}

function Outcome({ v }: { v: IntentView }) {
  const buy = v.executions.find((e) => e.kind === "ENTRY");
  const sell = v.executions.find((e) => e.kind === "EXIT");
  const net =
    buy && sell
      ? execValue(sell) - execValue(buy) - execFee(buy) - execFee(sell)
      : 0;
  const shown = useCountUp(net);
  if (!buy || !sell) return null;
  const cost = execValue(buy);
  return (
    <div className={`outcome ${net >= 0 ? "gain" : "loss"}`}>
      <span>Final result</span>
      <strong>
        {shown >= 0 ? "+" : "−"}${Math.abs(shown).toFixed(2)}
      </strong>
      <em>
        {net >= 0 ? "+" : ""}
        {cost ? ((net / cost) * 100).toFixed(2) : "0.00"}% on ${cost.toFixed(2)}{" "}
        after fees
      </em>
    </div>
  );
}

/** Everything that happened to this strategy, one card per deployment. */
export function ActivityTab({ items }: { items: IntentView[] | null }) {
  const [events, setEvents] = useState<Record<string, IntentEvent[]>>({});
  const key = (items ?? []).map((i) => `${i.id}:${i.status}`).join(",");
  useEffect(() => {
    let live = true;
    const run = async () => {
      const out: Record<string, IntentEvent[]> = {};
      for (const i of items ?? [])
        out[i.id] = await intentApi
          .events(i.id)
          .then((r) => r.events)
          .catch(() => []);
      if (live) setEvents(out);
    };
    void run();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!items) return <p className="intent-note">Loading activity…</p>;
  if (!items.length)
    return (
      <section className="panel strategy-activity">
        <h2>Activity</h2>
        <div className="activity-empty">
          <Rocket size={28} />
          <p>
            Nothing yet. Deploy this strategy and you will watch it move through
            each step: signed, deployed, bought, monitored and sold.
          </p>
        </div>
      </section>
    );
  return (
    <>
      {items.map((v) => {
        const evs = events[v.id] ?? [];
        const rows: Row[] = [];
        for (const e of evs) {
          const [title, tone] = EVENT[e.type] ?? [label(e.type), "info"];
          const p = e.payload as Record<string, unknown>;
          rows.push({
            at: e.timestamp,
            title,
            tone,
            detail:
              typeof p?.reason === "string"
                ? p.reason
                : typeof p?.message === "string"
                  ? p.message
                  : Array.isArray(p?.reasons)
                    ? (p.reasons as string[]).join(" ")
                    : undefined,
          });
        }
        for (const x of v.executions)
          rows.push({
            at: v.createdAt,
            title: `${x.kind === "ENTRY" ? "Bought" : "Sold"} ${execQty(x).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${v.intent.asset.symbol} at $${Number(x.price_usdt).toFixed(2)}`,
            detail: x.tx_hash
              ? `Transaction ${x.tx_hash.slice(0, 10)}…${x.tx_hash.slice(-6)}`
              : "Simulated fill",
            tone: "ok",
            icon: x.kind === "ENTRY" ? "buy" : "sell",
          });
        rows.sort((a, b) => b.at - a.at);
        return (
          <section key={v.id} className="panel strategy-activity">
            <header className="activity-head">
              <div>
                <h2>
                  {v.intent.asset.symbol} · {v.intent.side}
                </h2>
                <time>{new Date(v.createdAt * 1000).toLocaleString()}</time>
              </div>
              <span className={`intent-status st-${v.status.toLowerCase()}`}>
                {label(v.status)}
              </span>
            </header>
            <Pipeline v={v} events={evs} />
            {v.error && !DONE.includes(v.status) && (
              <p className="activity-alert">{v.error.message}</p>
            )}
            <Outcome v={v} />
            {v.executionMode === "ONCHAIN" &&
              v.executions.some((x) => x.tx_hash) && (
                <div className="activity-tx">
                  <span>View on Sepolia</span>
                  {v.executions
                    .filter((x) => x.tx_hash)
                    .map((x) => (
                      <a
                        key={x.kind}
                        href={`https://sepolia.etherscan.io/tx/${x.tx_hash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {x.kind === "ENTRY" ? "Buy" : "Sell"} transaction ·{" "}
                        {x.tx_hash!.slice(0, 8)}…{x.tx_hash!.slice(-6)}
                        <ExternalLink size={13} />
                      </a>
                    ))}
                </div>
              )}
            <details className="activity-drop">
              <summary>
                <span>What happened</span>
                <small>{rows.length} steps</small>
                <ChevronDown size={16} />
              </summary>
              <ol className="strategy-feed">
                {rows.map((r, i) => (
                  <li
                    key={i}
                    className={r.tone}
                    style={{ ["--d" as string]: `${Math.min(i, 12) * 60}ms` }}
                  >
                    <span className="feed-dot">
                      {r.icon === "buy" ? (
                        <ArrowDownToLine size={13} />
                      ) : r.icon === "sell" ? (
                        <ArrowUpFromLine size={13} />
                      ) : r.tone === "bad" ? (
                        <X size={13} />
                      ) : (
                        <Check size={13} />
                      )}
                    </span>
                    <div>
                      <strong>{r.title}</strong>
                      {r.detail && <span>{r.detail}</span>}
                    </div>
                    <time>{new Date(r.at * 1000).toLocaleTimeString()}</time>
                  </li>
                ))}
              </ol>
            </details>
          </section>
        );
      })}
    </>
  );
}
