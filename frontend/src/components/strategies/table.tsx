"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, LayoutGrid, List, Star } from "lucide-react";
import {
  headlinePerformance,
  riskLevel,
  sameAddress,
  strategyCategory,
  strategyRating,
  type Strategy,
} from "@/lib/strategies";
import { StrategyIconBadge } from "./icon";
import { CreatorName, ModeBadge, Ret, VisibilityBadge } from "./ui";

export type SortKey = "3M" | "6M" | "1Y" | "rating" | "aum" | "clones" | "new";
export interface SortState {
  key: SortKey;
  dir: "desc" | "asc";
}
export type ViewMode = "list" | "grid";

/** Sort strategies by a return period, rating, deployed funds, clones or age. */
export function sortStrategies(list: Strategy[], sort: SortState) {
  const value = (s: Strategy): number => {
    const perf = headlinePerformance(s);
    switch (sort.key) {
      case "rating":
        return strategyRating(perf) ?? -1;
      case "aum":
        return s.stats.aum;
      case "clones":
        return s.stats.clones;
      case "new":
        return new Date(s.createdAt).getTime();
      default:
        return perf?.returns[sort.key] ?? -Infinity;
    }
  };
  const sign = sort.dir === "desc" ? -1 : 1;
  return list
    .map((s) => ({ s, v: value(s) }))
    .sort((a, b) =>
      a.v === b.v
        ? 0
        : a.v === -Infinity
          ? 1
          : b.v === -Infinity
            ? -1
            : sign * (a.v - b.v),
    )
    .map((x) => x.s);
}

export function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="view-toggle" role="radiogroup" aria-label="View">
      <button
        type="button"
        role="radio"
        aria-checked={view === "list"}
        className={view === "list" ? "active" : ""}
        onClick={() => onChange("list")}
      >
        <List size={16} /> List
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={view === "grid"}
        className={view === "grid" ? "active" : ""}
        onClick={() => onChange("grid")}
      >
        <LayoutGrid size={16} /> Cards
      </button>
    </div>
  );
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  align = "right",
}: {
  label: string;
  k: SortKey;
  sort: SortState;
  onSort: (s: SortState) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === k;
  return (
    <th
      className={align === "right" ? "num" : ""}
      aria-sort={
        active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"
      }
    >
      <button
        type="button"
        className={`sort-header ${active ? "active" : ""}`}
        onClick={() =>
          onSort({
            key: k,
            dir: active && sort.dir === "desc" ? "asc" : "desc",
          })
        }
      >
        {label}
        {active && sort.dir === "asc" ? (
          <ChevronUp size={15} />
        ) : (
          <ChevronDown size={15} />
        )}
      </button>
    </th>
  );
}

export function StrategyTable({
  rows,
  sort,
  onSort,
  account,
  showVisibility = false,
}: {
  rows: Strategy[];
  sort: SortState;
  onSort: (s: SortState) => void;
  account?: string;
  showVisibility?: boolean;
}) {
  const router = useRouter();
  return (
    <div className="panel fund-table-wrap">
      <table className="fund-table">
        <thead>
          <tr>
            <th className="icon-col" aria-label="Icon" />
            <th>
              Strategy name{" "}
              <span className="muted">
                ({rows.length} result{rows.length === 1 ? "" : "s"})
              </span>
            </th>
            <th>Category</th>
            <SortHeader label="3M" k="3M" sort={sort} onSort={onSort} />
            <SortHeader label="6M" k="6M" sort={sort} onSort={onSort} />
            <SortHeader label="1Y" k="1Y" sort={sort} onSort={onSort} />
            <SortHeader label="Rating" k="rating" sort={sort} onSort={onSort} />
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const perf = headlinePerformance(s);
            const rating = strategyRating(perf);
            const cat = strategyCategory(s);
            const risk = riskLevel(s);
            const mine = sameAddress(s.creator.address, account);
            return (
              <tr
                key={s.id}
                onClick={(e) => {
                  if (
                    (e.target as HTMLElement).closest('a,button,[role="link"]')
                  )
                    return;
                  router.push(`/strategies/${s.id}`);
                }}
              >
                <td className="icon-col">
                  <StrategyIconBadge icon={s.icon} size={44} />
                </td>
                <td className="name-col">
                  <Link href={`/strategies/${s.id}`}>{s.name}</Link>
                  <span className="fund-sub">
                    <CreatorName
                      name={s.creator.name}
                      address={s.creator.address}
                      you={mine}
                    />
                    {perf ? (
                      <ModeBadge mode={perf.mode} />
                    ) : (
                      <span className="strategy-mode none">Not run yet</span>
                    )}
                    {showVisibility && (
                      <VisibilityBadge visibility={s.visibility} />
                    )}
                  </span>
                </td>
                <td className="category-col">
                  {cat.group}
                  <small>{cat.style}</small>
                </td>
                <td className="num">
                  <Ret v={perf?.returns["3M"]} />
                </td>
                <td className="num">
                  <Ret v={perf?.returns["6M"]} />
                </td>
                <td className="num">
                  <Ret v={perf?.returns["1Y"]} />
                </td>
                <td className="num rating">
                  {rating ? (
                    <>
                      {rating}
                      <Star size={15} fill="currentColor" />
                    </>
                  ) : (
                    <span className="muted">--</span>
                  )}
                </td>
                <td>
                  <span
                    className={`risk-level ${risk.replace(" ", "-").toLowerCase()}`}
                  >
                    {risk}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
