"use client";
import { num } from "@/lib/intent/client";

interface Level {
  label: string;
  price: number;
  kind: "current" | "entry" | "tp" | "sl";
}
/**
 * Price-level ladder: current price, estimated entry, take-profit and stop-loss on one vertical scale.
 * Levels come from the server simulation; nothing here is computed from a forecast.
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
  const prices = levels.map((l) => l.price).filter(Number.isFinite);
  if (prices.length < 2)
    return (
      <div className="intent-chart-empty">
        Price levels appear once the strategy is valid.
      </div>
    );
  const hi = Math.max(...prices),
    lo = Math.min(...prices),
    span = hi - lo || 1;
  const H = 230,
    W = 560,
    top = 24,
    bottom = 24;
  const y = (p: number) => top + (1 - (p - lo) / span) * (H - top - bottom);
  const zone =
    entry && current
      ? [
          y(Math.max(Number(entry), Number(current))),
          y(Math.min(Number(entry), Number(current))),
        ]
      : null;
  const color = {
    tp: "var(--green)",
    sl: "var(--red)",
    current: "var(--blue)",
    entry: "#d6c27a",
  } as const;
  return (
    <svg
      className="intent-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${symbol} strategy price levels`}
    >
      {takeProfit && entry && (
        <rect
          x="150"
          width="380"
          y={y(Number(takeProfit))}
          height={Math.max(0, y(Number(entry)) - y(Number(takeProfit)))}
          fill="var(--green)"
          opacity="0.08"
        />
      )}
      {stopLoss && entry && (
        <rect
          x="150"
          width="380"
          y={y(Number(entry))}
          height={Math.max(0, y(Number(stopLoss)) - y(Number(entry)))}
          fill="var(--red)"
          opacity="0.08"
        />
      )}
      {zone && (
        <rect
          x="150"
          width="380"
          y={zone[0]}
          height={Math.max(2, zone[1] - zone[0])}
          fill="#d6c27a"
          opacity="0.18"
        />
      )}
      {levels.map((l) => (
        <g key={l.kind}>
          <line
            x1="150"
            x2="530"
            y1={y(l.price)}
            y2={y(l.price)}
            stroke={color[l.kind]}
            strokeWidth="1.5"
            strokeDasharray={l.kind === "current" ? "0" : "5 4"}
          />
          <text
            x="142"
            y={y(l.price) + 4}
            textAnchor="end"
            fill={color[l.kind]}
            fontSize="12"
          >
            {l.label}
          </text>
          <text x="536" y={y(l.price) + 4} fill="var(--text)" fontSize="12">
            ${num(String(l.price), 2)}
          </text>
        </g>
      ))}
    </svg>
  );
}
