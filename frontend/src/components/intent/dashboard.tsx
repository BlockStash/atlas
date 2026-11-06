"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bell, Bot, Plus } from "lucide-react";
import { DashboardShell } from "@/components/dashboard/shell";
import { useAtlas } from "@/components/atlas/provider";
import { DemoBanner } from "./new";
import {
  TIMELINE,
  bpsPct,
  describeAllocation,
  describeEntry,
  describeExit,
  intentApi,
  num,
  timeLeft,
  usd,
  type IntentConfig,
  type IntentEvent,
  type IntentView,
  type Notification,
} from "@/lib/intent/client";

const TABS = {
  Active: [
    "ACTIVE",
    "WAITING_FOR_ENTRY",
    "EXECUTING",
    "POSITION_OPEN",
    "MONITORING",
    "EXIT_TRIGGERED",
    "AWAITING_APPROVAL",
    "PAUSED",
  ],
  Completed: ["COMPLETED"],
  Cancelled: ["CANCELLED", "EXPIRED"],
  Failed: ["FAILED", "INVALID"],
} as const;
type Tab = keyof typeof TABS;
const LABEL: Record<string, string> = {
  WAITING_FOR_ENTRY: "WAITING FOR ENTRY",
  POSITION_OPEN: "POSITION OPEN",
  EXIT_TRIGGERED: "EXIT TRIGGERED",
  AWAITING_APPROVAL: "AWAITING SIGNATURE",
  EXECUTING: "EXECUTING",
};

export function IntentDashboard() {
  const { toast } = useAtlas();
  const [items, setItems] = useState<IntentView[]>([]);
  const [tab, setTab] = useState<Tab>("Active");
  const [cfg, setCfg] = useState<IntentConfig | null>(null);
  const [notes, setNotes] = useState<Notification[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, n] = await Promise.all([
        intentApi.list(),
        intentApi.notifications(),
      ]);
      setItems(l.intents);
      setNotes((prev) => {
        // Surface notifications that arrived since the last poll.
        const seen = new Set(prev.map((p) => p.id));
        if (prev.length)
          n.notifications
            .filter((x) => !seen.has(x.id))
            .slice(0, 3)
            .forEach((x) => toast(x.message));
        return n.notifications;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load strategies.");
    } finally {
      setLoaded(true);
    }
  }, [toast]);
  useEffect(() => {
    intentApi
      .config()
      .then(setCfg)
      .catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const shown = useMemo(
    () =>
      items.filter((i) => (TABS[tab] as readonly string[]).includes(i.status)),
    [items, tab],
  );
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed.");
    }
  };
  const unread = notes.filter((n) => !n.read).length;

  return (
    <DashboardShell>
      <main className="protocol-content intent-page">
        <div className="section-heading">
          <div>
            <span className="eyebrow">AI INTENT TRADING</span>
            <h1>
              <Bot size={22} /> Intent strategies
            </h1>
          </div>
          <Link className="btn primary small" href="/intent/new">
            <Plus size={14} /> New strategy
          </Link>
        </div>
        <DemoBanner simulated={cfg?.executionMode === "SIMULATED"} />
        {cfg?.demoControls && <DemoControls items={items} onDone={load} />}
        {notes.length > 0 && (
          <details
            className="intent-notes"
            onToggle={(e) =>
              (e.currentTarget as HTMLDetailsElement).open &&
              unread &&
              void intentApi.notifications(true)
            }
          >
            <summary>
              <Bell size={14} /> Notifications{unread ? ` (${unread} new)` : ""}
            </summary>
            <ul>
              {notes.slice(0, 12).map((n) => (
                <li key={n.id}>
                  {n.message}{" "}
                  <time>{new Date(n.created_at * 1000).toLocaleString()}</time>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="intent-tabs" role="tablist">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t}{" "}
              <span>
                {
                  items.filter((i) =>
                    (TABS[t] as readonly string[]).includes(i.status),
                  ).length
                }
              </span>
            </button>
          ))}
        </div>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        {loaded && !shown.length && (
          <div className="panel intent-empty">
            <p>No {tab.toLowerCase()} strategies.</p>
            <Link className="btn secondary small" href="/intent/new">
              Describe a trade
            </Link>
          </div>
        )}
        <div className="intent-list">
          {shown.map((i) => (
            <IntentCard
              key={i.id}
              v={i}
              expanded={open === i.id}
              onToggle={() => setOpen(open === i.id ? null : i.id)}
              onCancel={() => act(() => intentApi.cancel(i.id))}
              onClose={() => act(() => intentApi.close(i.id))}
            />
          ))}
        </div>
      </main>
    </DashboardShell>
  );
}

