"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Backtest, BacktestDays } from "@/lib/intent/client";

export const PERIODS: { days: BacktestDays; label: string }[] = [
  { days: 30, label: "1M" },
  { days: 90, label: "3M" },
  { days: 180, label: "6M" },
];

const H = 260,
  PAD = { top: 16, right: 74, bottom: 28, left: 12 };
const money = (v: number) =>
  `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const price = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const EXIT_LABEL: Record<string, string> = {
  TAKE_PROFIT: "Target hit",
  STOP_LOSS: "Stop hit",
  PRICE_EXIT: "Price exit",
  TIME_EXIT: "Time exit",
};

/** Fan chart of simulated price paths with the plan's levels and the median run's trade marked. */
function FanChart({ bt }: { bt: Backtest }) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setW(Math.max(300, Math.round(e!.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { band, sample, levels } = bt;
  const vals = [
    ...band.flatMap((b) => [b.p10, b.p90]),
    ...sample.path.map((p) => p.price),
    ...[levels.takeProfit, levels.stopLoss, levels.entryTrigger].filter(
      (v): v is number => v != null,
    ),
  ];
  const lo = Math.min(...vals),
    hi = Math.max(...vals),
    pad = (hi - lo) * 0.06 || 1;
  const yMin = lo - pad,
    yMax = hi + pad,
    x0 = PAD.left,
    x1 = W - PAD.right,
    y0 = PAD.top,
    y1 = H - PAD.bottom;
  const x = (d: number) => x0 + (d / bt.days) * (x1 - x0);
  const y = (p: number) => y0 + (1 - (p - yMin) / (yMax - yMin)) * (y1 - y0);
  const line = (pts: { day: number; v: number }[]) =>
    pts
      .map(
        (p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`,
      )
      .join("");
  const area =
    line(band.map((b) => ({ day: b.day, v: b.p90 }))) +
    band
      .slice()
      .reverse()
      .map((b) => `L${x(b.day).toFixed(1)},${y(b.p10).toFixed(1)}`)
      .join("") +
    "Z";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * bt.days));
  const hLine = (
    v: number | null,
    color: string,
    label: string,
    dash = "6 5",
  ) =>
    v == null ? null : (
      <g key={label}>
        <line
          x1={x0}
          x2={x1}
          y1={y(v)}
          y2={y(v)}
          stroke={color}
          strokeWidth="1.25"
          strokeDasharray={dash}
          opacity="0.85"
        />
        <text
          x={x1 + 8}
          y={y(v)}
          dy="0.35em"
          fill={color}
          fontSize="12"
          fontWeight="600"
        >
          {label}
        </text>
      </g>
    );

  return (
    <div className="bt-chart" ref={ref}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Simulated price paths for this plan"
      >
        <defs>
          <linearGradient id="bt-band" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--blue)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--blue)" stopOpacity="0.06" />
          </linearGradient>
        </defs>
        {ticks.map((d) => (
          <g key={d}>
            <line
              x1={x(d)}
              x2={x(d)}
              y1={y0}
              y2={y1}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={x(d)}
              y={H - 8}
              textAnchor={d === 0 ? "start" : d === bt.days ? "end" : "middle"}
              fill="var(--muted)"
              fontSize="11"
            >
              {d === 0 ? "Today" : `Day ${d}`}
            </text>
          </g>
        ))}
        <path d={area} fill="url(#bt-band)" />
        <path
          d={line(band.map((b) => ({ day: b.day, v: b.p50 })))}
          fill="none"
          stroke="var(--blue)"
          strokeWidth="1.25"
          strokeDasharray="3 4"
          opacity="0.8"
        />
        {hLine(levels.takeProfit, "var(--green)", "Target")}
        {hLine(levels.stopLoss, "var(--red)", "Stop")}
        {levels.entryTrigger != null &&
          hLine(levels.entryTrigger, "#d6c27a", "Entry")}
        <path
          d={line(sample.path.map((p) => ({ day: p.day, v: p.price })))}
          fill="none"
          stroke="var(--text)"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        {sample.entry && (
          <circle
            cx={x(sample.entry.day)}
            cy={y(sample.entry.price)}
            r="5"
            fill="#d6c27a"
            stroke="var(--panel)"
            strokeWidth="2"
          >
            <title>Entry {price(sample.entry.price)}</title>
          </circle>
        )}
        {sample.exit && (
          <circle
            cx={x(sample.exit.day)}
            cy={y(sample.exit.price)}
            r="5.5"
            fill={
              sample.exit.reason === "STOP_LOSS" ? "var(--red)" : "var(--green)"
            }
            stroke="var(--panel)"
            strokeWidth="2"
          >
            <title>
              {EXIT_LABEL[sample.exit.reason] ?? sample.exit.reason}{" "}
              {price(sample.exit.price)}
            </title>
          </circle>
        )}
      </svg>
      <div className="bt-legend">
        <span>
          <i className="swatch band" /> 80% of {bt.runs} simulated paths
        </span>
        <span>
          <i className="swatch median" /> Median path
        </span>
        <span>
          <i className="swatch sample" /> Median-outcome run
        </span>
      </div>
    </div>
  );
}

