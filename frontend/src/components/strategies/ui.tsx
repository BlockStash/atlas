"use client";
import { useId } from "react";
import Link from "next/link";
import { AtSign, Copy, Eye, GitFork, Globe2, Lock, Users } from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import {
  MARKET_FLAG,
  MARKET_LABEL,
  PERIODS,
  compact,
  headlinePerformance,
  pct,
  useStrategies,
  type Market,
  type Performance,
  type RunMode,
  type Strategy,
} from "@/lib/strategies";

/** Strategy store bound to the connected wallet and its linked ENS name. */
export function useStrategyStore() {
  const { wallet, state } = useAtlas();
  return useStrategies(wallet?.address, state.ensName);
}

export const MODE_LABEL: Record<RunMode, string> = {
  backtest: "Backtest",
  paper: "Paper trade",
  live: "Live",
};

export function EquityChart({
  curve,
  height = 160,
  compactMode = false,
}: {
  curve: number[];
  height?: number;
  compactMode?: boolean;
}) {
  const width = 600;
  const gid = useId().replace(/:/g, "");
  if (curve.length < 2)
    return (
      <div className="strategy-chart-empty" style={{ height }}>
        Collecting data — check back after the first trading day.
      </div>
    );
  const step = Math.max(1, Math.floor(curve.length / 160));
  const pts = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
  const min = Math.min(...pts),
    max = Math.max(...pts),
    span = max - min || 1;
  const xy = pts.map(
    (v, i) =>
      [
        (i / (pts.length - 1)) * width,
        height - 6 - ((v - min) / span) * (height - 12),
      ] as const,
  );
  const line = xy
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join("");
  const up = pts[pts.length - 1] >= pts[0];
  const color = up ? "var(--green)" : "var(--red)";
  return (
    <svg
      className={`strategy-chart ${compactMode ? "compact" : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      role="img"
      aria-label={`Equity curve, ${up ? "up" : "down"} ${(((pts[pts.length - 1] - pts[0]) / pts[0]) * 100).toFixed(1)}%`}
    >
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${line}L${width},${height}L0,${height}Z`}
        fill={`url(#${gid})`}
      />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={compactMode ? 1.6 : 2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function Ret({ v }: { v: number | null | undefined }) {
  return (
    <span className={v == null ? "muted" : v >= 0 ? "positive" : "negative"}>
      {pct(v)}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: RunMode }) {
  return <span className={`strategy-mode ${mode}`}>{MODE_LABEL[mode]}</span>;
}

export function VisibilityBadge({
  visibility,
}: {
  visibility: Strategy["visibility"];
}) {
  return (
    <span className={`strategy-visibility ${visibility}`}>
      {visibility === "public" ? <Globe2 size={12} /> : <Lock size={12} />}
      {visibility === "public" ? "Public" : "Private"}
    </span>
  );
}

/** ENS subname that identifies a strategy, e.g. global-ai-leaders.meera.eth. */
export function EnsHandle({ ens }: { ens: string | null }) {
  if (!ens) return null;
  return (
    <span className="strategy-ens" title={`${ens} · ENS subname (demo)`}>
      <AtSign size={12} />
      {ens}
    </span>
  );
}

export function MarketChips({ markets }: { markets: Market[] }) {
  return (
    <div className="strategy-markets">
      {[...new Set(markets)].map((m) => (
        <span key={m} title={MARKET_LABEL[m]}>
          {MARKET_FLAG[m]}{" "}
          {m === "usa" ? "US" : m === "uk" ? "UK" : MARKET_LABEL[m]}
        </span>
      ))}
    </div>
  );
}

export function ReturnsRow({ perf }: { perf: Performance | null }) {
  return (
    <dl className="strategy-returns">
      {PERIODS.map((p) => (
        <div key={p}>
          <dt>{p}</dt>
          <dd>
            <Ret v={perf?.returns[p]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const assetColor = (i: number) =>
  `hsl(${(218 + i * 47) % 360} 65% ${64 - (i % 3) * 7}%)`;

export function AllocationBar({
  universe,
}: {
  universe: Strategy["spec"]["universe"];
}) {
  return (
    <div className="strategy-stack" aria-label="Allocation">
      {universe.map((a, i) => (
        <i
          key={a.symbol}
          title={`${a.symbol} ${a.weight}%`}
          style={{ width: `${a.weight}%`, background: assetColor(i) }}
        />
      ))}
    </div>
  );
}

export function StrategyCard({
  s,
  mine,
  onClone,
}: {
  s: Strategy;
  mine: boolean;
  onClone?: () => void;
}) {
  const perf = headlinePerformance(s);
  return (
    <article className="panel strategy-card">
      <Link href={`/strategies/${s.id}`} className="strategy-card-link">
        <header>
          <div>
            <h3>{s.name}</h3>
            <EnsHandle ens={s.ens} />
            <p>
              by <strong>{mine ? "you" : s.creator.name}</strong>
              {s.forkedFrom && (
                <>
                  {" "}
                  · <GitFork size={11} /> {s.forkedFrom.name}
                </>
              )}
            </p>
          </div>
          {mine && <VisibilityBadge visibility={s.visibility} />}
        </header>
        <MarketChips markets={s.spec.universe.map((a) => a.market)} />
        <EquityChart curve={perf?.curve ?? []} height={70} compactMode />
        <div className="strategy-card-meta">
          {perf ? (
            <ModeBadge mode={perf.mode} />
          ) : (
            <span className="strategy-mode none">Not run yet</span>
          )}
          <span className="capitalize">{s.spec.riskProfile} risk</span>
        </div>
        <ReturnsRow perf={perf} />
      </Link>
      <footer>
        <span title="Funds deployed by other users">
          <Users size={13} /> {compact(s.stats.aum)} aUSDT
        </span>
        <span title="Clones">
          <GitFork size={13} /> {s.stats.clones}
        </span>
        <Link className="text-button" href={`/strategies/${s.id}`}>
          <Eye size={14} /> View
        </Link>
        {onClone && (
          <button className="text-button" onClick={onClone}>
            <Copy size={14} /> Clone
          </button>
        )}
      </footer>
    </article>
  );
}
