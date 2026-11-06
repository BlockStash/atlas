"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpDown,
  ArrowUpRight,
  ChevronDown,
  Coins,
  Crown,
  GitFork,
  Pin,
  PinOff,
  Search,
  Sparkles,
  TrendingUp,
  Star,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { DashboardShell } from "@/components/dashboard/shell";
import {
  CREATOR_FEE_BPS,
  compact,
  headlinePerformance,
  riskLevel,
  sameAddress,
  strategyCategory,
  strategyRating,
  usd,
  type RiskLevel,
  type Strategy,
} from "@/lib/strategies";
import {
  StrategyTable,
  ViewToggle,
  sortStrategies,
  type SortKey,
  type SortState,
  type ViewMode,
} from "./table";
import { StrategyIconBadge } from "./icon";
import {
  EnsHandle,
  EquityChart,
  MarketChips,
  CreatorName,
  ModeBadge,
  ReturnsRow,
  StrategyCard,
  useStrategyStore,
} from "./ui";

type Quick = "live" | "global" | "momentum" | "income" | "4star";
const QUICK: {
  id: Quick;
  label: React.ReactNode;
  test: (s: Strategy) => boolean;
}[] = [
  { id: "live", label: "Live track record", test: (s) => !!s.runs.live },
  {
    id: "global",
    label: "Global",
    test: (s) => new Set(s.spec.universe.map((a) => a.market)).size >= 3,
  },
  {
    id: "momentum",
    label: "Momentum",
    test: (s) => strategyCategory(s).style === "Momentum",
  },
  {
    id: "income",
    label: "Income",
    test: (s) => strategyCategory(s).style === "Income",
  },
  {
    id: "4star",
    label: (
      <>
        4+ <Star size={13} fill="currentColor" />
      </>
    ),
    test: (s) => (strategyRating(headlinePerformance(s)) ?? 0) >= 4,
  },
];
const RISKS: RiskLevel[] = ["Low", "Moderate", "High", "Very High"];
const SORT_LABEL: Record<SortKey, string> = {
  "1Y": "Top 1Y return",
  "6M": "Top 6M return",
  "3M": "Top 3M return",
  rating: "Highest rated",
  aum: "Most deployed",
  clones: "Most cloned",
  new: "Newest",
};

type Highlight = "spotlight" | "creators";
const PIN_KEY = "atlas_explore_pins_v1";
const HIGHLIGHT_LABEL: Record<Highlight, string> = {
  spotlight: "Most deployed",
  creators: "Top creators",
};

/** Which highlight cards are pinned to the top of Explore. Remembered per browser. */
function loadPins(): Record<Highlight, boolean> {
  const all = { spotlight: true, creators: true };
  try {
    const saved = JSON.parse(localStorage.getItem(PIN_KEY) ?? "null");
    if (saved && typeof saved === "object")
      return {
        spotlight: saved.spotlight !== false,
        creators: saved.creators !== false,
      };
  } catch {
    // Storage blocked or unreadable: show everything.
  }
  return all;
}

