"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { DashboardShell } from "@/components/dashboard/shell";
import { useAtlas } from "@/components/atlas/provider";
import { useStrategies } from "@/lib/strategies";

type Draft = {
  symbol: string;
  quantity: string;
  entryTime: string;
  timezone: string;
  maxSlippageBps: number;
  takeProfitBps: number;
  stopLossBps: number;
  expiryTime: string;
};
type Order = {
  id: string;
  status: string;
  draft: Draft;
  entryAt: number;
  expiryAt: number;
  entryFill: string | null;
  exitFill: string | null;
  pnl: string;
  reason: string;
  events: { timestamp: number; reason: string }[];
};
type Preview = {
  order: Order;
  confirmationToken: string;
  estimatedFill: string | null;
};
type State = {
  mode: string;
  source: string;
  simulatedTimestamp: number;
  paused: boolean;
  speed: number;
  tick: number;
  cash: string;
  equity: string;
  pnl: string;
  config: {
    mode: string;
    seed: number;
    spreadBps: number;
    slippageBps: number;
  };
  orders: Order[];
  fills: {
    orderId: string;
    side: string;
    timestamp: number;
    price: string;
    quantity: string;
    fee: string;
    reason: string;
  }[];
  positions: {
    orderId: string;
    symbol: string;
    quantity: string;
    entryFill: string;
    mark: string;
    unrealizedPnl: string;
  }[];
  quotes: {
    symbol: string;
    last: string;
    bid: string;
    ask: string;
    timestamp: number;
    stale: boolean;
  }[];
  history: { symbol: string; timestamp: number; price: string }[];
  replayPolicy: string | null;
};
const EXAMPLE =
  "Buy 5 shares of AAPL at 10:30 a.m. America/New_York on the selected simulation date if estimated buy slippage is at most 0.5%. After the buy fills, sell when the price reaches 2% above or 1% below the entry fill price. Cancel the entry if it has not filled by 10:35 a.m.";
