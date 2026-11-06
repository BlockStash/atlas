"use client";
import { useEffect, useRef, useState } from "react";
import { num } from "@/lib/intent/client";

interface Level {
  label: string;
  price: number;
  kind: "current" | "entry" | "tp" | "sl";
}

const H = 240,
  PAD_Y = 22,
  LABEL_W = 108, // left column: level names
  PRICE_W = 96, // right column: prices
  GAP = 12,
  MIN_LABEL_GAP = 18;

const COLOR = {
  tp: "var(--green)",
  sl: "var(--red)",
  current: "var(--blue)",
  entry: "#d6c27a",
} as const;

/** Push label y-positions apart so close levels (e.g. current ≈ entry) never overlap. */
function spread(ys: number[], min: number, lo: number, hi: number) {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++)
    order[k]!.y = Math.max(order[k]!.y, order[k - 1]!.y + min);
  const overflow = order.length ? order[order.length - 1]!.y - hi : 0;
  if (overflow > 0) {
    order[order.length - 1]!.y = hi;
    for (let k = order.length - 2; k >= 0; k--)
      order[k]!.y = Math.min(order[k]!.y, order[k + 1]!.y - min);
  }
  for (const o of order) o.y = Math.max(lo, o.y);
  const out = [...ys];
  for (const o of order) out[o.i] = o.y;
  return out;
}

/**
 * Price-level ladder: current price, estimated entry, take-profit and stop-loss on one vertical scale.
 * Levels come from the server simulation; nothing here is computed from a forecast.
 * Drawn at its real pixel width so text stays at UI size instead of scaling with the panel.
 */
export function StrategyChart({
  current,
  entry,
  takeProfit,
  stopLoss,
  symbol,
}: {
  current?: string;
  entry?: string;
  takeProfit?: string;
  stopLoss?: string;
  symbol: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setW(Math.max(320, Math.round(e!.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const levels: Level[] = [];
  if (takeProfit)
    levels.push({
      label: "Take profit",
      price: Number(takeProfit),
      kind: "tp",
    });
  if (current)
    levels.push({ label: "Current", price: Number(current), kind: "current" });
  if (entry)
    levels.push({ label: "Est. entry", price: Number(entry), kind: "entry" });
  if (stopLoss)
    levels.push({ label: "Stop loss", price: Number(stopLoss), kind: "sl" });
  const valid = levels.filter((l) => Number.isFinite(l.price));
  if (valid.length < 2)
    return (
      <div className="intent-chart-empty">
        Price levels appear once the strategy is valid.
      </div>
    );

  const prices = valid.map((l) => l.price);
  const hi = Math.max(...prices),
    lo = Math.min(...prices),
    span = hi - lo || 1;
  const x1 = LABEL_W + GAP,
    x2 = W - PRICE_W - GAP;
  const y = (p: number) => PAD_Y + (1 - (p - lo) / span) * (H - 2 * PAD_Y);
  const labelY = spread(
    valid.map((l) => y(l.price)),
    MIN_LABEL_GAP,
    PAD_Y - 6,
    H - PAD_Y + 6,
  );
  const band = (from: number, to: number, fill: string, opacity: number) => (
    <rect
      x={x1}
      width={Math.max(0, x2 - x1)}
      y={Math.min(y(from), y(to))}
      height={Math.max(2, Math.abs(y(from) - y(to)))}
      fill={fill}
      opacity={opacity}
      rx="4"
    />
  );
  const e = entry ? Number(entry) : null;

  return (
    <div className="intent-chart" ref={ref}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${symbol} strategy price levels`}
      >
        {takeProfit &&
          e != null &&
          band(Number(takeProfit), e, "var(--green)", 0.08)}
        {stopLoss && e != null && band(e, Number(stopLoss), "var(--red)", 0.08)}
        {current && e != null && band(Number(current), e, "#d6c27a", 0.18)}
        {valid.map((l, i) => {
          const ly = y(l.price),
            ty = labelY[i]!;
          return (
            <g key={l.kind}>
              <line
                x1={x1}
                x2={x2}
                y1={ly}
                y2={ly}
                stroke={COLOR[l.kind]}
                strokeWidth={l.kind === "current" ? 2 : 1.5}
                strokeDasharray={l.kind === "current" ? undefined : "6 5"}
              />
              {/* Leader ticks when a label was nudged off its line. */}
              {Math.abs(ty - ly) > 1 && (
                <>
                  <line
                    x1={x1 - GAP + 2}
                    x2={x1}
                    y1={ty}
                    y2={ly}
                    stroke={COLOR[l.kind]}
                    strokeWidth="1"
                    opacity="0.6"
                  />
                  <line
                    x1={x2}
                    x2={x2 + GAP - 2}
                    y1={ly}
                    y2={ty}
                    stroke={COLOR[l.kind]}
                    strokeWidth="1"
                    opacity="0.6"
                  />
                </>
              )}
              <text
                x={LABEL_W}
                y={ty}
                dy="0.35em"
                textAnchor="end"
                fill={COLOR[l.kind]}
                fontSize="13"
                fontWeight="600"
              >
                {l.label}
              </text>
              <text
                x={W - PRICE_W}
                y={ty}
                dy="0.35em"
                fill="var(--text)"
                fontSize="13"
                fontWeight="600"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                ${num(String(l.price), 2)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
