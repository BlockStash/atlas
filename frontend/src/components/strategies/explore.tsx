"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  AtSign,
  Coins,
  Crown,
  GitFork,
  Search,
  Sparkles,
  TrendingUp,
  Users,
  Wand2,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { DashboardShell } from "@/components/dashboard/shell";
import {
  CREATOR_FEE_BPS,
  compact,
  headlinePerformance,
  sameAddress,
  usd,
  type Strategy,
} from "@/lib/strategies";
import {
  EnsHandle,
  EquityChart,
  MarketChips,
  ModeBadge,
  ReturnsRow,
  StrategyCard,
  useStrategyStore,
} from "./ui";

type Sort = "1Y" | "6M" | "3M" | "aum" | "clones" | "new";

const CATEGORIES: {
  id: string;
  label: string;
  test: (s: Strategy) => boolean;
}[] = [
  { id: "all", label: "All", test: () => true },
  {
    id: "global",
    label: "🌐 Global",
    test: (s) => new Set(s.spec.universe.map((a) => a.market)).size >= 3,
  },
  {
    id: "crypto",
    label: "₿ Crypto",
    test: (s) => s.spec.universe.some((a) => a.market === "crypto"),
  },
  {
    id: "india",
    label: "🇮🇳 India",
    test: (s) => s.spec.universe.some((a) => a.market === "india"),
  },
  {
    id: "usa",
    label: "🇺🇸 US",
    test: (s) => s.spec.universe.some((a) => a.market === "usa"),
  },
  {
    id: "europe",
    label: "🇪🇺 Europe & UK",
    test: (s) =>
      s.spec.universe.some((a) => a.market === "europe" || a.market === "uk"),
  },
  {
    id: "income",
    label: "Income",
    test: (s) => s.spec.riskProfile === "conservative",
  },
  {
    id: "momentum",
    label: "Momentum",
    test: (s) => s.spec.rules.some((r) => r.when.indicator === "sma_cross"),
  },
  {
    id: "live",
    label: "Live track record",
    test: (s) => !!s.runs.live,
  },
];

export function ExploreStrategiesPage() {
  const { wallet, toast } = useAtlas();
  const router = useRouter();
  const store = useStrategyStore();
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("all"),
    [sort, setSort] = useState<Sort>("1Y");

  const ranked = useMemo(
    () => store.explore.map((s) => ({ s, perf: headlinePerformance(s) })),
    [store.explore],
  );

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const test = CATEGORIES.find((c) => c.id === category)!.test;
    return ranked
      .filter(
        ({ s }) =>
          test(s) &&
          (!q ||
            `${s.name} ${s.ens ?? ""} ${s.creator.name} ${s.prompt} ${s.spec.universe
              .map((a) => a.symbol)
              .join(" ")}`
              .toLowerCase()
              .includes(q)),
      )
      .sort((a, b) =>
        sort === "aum"
          ? b.s.stats.aum - a.s.stats.aum
          : sort === "clones"
            ? b.s.stats.clones - a.s.stats.clones
            : sort === "new"
              ? b.s.createdAt.localeCompare(a.s.createdAt)
              : (b.perf?.returns[sort] ?? -Infinity) -
                (a.perf?.returns[sort] ?? -Infinity),
      )
      .map((x) => x.s);
  }, [ranked, query, category, sort]);

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

  function clone(id: string) {
    const copy = store.clone(id);
    toast("Cloned into My strategies. Tweak it with Atlas AI, then backtest.");
    router.push(`/strategies/${copy.id}?edit=1`);
  }

  return (
    <DashboardShell>
      <main className="protocol-content strategies-page">
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

        {featured && (
          <div className="strategy-spotlight-row">
            <Link
              href={`/strategies/${featured.s.id}`}
              className="panel strategy-spotlight"
            >
              <div className="strategy-spotlight-head">
                <span className="eyebrow">
                  <Crown size={13} /> MOST DEPLOYED
                </span>
                {featured.perf && <ModeBadge mode={featured.perf.mode} />}
              </div>
              <h2>{featured.s.name}</h2>
              <div className="strategy-spotlight-by">
                <EnsHandle ens={featured.s.ens} />
                <span>
                  by <strong>{featured.s.creator.name}</strong>
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
            <aside className="panel strategy-creators">
              <h2>
                <TrendingUp size={18} /> Top creators
              </h2>
              <p>Ranked by creator earnings from deployments.</p>
              <ol>
                {creators.map((c, i) => (
                  <li key={c.address}>
                    <span className="strategy-rank">{i + 1}</span>
                    <span className="strategy-creator-avatar">
                      {c.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <strong>
                        <AtSign size={12} />
                        {c.name}
                      </strong>
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
          </div>
        )}

        <div className="strategy-toolbar">
          <label className="search-field strategy-search">
            <Search size={16} />
            <input
              placeholder="Search name, ENS, creator, ticker…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search strategies"
            />
          </label>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort strategies"
          >
            <option value="1Y">Top 1Y return</option>
            <option value="6M">Top 6M return</option>
            <option value="3M">Top 3M return</option>
            <option value="aum">Most deployed</option>
            <option value="clones">Most cloned</option>
            <option value="new">Newest</option>
          </select>
        </div>
        <div className="strategy-chips">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={category === c.id ? "active" : ""}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {list.length ? (
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
        ) : (
          <div className="panel protocol-empty">
            <Coins />
            <h2>No matching strategies</h2>
            <p>Try another category or search term — or create your own.</p>
            <Link className="btn primary small" href="/strategies/new">
              <Wand2 size={15} /> Create with Atlas AI
            </Link>
          </div>
        )}

        <p className="strategy-disclaimer">
          Demo marketplace: strategies, ENS handles, returns and deployments are
          simulated in your browser until the strategy backend ships. Simulated
          performance does not predict future results.
        </p>
      </main>
    </DashboardShell>
  );
}