function IntentCard({
  v,
  expanded,
  onToggle,
  onCancel,
  onClose,
}: {
  v: IntentView;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const i = v.intent;
  const pos = v.position;
  const tp = i.exitConditions.find((e) => e.type === "TAKE_PROFIT_BPS");
  const sl = i.exitConditions.find((e) => e.type === "STOP_LOSS_BPS");
  const cancellable = [
    "AWAITING_APPROVAL",
    "ACTIVE",
    "WAITING_FOR_ENTRY",
    "PAUSED",
  ].includes(v.status);
  const closable =
    ["POSITION_OPEN", "MONITORING"].includes(v.status) && !v.closeRequested;
  const pnl = pos?.pnlBps ?? 0;
  const tpBps = tp && "value" in tp ? tp.value : 0,
    slBps = sl && "value" in sl ? sl.value : 0;
  // Progress bar from -stop to +target around the entry price.
  const lo = -slBps,
    hi = tpBps,
    pct =
      hi - lo > 0
        ? Math.min(100, Math.max(0, ((pnl - lo) / (hi - lo)) * 100))
        : 50;
  return (
    <article className="panel intent-item">
      <header>
        <div>
          <h3>{i.asset.symbol}</h3>
          <span>
            {i.asset.companyName} · {i.side}
          </span>
        </div>
        <span className={`intent-status st-${v.status.toLowerCase()}`}>
          {LABEL[v.status] ?? v.status}
        </span>
      </header>
      <div className="intent-rows">
        {pos ? (
          <>
            <div className="intent-row">
              <span>Entry</span>
              <strong>{usd(pos.entry_price_usdt)}</strong>
            </div>
            <div className="intent-row">
              <span>Current</span>
              <strong>{usd(pos.current_price_usdt)}</strong>
            </div>
            <div className={`intent-row ${pnl >= 0 ? "gain" : "loss"}`}>
              <span>P&amp;L</span>
              <strong>{bpsPct(pnl, true)}</strong>
            </div>
            {tp && (
              <div className="intent-row">
                <span>Take profit</span>
                <strong>{describeExit(tp)}</strong>
              </div>
            )}
            {sl && (
              <div className="intent-row">
                <span>Stop loss</span>
                <strong>{describeExit(sl)}</strong>
              </div>
            )}
            {(tp || sl) && (
              <div
                className="intent-progress"
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Progress between stop loss and take profit"
              >
                <i
                  style={{ width: `${pct}%` }}
                  className={pnl >= 0 ? "gain" : "loss"}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <div className="intent-row">
              <span>Allocation</span>
              <strong>{describeAllocation(i.allocation, i.side)}</strong>
            </div>
            <div className="intent-row">
              <span>Entry rule</span>
              <strong>
                {i.entryConditions
                  .map((c) => describeEntry(c, i.asset.market))
                  .join(" and ") || "—"}
              </strong>
            </div>
            <div className="intent-row">
              <span>Max slippage</span>
              <strong>
                {i.constraints.maxSlippageBps !== undefined
                  ? bpsPct(i.constraints.maxSlippageBps)
                  : "—"}
              </strong>
            </div>
            <div className="intent-row">
              <span>Expires</span>
              <strong>{timeLeft(v.validUntil)}</strong>
            </div>
            {v.blocked && (
              <div className="intent-row warn">
                <span>Waiting</span>
                <strong>{v.blocked}</strong>
              </div>
            )}
          </>
        )}
        {v.error && (
          <div className="intent-row warn">
            <span>{v.error.code}</span>
            <strong>{v.error.message}</strong>
          </div>
        )}
      </div>
      <p className="intent-summary-line">{v.summary}</p>
      <footer>
        <button className="text-button" onClick={onToggle}>
          {expanded ? "Hide timeline" : "Execution timeline"}
        </button>
        {cancellable && (
          <button className="btn secondary small" onClick={onCancel}>
            Cancel Strategy
          </button>
        )}
        {closable && (
          <button className="btn secondary small" onClick={onClose}>
            Close position
          </button>
        )}
        {v.closeRequested && (
          <span className="intent-note">Close requested…</span>
        )}
      </footer>
      {expanded && <Timeline id={v.id} />}
    </article>
  );
}

function Timeline({ id }: { id: string }) {
  const [events, setEvents] = useState<IntentEvent[] | null>(null);
  useEffect(() => {
    let live = true;
    const run = () =>
      intentApi
        .events(id)
        .then((r) => live && setEvents(r.events))
        .catch(() => undefined);
    void run();
    const t = setInterval(run, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  if (!events) return <p className="intent-note">Loading timeline…</p>;
  const at = new Map<string, number>();
  for (const e of events) if (!at.has(e.type)) at.set(e.type, e.timestamp);
  const extra = events.filter((e) =>
    [
      "EXECUTION_FAILED",
      "EXECUTION_RETRY",
      "EXPIRED",
      "CANCELLED",
      "MANUAL_EDIT",
      "ENTRY_BLOCKED",
      "MANUAL_CLOSE_REQUESTED",
    ].includes(e.type),
  );
  return (
    <div className="intent-timeline">
      <ol>
        {TIMELINE.map((t) => (
          <li key={t.type} className={at.has(t.type) ? "done" : ""}>
            <span>{t.label}</span>
            {at.has(t.type) && (
              <time>
                {new Date(at.get(t.type)! * 1000).toLocaleTimeString()}
              </time>
            )}
          </li>
        ))}
      </ol>
      {extra.length > 0 && (
        <ul className="intent-extra">
          {extra.slice(-6).map((e) => (
            <li key={e.id}>
              <b>{e.type.replace(/_/g, " ").toLowerCase()}</b>{" "}
              <time>{new Date(e.timestamp * 1000).toLocaleTimeString()}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Investor-demo controls: move a price, force the market open, run the worker once. Server rejects these outside demo mode. */
function DemoControls({
  items,
  onDone,
}: {
  items: IntentView[];
  onDone: () => void;
}) {
  const { toast } = useAtlas();
  const stocks = [
    ...new Map(
      items.map((i) => [i.intent.asset.stockId, i.intent.asset.symbol]),
    ).entries(),
  ];
  const [stock, setStock] = useState("");
  const [bps, setBps] = useState("10800");
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    }
  };
  return (
    <details className="panel intent-demo-controls">
      <summary>Demo controls</summary>
      <div>
        <button
          className="btn secondary small"
          onClick={() =>
            run(() => intentApi.demoMarket(true), "Markets forced open (demo).")
          }
        >
          Force markets open
        </button>
        <button
          className="btn secondary small"
          onClick={() =>
            run(
              () => intentApi.demoMarket(false),
              "Markets follow the real calendar.",
            )
          }
        >
          Use real calendar
        </button>
        <select
          aria-label="Stock"
          value={stock}
          onChange={(e) => setStock(e.target.value)}
        >
          <option value="">Stock…</option>
          {stocks.map(([id, sym]) => (
            <option key={id} value={id}>
              {sym}
            </option>
          ))}
        </select>
        <input
          aria-label="Price multiplier in basis points"
          value={bps}
          onChange={(e) => setBps(e.target.value)}
          title="10000 = unchanged, 10800 = +8%"
        />
        <button
          className="btn secondary small"
          disabled={!stock}
          onClick={() =>
            run(
              () => intentApi.demoPrice(stock, Number(bps)),
              `Demo price set to ${num(String(Number(bps) / 100))}% of base.`,
            )
          }
        >
          Set demo price
        </button>
        <button
          className="btn primary small"
          onClick={() => run(() => intentApi.demoTick(), "Worker ran.")}
        >
          Run worker now
        </button>
      </div>
    </details>
  );
}