function PinButton({
  pinned,
  label,
  onToggle,
}: {
  pinned: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`pin-button ${pinned ? "pinned" : ""}`}
      aria-pressed={pinned}
      title={pinned ? `Unpin ${label}` : `Pin ${label}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
    >
      {pinned ? <PinOff size={15} /> : <Pin size={15} />}
      <span>{pinned ? "Unpin" : "Pin"}</span>
    </button>
  );
}

export function ExploreStrategiesPage() {
  const { wallet, toast } = useAtlas();
  const router = useRouter();
  const store = useStrategyStore();
  const searchRef = useRef<HTMLInputElement>(null);
  const initialQuery = useSearchParams().get("q") ?? "";
  const [query, setQuery] = useState(initialQuery),
    [group, setGroup] = useState("all"),
    [risk, setRisk] = useState<RiskLevel | "all">("all"),
    [minRating, setMinRating] = useState(0),
    [creator, setCreator] = useState("all"),
    [quick, setQuick] = useState<Set<Quick>>(new Set()),
    [sort, setSort] = useState<SortState>({ key: "1Y", dir: "desc" }),
    [view, setView] = useState<ViewMode>("list"),
    [pins, setPins] = useState<Record<Highlight, boolean>>(() =>
      typeof window === "undefined"
        ? { spotlight: true, creators: true }
        : loadPins(),
    );
  function togglePin(h: Highlight) {
    setPins((p) => {
      const next = { ...p, [h]: !p[h] };
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify(next));
      } catch {
        // Not persisted; still applies for this visit.
      }
      return next;
    });
  }
  const unpinned = (Object.keys(pins) as Highlight[]).filter((h) => !pins[h]);

  // "/" focuses search (unless already typing); Escape clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const ranked = useMemo(
    () => store.explore.map((s) => ({ s, perf: headlinePerformance(s) })),
    [store.explore],
  );
  const groups = useMemo(
    () =>
      [...new Set(store.explore.map((s) => strategyCategory(s).group))].sort(),
    [store.explore],
  );
  const creatorNames = useMemo(
    () => [...new Set(store.explore.map((s) => s.creator.name))].sort(),
    [store.explore],
  );

  const list = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const quickTests = QUICK.filter((q) => quick.has(q.id)).map((q) => q.test);
    const filtered = store.explore.filter((s) => {
      const cat = strategyCategory(s);
      if (group !== "all" && cat.group !== group) return false;
      if (risk !== "all" && riskLevel(s) !== risk) return false;
      if (
        minRating &&
        (strategyRating(headlinePerformance(s)) ?? 0) < minRating
      )
        return false;
      if (creator !== "all" && s.creator.name !== creator) return false;
      if (!quickTests.every((t) => t(s))) return false;
      if (!terms.length) return true;
      // Every word must match somewhere: name, ENS, creator, tickers, markets, category or prompt.
      const haystack = [
        s.name,
        s.ens ?? "",
        s.creator.name,
        s.tagline,
        s.prompt,
        cat.group,
        cat.style,
        s.spec.riskProfile,
        ...s.spec.universe.flatMap((a) => [a.symbol, a.name, a.market]),
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
    return sortStrategies(filtered, sort);
  }, [store.explore, query, group, risk, minRating, creator, quick, sort]);

  const activeFilters =
    (group !== "all" ? 1 : 0) +
    (risk !== "all" ? 1 : 0) +
    (minRating ? 1 : 0) +
    (creator !== "all" ? 1 : 0) +
    quick.size;
  function clearAll() {
    setQuery("");
    setGroup("all");
    setRisk("all");
    setMinRating(0);
    setCreator("all");
    setQuick(new Set());
  }
  function toggleQuick(id: Quick) {
    setQuick((q) => {
      const next = new Set(q);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const featured = [...ranked].sort((a, b) => b.s.stats.aum - a.s.stats.aum)[0];
  const creators = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        address: string;
        count: number;
        aum: number;
        earned: number;
      }
    >();
    for (const s of store.explore) {
      const key = s.creator.address.toLowerCase();
      const row = map.get(key) ?? {
        name: s.creator.name,
        address: s.creator.address,
        count: 0,
        aum: 0,
        earned: 0,
      };
      row.count++;
      row.aum += s.stats.aum;
      row.earned += s.stats.creatorEarnings;
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => b.earned - a.earned).slice(0, 5);
  }, [store.explore]);

  const totalAum = store.explore.reduce((t, s) => t + s.stats.aum, 0);
  const totalClones = store.explore.reduce((t, s) => t + s.stats.clones, 0);

  async function clone(id: string) {
    try {
      const copy = await store.clone(id);
      toast(
        "Cloned into My strategies. Tweak it with Atlas AI, then backtest.",
      );
      router.push(`/strategies/${copy.id}?edit=1`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not clone this strategy.");
    }
  }

  return (
    <DashboardShell>
      <main className="protocol-content strategies-page">
        {store.error && (
          <p className="paper-error" role="alert">
            Couldn’t load the marketplace: {store.error}
          </p>
        )}
        <section className="strategy-hero">
          <div>
            <span className="eyebrow">
              <Sparkles size={13} /> STRATEGY MARKETPLACE
            </span>
            <h1>Explore strategies</h1>
            <p>
              Discover strategies published by the Atlas community, each with
              its own ENS name. Clone one like a repo, tweak it with AI, or
              deploy it as-is. Creators earn {CREATOR_FEE_BPS / 100}% of every
              deployment.
            </p>
            <div className="strategy-hero-actions">
              <Link className="btn primary" href="/strategies/new">
                <Wand2 size={16} /> Create with Atlas AI
              </Link>
              <Link className="btn secondary" href="/strategies/mine">
                My strategies <ArrowUpRight size={15} />
              </Link>
            </div>
          </div>
          <dl className="strategy-hero-stats">
            <div>
              <dt>Public strategies</dt>
              <dd>{store.explore.length}</dd>
            </div>
            <div>
              <dt>Deployed by users</dt>
              <dd>{compact(totalAum)} aUSDT</dd>
            </div>
            <div>
              <dt>Total clones</dt>
              <dd>{compact(totalClones)}</dd>
            </div>
          </dl>
        </section>

        {unpinned.length > 0 && (
          <div className="pinned-bar">
            <Pin size={15} />
            <span>Unpinned:</span>
            {unpinned.map((h) => (
              <button
                key={h}
                type="button"
                className="pinned-bar-chip"
                onClick={() => togglePin(h)}
                title={`Pin ${HIGHLIGHT_LABEL[h]} back to the top`}
              >
                {HIGHLIGHT_LABEL[h]} <Pin size={13} />
              </button>
            ))}
          </div>
        )}
        {featured && (pins.spotlight || pins.creators) && (
          <div
            className={`strategy-spotlight-row ${pins.spotlight && pins.creators ? "" : "single"}`}
          >
            {pins.spotlight && (
              <Link
                href={`/strategies/${featured.s.id}`}
                className="panel strategy-spotlight"
              >
                <div className="strategy-spotlight-head">
                  <span className="eyebrow">
                    <Crown size={13} /> MOST DEPLOYED
                  </span>
                  <span className="strategy-spotlight-actions">
                    {featured.perf && <ModeBadge mode={featured.perf.mode} />}
                    <PinButton
                      pinned
                      label="Most deployed"
                      onToggle={() => togglePin("spotlight")}
                    />
                  </span>
                </div>
                <div className="strategy-title-row">
                  <StrategyIconBadge icon={featured.s.icon} size={52} />
                  <h2>{featured.s.name}</h2>
                </div>
                <div className="strategy-spotlight-by">
                  <EnsHandle ens={featured.s.ens} />
                  <span>
                    by{" "}
                    <CreatorName
                      name={featured.s.creator.name}
                      address={featured.s.creator.address}
                    />
                  </span>
                </div>
                <p>{featured.s.prompt}</p>
                <MarketChips
                  markets={featured.s.spec.universe.map((a) => a.market)}
                />
                <EquityChart curve={featured.perf?.curve ?? []} height={120} />
                <ReturnsRow perf={featured.perf} />
                <div className="strategy-spotlight-foot">
                  <span>
                    <Users size={14} /> {featured.s.stats.deployers} deployers
                  </span>
                  <span>
                    <Coins size={14} /> {compact(featured.s.stats.aum)} aUSDT
                  </span>
                  <span>
                    <GitFork size={14} /> {featured.s.stats.clones} clones
                  </span>
                </div>
              </Link>
            )}
            {pins.creators && (
              <aside className="panel strategy-creators">
                <div className="strategy-creators-head">
                  <h2>
                    <TrendingUp size={18} /> Top creators
                  </h2>
                  <PinButton
                    pinned
                    label="Top creators"
                    onToggle={() => togglePin("creators")}
                  />
                </div>
                <p>Ranked by creator earnings from deployments.</p>
                <ol>
                  {creators.map((c, i) => (
                    <li key={c.address}>
                      <span className="strategy-rank">{i + 1}</span>
                      <span className="strategy-creator-avatar">
                        {c.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <CreatorName name={c.name} address={c.address} />
                        <small>
                          {c.count} strateg{c.count === 1 ? "y" : "ies"} ·{" "}
                          {compact(c.aum)} deployed
                        </small>
                      </div>
                      <b>{usd(c.earned, 0)}</b>
                    </li>
                  ))}
                </ol>
              </aside>
            )}
          </div>
        )}

        <section className="strategy-browse" aria-label="All strategies">
          <div className="strategy-browse-head">
            <h2>All strategies</h2>
            <ViewToggle view={view} onChange={setView} />
          </div>

          <div className="strategy-searchbar">
            <Search size={19} className="strategy-searchbar-icon" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  e.currentTarget.blur();
                }
              }}
              placeholder="Search by strategy, ENS name, creator, ticker or market"
              aria-label="Search strategies"
              autoComplete="off"
              spellCheck={false}
            />
            {query ? (
              <button
                type="button"
                className="strategy-searchbar-clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                <X size={16} />
              </button>
            ) : (
              <kbd aria-hidden>/</kbd>
            )}
            <span className="strategy-searchbar-divider" aria-hidden />
            <label className="strategy-searchbar-sort">
              <ArrowUpDown size={15} />
              <span className="sr-only">Sort by</span>
              <select
                value={`${sort.key}:${sort.dir}`}
                onChange={(e) => {
                  const [key, dir] = e.target.value.split(":") as [
                    SortKey,
                    SortState["dir"],
                  ];
                  setSort({ key, dir });
                }}
              >
                {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                  <option key={k} value={`${k}:desc`}>
                    {SORT_LABEL[k]}
                  </option>
                ))}
                {sort.dir === "asc" && (
                  <option value={`${sort.key}:asc`}>
                    {SORT_LABEL[sort.key]} (lowest first)
                  </option>
                )}
              </select>
            </label>
          </div>

          <div className="strategy-filter-row">
            <label className={`filter-pill ${group !== "all" ? "set" : ""}`}>
              <span className="sr-only">Category</span>
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="all">Categories</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </label>
            <label className={`filter-pill ${risk !== "all" ? "set" : ""}`}>
              <span className="sr-only">Risk</span>
              <select
                value={risk}
                onChange={(e) => setRisk(e.target.value as RiskLevel | "all")}
              >
                <option value="all">Risk</option>
                {RISKS.map((r) => (
                  <option key={r} value={r}>
                    {r} risk
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </label>
            <label className={`filter-pill ${minRating ? "set" : ""}`}>
              <span className="sr-only">Rating</span>
              <select
                value={minRating}
                onChange={(e) => setMinRating(Number(e.target.value))}
              >
                <option value={0}>Ratings</option>
                <option value={3}>3★ & above</option>
                <option value={4}>4★ & above</option>
                <option value={5}>5★ only</option>
              </select>
              <ChevronDown size={15} />
            </label>
            <label className={`filter-pill ${creator !== "all" ? "set" : ""}`}>
              <span className="sr-only">Creator</span>
              <select
                value={creator}
                onChange={(e) => setCreator(e.target.value)}
              >
                <option value="all">Creator</option>
                {creatorNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </label>
            <span className="strategy-filter-divider" aria-hidden />
            {QUICK.map((q) => (
              <button
                key={q.id}
                type="button"
                aria-pressed={quick.has(q.id)}
                className={`filter-chip ${quick.has(q.id) ? "active" : ""}`}
                onClick={() => toggleQuick(q.id)}
              >
                {q.label}
              </button>
            ))}
            <button
              type="button"
              className="strategy-clear-all"
              disabled={!activeFilters && !query}
              onClick={clearAll}
            >
              Clear all
              {activeFilters > 0 && <span>{activeFilters}</span>}
            </button>
          </div>

          {list.length ? (
            view === "list" ? (
              <StrategyTable
                rows={list}
                sort={sort}
                onSort={setSort}
                account={wallet?.address}
              />
            ) : (
              <div className="strategy-grid">
                {list.map((s) => {
                  const mine = sameAddress(s.creator.address, wallet?.address);
                  return (
                    <StrategyCard
                      key={s.id}
                      s={s}
                      mine={mine}
                      onClone={mine ? undefined : () => clone(s.id)}
                    />
                  );
                })}
              </div>
            )
          ) : (
            <div className="panel protocol-empty">
              <Search />
              <h2>No strategies match</h2>
              <p>
                {query
                  ? `Nothing matches “${query}”${activeFilters ? " with the current filters" : ""}.`
                  : "No strategy matches these filters."}{" "}
                Try fewer filters, or create your own.
              </p>
              <div className="strategy-empty-actions">
                <button className="btn secondary small" onClick={clearAll}>
                  Clear all
                </button>
                <Link className="btn primary small" href="/strategies/new">
                  <Wand2 size={15} /> Create with Atlas AI
                </Link>
              </div>
            </div>
          )}
        </section>

        <p className="strategy-disclaimer">
          Demo marketplace: strategies, ENS handles, returns and deployments are
          simulated in your browser until the strategy backend ships. Simulated
          performance does not predict future results.
        </p>
      </main>
    </DashboardShell>
  );
}