const baseConfig = {
  mode: "synthetic",
  seed: 42,
  startTime: 1793892540,
  stepSeconds: 10,
  spreadBps: 4,
  slippageBps: 5,
  feeBps: 10,
  initialBalance: "25000",
  volatilityBps: 4,
  driftBps: 0,
  regimes: [],
  shocks: [{ tick: 12, symbol: "AAPL", changeBps: 300 }],
};
const instant = (s: number, tz = "UTC") =>
  new Date(s * 1000).toLocaleString("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  });
const money = (s: string) =>
  Number(s).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
export function PaperDashboard() {
  const { wallet } = useAtlas(),
    saved = useStrategies(wallet?.address);
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [prompt, setPrompt] = useState(EXAMPLE),
    [date, setDate] = useState("2026-11-05"),
    [previews, setPreviews] = useState<Preview[]>([]),
    [question, setQuestion] = useState(""),
    [ack, setAck] = useState(false),
    [config, setConfig] = useState(JSON.stringify(baseConfig, null, 2)),
    [parser, setParser] = useState("rules"),
    [selectedStrategy, setSelectedStrategy] = useState("");
  const refresh = useCallback(async () => {
    if (wallet) setState(await api<State>("/paper"));
  }, [wallet]);
  useEffect(() => {
    if (!wallet) return;
    let current = true;
    const poll = () =>
      api<State>("/paper")
        .then((s) => {
          if (current) setState(s);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [wallet]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Paper operation failed");
    } finally {
      setBusy(false);
    }
  };
  const clock = (action: string, extra: Record<string, number> = {}) =>
    run(async () =>
      setState(await api<State>("/paper/clock", { action, ...extra })),
    );
  const reset = (input: unknown) =>
    run(async () => {
      setState(await api<State>("/paper/reset", input));
      setPreviews([]);
      setAck(false);
      setQuestion("");
    });
  const parse = () =>
    run(async () => {
      setQuestion("");
      setPreviews([]);
      setAck(false);
      const r = await api<
        Preview & { status: string; question?: string; parser: string }
      >("/paper/preview", { prompt, date });
      if (r.status !== "OK") {
        setQuestion(r.question ?? "Please clarify your instruction.");
        return;
      }
      setParser(r.parser);
      setPreviews([r]);
      await refresh();
    });
  const confirm = () =>
    run(async () => {
      for (const p of previews)
        await api(`/paper/${p.order.id}/confirm`, {
          confirmed: true,
          confirmationToken: p.confirmationToken,
        });
      setPreviews([]);
      setAck(false);
      await refresh();
    });
  const history = (state?.history ?? []).filter((t) => t.symbol === "AAPL"),
    values = history.map((t) => Number(t.price)),
    lo = Math.min(...values),
    hi = Math.max(...values),
    span = hi - lo || 1;
  const importSaved = () =>
    run(async () => {
      const strategy = saved.strategies.find((s) => s.id === selectedStrategy);
      if (!strategy) throw Error("Choose a saved strategy.");
      const r = await api<{ previews: Preview[] }>("/paper/import", {
        spec: strategy.spec,
        date,
        timezone: "America/New_York",
        entryTime: "10:30",
        expiryTime: "10:35",
      });
      setPreviews(r.previews);
      setAck(false);
      await refresh();
    });
  return (
    <DashboardShell>
      <main className="protocol-content paper-page">
        <div className="section-heading">
          <div>
            <span className="eyebrow">DEVELOPMENT SIMULATOR</span>
            <h1>Paper Trading</h1>
            <p>
              Test intent strategies with a controlled market clock and an
              isolated balance.
            </p>
          </div>
          <Link href="/intent">Existing intent engine ↗</Link>
        </div>
        <div className="paper-banner">
          <strong>Paper Trading</strong> · No wallet signatures, contract
          transactions or real funds. Sessions are kept in server memory and
          reset after a restart or two hours of inactivity.
        </div>
        {!wallet ? (
          <section className="panel paper-card">
            <h2>Connect to start</h2>
            <p>
              Use Atlas’s wallet connection or demo login to keep your paper
              session separate.
            </p>
          </section>
        ) : (
          <>
            {error && (
              <p className="paper-error" role="alert">
                {error}
              </p>
            )}
            {state && (
              <>
                <section className="panel paper-card">
                  <div className="paper-row">
                    <div>
                      <strong>
                        {state.config.mode === "synthetic"
                          ? "Synthetic simulation"
                          : "Historical replay"}
                      </strong>
                      <p>
                        {state.source} · seed {state.config.seed}
                      </p>
                      <time>
                        {instant(state.simulatedTimestamp)} /{" "}
                        {instant(state.simulatedTimestamp, "America/New_York")}
                      </time>
                    </div>
                    <div className="paper-row">
                      <button
                        disabled={busy}
                        onClick={() => clock(state.paused ? "resume" : "pause")}
                      >
                        {state.paused ? "Resume" : "Pause"}
                      </button>
                      <button
                        disabled={busy || !state.paused}
                        onClick={() => clock("step", { steps: 1 })}
                      >
                        Step
                      </button>
                      <button
                        disabled={busy || !state.paused}
                        onClick={() => clock("step", { steps: 120 })}
                      >
                        Advance 120 ticks
                      </button>
                      <label>
                        Speed{" "}
                        <select
                          value={state.speed}
                          onChange={(e) =>
                            clock("speed", { speed: Number(e.target.value) })
                          }
                        >
                          {[1, 10, 60, 240, 600].map((v) => (
                            <option key={v} value={v}>
                              {v}×
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>
                  <p>
                    {state.paused ? "Paused" : "Running"} · tick {state.tick} ·
                    spread {state.config.spreadBps} bps · slippage impact{" "}
                    {state.config.slippageBps} bps
                  </p>
                  {state.replayPolicy && <p>{state.replayPolicy}</p>}
                </section>
                <div className="paper-metrics">
                  {[
                    ["Paper cash", state.cash],
                    ["Account equity", state.equity],
                    ["Net P&L", state.pnl],
                  ].map(([label, value]) => (
                    <section className="panel paper-card" key={label}>
                      <span>{label}</span>
                      <h2>{money(value)} USDT</h2>
                    </section>
                  ))}
                </div>
                <section className="panel paper-card">
                  <h2>AAPL observed price</h2>
                  {history.length ? (
                    <>
                      <svg
                        viewBox="0 0 900 160"
                        role="img"
                        aria-label="AAPL prices observed up to simulation time"
                        style={{ width: "100%", height: 160 }}
                      >
                        <polyline
                          fill="none"
                          stroke="#97b6ff"
                          strokeWidth="2"
                          points={values
                            .map(
                              (p, i) =>
                                `${(i / (values.length - 1 || 1)) * 890 + 5},${145 - ((p - lo) / span) * 130}`,
                            )
                            .join(" ")}
                        />
                      </svg>
                      <p>
                        {history[0]?.price} → {history.at(-1)?.price} USDT ·
                        observed samples only
                      </p>
                    </>
                  ) : (
                    <p>
                      No AAPL observations available at this simulation time.
                    </p>
                  )}
                </section>
              </>
            )}
            <div className="paper-grid">
              <section className="panel paper-card">
                <h2>1. Set up the market</h2>
                <p>
                  Changing configuration resets the clock, orders and paper
                  balance. Drift and volatility are basis points per fixed tick.
                </p>
                <div className="paper-row">
                  <button
                    disabled={busy}
                    onClick={() => {
                      const c = baseConfig;
                      setConfig(JSON.stringify(c, null, 2));
                      void reset(c);
                    }}
                  >
                    Entry & take-profit demo
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const c = { ...baseConfig, slippageBps: 80 };
                      setConfig(JSON.stringify(c, null, 2));
                      void reset(c);
                    }}
                  >
                    Slippage expiry demo
                  </button>
                </div>
                <details>
                  <summary>
                    Seed, regimes, shocks and replay configuration
                  </summary>
                  <textarea
                    className="paper-config"
                    value={config}
                    onChange={(e) => setConfig(e.target.value)}
                    aria-label="Simulation configuration JSON"
                  />
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        setState(
                          await api<State>("/paper/reset", JSON.parse(config)),
                        );
                        setPreviews([]);
                        setAck(false);
                      })
                    }
                  >
                    Apply configuration & reset
                  </button>
                </details>
                <label>
                  Load tick or OHLC replay JSON{" "}
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file)
                        void run(async () => {
                          if (file.size > 2e6)
                            throw Error("Keep the replay file below 2 MB.");
                          const replay = JSON.parse(await file.text());
                          const times =
                            (replay.ticks?.length
                              ? replay.ticks
                              : replay.candles
                            )?.map((r: { timestamp: number }) => r.timestamp) ??
                            [];
                          if (!times.length)
                            throw Error(
                              "Replay requires timestamped ticks or candles.",
                            );
                          const c = {
                            ...baseConfig,
                            mode: "replay",
                            shocks: [],
                            replay,
                            startTime: Math.min(...times),
                          };
                          setConfig(JSON.stringify(c, null, 2));
                          setState(await api<State>("/paper/reset", c));
                          setPreviews([]);
                          setAck(false);
                        });
                    }}
                  />
                </label>
                <p>
                  Replay prices must be in USDT. Intraday historical data is not
                  bundled; use your own timestamped dataset.{" "}
                  <a href="/paper-replay-example.json" download>
                    Download replay example
                  </a>
                </p>
              </section>
              <section className="panel paper-card">
                <h2>2. Describe and preview</h2>
                <label>
                  Selected strategy date{" "}
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => {
                      setDate(e.target.value);
                      setPreviews([]);
                    }}
                  />
                </label>
                <textarea
                  className="paper-prompt"
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setPreviews([]);
                    setAck(false);
                  }}
                  aria-label="Natural language paper strategy"
                />
                <button disabled={busy} onClick={parse}>
                  Preview paper intent
                </button>
                {question && (
                  <p role="status">
                    Clarification needed: {question} Update the instruction and
                    preview again.
                  </p>
                )}
                <details>
                  <summary>Test a saved marketplace strategy</summary>
                  <p>
                    Supports at most one buy/increase rule (RSI, SMA cross,
                    momentum or drawdown) and a bracket exit per asset. Other
                    rules are rejected. Daily lookbacks need sufficient replay
                    history. Uses New York 10:30–10:35 on the selected date.
                  </p>
                  <select
                    aria-label="Saved strategy"
                    value={selectedStrategy}
                    onChange={(e) => setSelectedStrategy(e.target.value)}
                  >
                    <option value="">Choose strategy</option>
                    {saved.strategies.map((s) => (
                      <option value={s.id} key={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={busy || !selectedStrategy}
                    onClick={importSaved}
                  >
                    Preview in paper session
                  </button>
                </details>
              </section>
            </div>
            {previews.length > 0 && (
              <section className="panel paper-card paper-preview">
                <h2>3. Review & explicitly confirm</h2>
                <p>
                  Parser: {parser}. Entry uses the ask plus configured impact.
                  Exit uses the bid minus impact. The slippage cap is checked
                  again before every fill.
                </p>
                {previews.map((p) => (
                  <div key={p.order.id}>
                    <h3>
                      BUY {p.order.draft.quantity} {p.order.draft.symbol}
                    </h3>
                    <p>
                      Entry: {instant(p.order.entryAt, p.order.draft.timezone)}{" "}
                      · cancel unfilled entry at{" "}
                      {instant(p.order.expiryAt, p.order.draft.timezone)}
                    </p>
                    <p>
                      Timezone: {p.order.draft.timezone} · max slippage{" "}
                      {p.order.draft.maxSlippageBps / 100}% · take-profit +
                      {p.order.draft.takeProfitBps / 100}% · stop-loss −
                      {p.order.draft.stopLossBps / 100}% from entry fill
                    </p>
                    <p>
                      Estimated buy fill: {p.estimatedFill ?? "No quote yet"}{" "}
                      USDT. Fees also apply. TP/SL are triggers, not guaranteed
                      fill prices.
                    </p>
                  </div>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />{" "}
                  I reviewed these parameters and authorize only this paper
                  strategy.
                </label>
                <button disabled={busy || !ack} onClick={confirm}>
                  Confirm & activate Paper Trading
                </button>
              </section>
            )}
            {state && (
              <>
                <section className="panel paper-card paper-scroll">
                  <h2>Orders & strategy status</h2>
                  <table>
                    <thead>
                      <tr>
                        {[
                          "Strategy",
                          "Status",
                          "Entry fill",
                          "Exit fill",
                          "Realized P&L",
                          "Latest reason",
                        ].map((v) => (
                          <th key={v}>{v}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {state.orders.map((o) => (
                        <tr key={o.id}>
                          <td>
                            {o.id} · {o.draft.quantity} {o.draft.symbol}
                          </td>
                          <td>
                            {o.status}
                            {["ACTIVE", "PREVIEW"].includes(o.status) && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  run(async () => {
                                    setState(
                                      await api<State>(
                                        `/paper/${o.id}/cancel`,
                                        {},
                                      ),
                                    );
                                    setPreviews((p) =>
                                      p.filter((v) => v.order.id !== o.id),
                                    );
                                  })
                                }
                              >
                                Cancel
                              </button>
                            )}
                          </td>
                          <td>{o.entryFill ?? "—"}</td>
                          <td>{o.exitFill ?? "—"}</td>
                          <td>{money(o.pnl)}</td>
                          <td>
                            {o.reason}
                            <details>
                              <summary>Event history</summary>
                              {o.events.map((e, i) => (
                                <p key={i}>
                                  {instant(e.timestamp)} · {e.reason}
                                </p>
                              ))}
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!state.orders.length && <p>No paper intents yet.</p>}
                </section>
                <section className="panel paper-card paper-scroll">
                  <h2>Open positions</h2>
                  {state.positions.map((p) => (
                    <p key={p.orderId}>
                      {p.symbol} · {p.quantity} shares · entry {p.entryFill} ·
                      mark {p.mark} · unrealized P&L {money(p.unrealizedPnl)}{" "}
                      USDT
                    </p>
                  ))}
                  {!state.positions.length && <p>No open paper positions.</p>}
                  <h2>Fills</h2>
                  {state.fills.map((f, i) => (
                    <p key={i}>
                      {instant(f.timestamp)} · {f.side} {f.quantity} shares @{" "}
                      {f.price} USDT · fee {f.fee} · {f.reason}
                    </p>
                  ))}
                </section>
                <details className="panel paper-card">
                  <summary>Current simulated quote board</summary>
                  <div className="paper-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Last</th>
                          <th>Bid</th>
                          <th>Ask</th>
                          <th>As of</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.quotes.map((q) => (
                          <tr key={q.symbol}>
                            <td>{q.symbol}</td>
                            <td>{q.last}</td>
                            <td>{q.bid}</td>
                            <td>{q.ask}</td>
                            <td>
                              {instant(q.timestamp)} {q.stale ? "· stale" : ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </>
        )}
      </main>
    </DashboardShell>
  );
}
