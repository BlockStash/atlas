"use client";
import { useState } from "react";
import Link from "next/link";
import {
  AtSign,
  Compass,
  FlaskConical,
  GitFork,
  Layers,
  Rocket,
  RotateCcw,
  Wand2,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { DashboardShell } from "@/components/dashboard/shell";
import { Metric } from "@/components/protocol/shared";
import {
  CREATOR_FEE_BPS,
  isEns,
  pct,
  positionPerformance,
  usd,
} from "@/lib/strategies";
import { Ret, StrategyCard, useStrategyStore } from "./ui";
import {
  StrategyTable,
  ViewToggle,
  sortStrategies,
  type SortState,
  type ViewMode,
} from "./table";
import { StrategyIconBadge } from "./icon";

type Filter = "all" | "public" | "private" | "forks";

export function MyStrategiesPage() {
  const { toast, state, wallet } = useAtlas();
  const store = useStrategyStore();
  const [filter, setFilter] = useState<Filter>("all"),
    [view, setView] = useState<ViewMode>("list"),
    [sort, setSort] = useState<SortState>({ key: "new", dir: "desc" });

  const positions = store.positions.map((p) => {
    const s = store.get(p.strategyId);
    return { p, s, perf: s ? positionPerformance(s, p) : null };
  });
  const live = positions.filter((x) => x.p.mode === "live");
  const paper = positions.filter((x) => x.p.mode === "paper");
  const sum = (xs: typeof positions) =>
    xs.reduce((t, x) => t + (x.perf?.value ?? x.p.capital), 0);
  const cost = (xs: typeof positions) =>
    xs.reduce((t, x) => t + x.p.capital, 0);
  const earnings = store.mine
    .filter((s) => !s.forkedFrom)
    .reduce((t, s) => t + s.stats.creatorEarnings, 0);
  const feesPaid = positions.reduce((t, x) => t + x.p.creatorFee, 0);

  const list = sortStrategies(
    store.mine.filter((s) =>
      filter === "all"
        ? true
        : filter === "forks"
          ? !!s.forkedFrom
          : s.visibility === filter,
    ),
    sort,
  );
  const hasEns = isEns(state.ensName);

  return (
    <DashboardShell>
      <main className="protocol-content strategies-page">
        <div className="section-heading">
          <div>
            <span className="eyebrow">
              <Layers size={13} /> YOUR WORKSPACE
            </span>
            <h1>My strategies</h1>
            <p>
              Everything you have built, cloned, paper traded and deployed.
              Strategies stay private until you publish them.
            </p>
          </div>
          <div className="strategy-head-actions">
            <Link className="btn secondary small" href="/strategies">
              <Compass size={15} /> Explore
            </Link>
            <Link className="btn primary small" href="/strategies/new">
              <Wand2 size={15} /> Create with Atlas AI
            </Link>
          </div>
        </div>

        <div className={`panel strategy-ens-callout ${hasEns ? "linked" : ""}`}>
          <AtSign size={20} />
          {hasEns ? (
            <div>
              <strong>
                Strategies are published under{" "}
                <span className="ens-chip">
                  <AtSign size={12} />
                  {state.ensName}
                </span>
              </strong>
              <span>
                Each strategy gets a subname such as{" "}
                <span className="ens-chip handle">
                  global-growth.{state.ensName}
                </span>{" "}
                so others can find and verify it.
              </span>
            </div>
          ) : (
            <div>
              <strong>Link an ENS name to brand your strategies</strong>
              <span>
                With ENS, each strategy gets a subname like{" "}
                <code>global-growth.you.eth</code> instead of a bare address.
              </span>
            </div>
          )}
          {!hasEns && (
            <Link className="btn secondary small" href="/wallet">
              Link ENS
            </Link>
          )}
        </div>

        <div className="protocol-metrics">
          <Metric
            label="LIVE VALUE"
            value={`${usd(sum(live))} aUSDT`}
            note={`${live.length} live · ${pct(cost(live) ? sum(live) / cost(live) - 1 : 0, 2)} overall`}
          />
          <Metric
            label="PAPER VALUE"
            value={`${usd(sum(paper))} aUSDT`}
            note={`${paper.length} paper trade${paper.length === 1 ? "" : "s"} · virtual funds`}
          />
          <Metric
            label="CREATOR EARNINGS"
            value={`${usd(earnings)} aUSDT`}
            note={`${CREATOR_FEE_BPS / 100}% of what others deploy into your originals and their clones`}
          />
          <Metric
            label="CREATOR FEES PAID"
            value={`${usd(feesPaid)} aUSDT`}
            note="Paid to original creators when you deployed"
          />
        </div>

        <section className="panel strategy-positions">
          <div className="strategy-perf-head">
            <h2>Running now</h2>
            <span className="muted">
              {positions.length} position{positions.length === 1 ? "" : "s"}
            </span>
          </div>
          {positions.length ? (
            <div className="strategy-table-wrap">
              <table className="strategy-table positions-table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Mode</th>
                    <th>Started</th>
                    <th className="num">Capital</th>
                    <th className="num">Current value</th>
                    <th className="num">Return</th>
                    <th className="num">Creator fee</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map(({ p, s, perf }) => (
                    <tr key={p.id}>
                      <td>
                        <div className="position-name">
                          {s && <StrategyIconBadge icon={s.icon} size={40} />}
                          <div>
                            <Link href={`/strategies/${p.strategyId}`}>
                              {s?.name ?? "Removed strategy"}
                            </Link>
                            {s?.ens && <small>{s.ens}</small>}
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`strategy-mode ${p.mode}`}>
                          {p.mode === "live" ? "Live" : "Paper"}
                        </span>
                      </td>
                      <td>
                        {new Date(p.startedAt).toLocaleDateString(undefined, {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td className="num">
                        {usd(p.capital)} <small>aUSDT</small>
                      </td>
                      <td className="num">
                        {usd(perf?.value ?? p.capital)} <small>aUSDT</small>
                      </td>
                      <td className="num">
                        <Ret v={perf?.totalReturn ?? 0} />
                      </td>
                      <td className="num">
                        {p.creatorFee ? (
                          <>
                            {usd(p.creatorFee)} <small>aUSDT</small>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="strategy-steps">
              <div>
                <Wand2 size={18} />
                <strong>1. Describe</strong>
                <span>Tell Atlas AI your idea in plain English.</span>
              </div>
              <div>
                <FlaskConical size={18} />
                <strong>2. Test</strong>
                <span>Backtest a year, then paper trade it forward.</span>
              </div>
              <div>
                <Rocket size={18} />
                <strong>3. Deploy</strong>
                <span>Put real aUSDT to work from your vault.</span>
              </div>
            </div>
          )}
        </section>

        <div className="strategy-toolbar">
          <h2 className="strategy-section-title">Your strategies</h2>
          <div className="strategy-chips">
            {(
              [
                ["all", `All · ${store.mine.length}`],
                ["public", "Public"],
                ["private", "Private"],
                ["forks", "Clones"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={filter === id ? "active" : ""}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <ViewToggle view={view} onChange={setView} />
        </div>

        {list.length ? (
          view === "list" ? (
            <StrategyTable
              rows={list}
              sort={sort}
              onSort={setSort}
              account={wallet?.address}
              showVisibility
            />
          ) : (
            <div className="strategy-grid">
              {list.map((s) => (
                <StrategyCard key={s.id} s={s} mine />
              ))}
            </div>
          )
        ) : (
          <div className="panel protocol-empty">
            <Wand2 />
            <h2>
              {store.mine.length
                ? "Nothing in this filter"
                : "No strategies yet"}
            </h2>
            <p>
              Describe an idea to Atlas AI, such as “Buy Indian bank stocks on
              10% dips, rebalance monthly, 8% stop loss”, or clone a public
              strategy and make it yours.
            </p>
            <div className="strategy-empty-actions">
              <Link className="btn primary small" href="/strategies/new">
                <Wand2 size={15} /> Create with Atlas AI
              </Link>
              <Link className="btn secondary small" href="/strategies">
                <GitFork size={14} /> Browse to clone
              </Link>
            </div>
          </div>
        )}

        <p className="strategy-disclaimer">
          Demo workspace: data lives in this browser until the strategy backend
          ships.{" "}
          <button
            className="text-button"
            onClick={() => {
              store.resetDemo().then(
                () => toast("Strategy demo data reset."),
                (e: Error) => toast(e.message),
              );
            }}
          >
            <RotateCcw size={12} /> Reset demo data
          </button>
        </p>
      </main>
    </DashboardShell>
  );
}