export function BacktestPanel({
  bt,
  days,
  loading,
  error,
  onDays,
}: {
  bt: Backtest | null;
  days: BacktestDays;
  loading: boolean;
  error: string | null;
  onDays: (d: BacktestDays) => void;
}) {
  const s = bt?.stats;
  return (
    <section className="bt-panel" aria-live="polite">
      <header className="bt-head">
        <div>
          <span className="eyebrow">BACKTEST BEFORE YOU DEPLOY</span>
          <h3>How this plan plays out</h3>
        </div>
        <div
          className="bt-periods"
          role="radiogroup"
          aria-label="Backtest period"
        >
          {loading && <Loader2 className="spin" size={15} />}
          {PERIODS.map((p) => (
            <button
              key={p.days}
              type="button"
              role="radio"
              aria-checked={days === p.days}
              className={days === p.days ? "active" : ""}
              onClick={() => onDays(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>
      {error && !bt && <p className="bt-empty">{error}</p>}
      {!bt && !error && (
        <div className="bt-skeleton" aria-label="Running backtest" />
      )}
      {bt && s && (
        <div className={loading ? "bt-body loading" : "bt-body"}>
          <FanChart bt={bt} />
          <dl className="bt-stats">
            <div>
              <dt>Target hit</dt>
              <dd className="positive">{s.takeProfitPct.toFixed(0)}%</dd>
            </div>
            <div>
              <dt>Stop hit</dt>
              <dd className="negative">{s.stopLossPct.toFixed(0)}%</dd>
            </div>
            <div>
              <dt>{s.triggeredPct < 100 ? "Entry triggered" : "Win rate"}</dt>
              <dd>
                {(s.triggeredPct < 100 ? s.triggeredPct : s.winRatePct).toFixed(
                  0,
                )}
                %
              </dd>
            </div>
            <div>
              <dt>Median P&amp;L</dt>
              <dd className={s.medianPnlUSDT >= 0 ? "positive" : "negative"}>
                {money(s.medianPnlUSDT)}
              </dd>
            </div>
            <div>
              <dt>Likely range (10–90%)</dt>
              <dd>
                {money(s.p10PnlUSDT)} to {money(s.p90PnlUSDT)}
              </dd>
            </div>
            <div>
              <dt>Avg. holding time</dt>
              <dd>
                {s.avgHoldDays == null
                  ? "—"
                  : `${s.avgHoldDays.toFixed(1)} days`}
              </dd>
            </div>
          </dl>
          {s.stillOpenPct > 0 && (
            <p className="bt-note">
              {s.stillOpenPct.toFixed(0)}% of runs were still open after{" "}
              {bt.days} days.
            </p>
          )}
          <p className="intent-disclaimer">{bt.disclaimer}</p>
        </div>
      )}
    </section>
  );
}
