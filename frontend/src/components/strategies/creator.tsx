"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AtSign,
  Check,
  Coins,
  Copy,
  GitFork,
  Layers,
  Trophy,
  Users,
  UserRound,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { DashboardShell } from "@/components/dashboard/shell";
import {
  CREATOR_FEE_BPS,
  compact,
  headlinePerformance,
  isEns,
  pct,
  sameAddress,
  shortAddress,
  usd,
  type Creator,
  type Strategy,
} from "@/lib/strategies";
import {
  StrategyTable,
  ViewToggle,
  sortStrategies,
  type SortState,
  type ViewMode,
} from "./table";
import { StrategyCard, useStrategyStore } from "./ui";

const matches = (c: Creator, slug: string) =>
  c.name.toLowerCase() === slug || c.address.toLowerCase() === slug;

/** Public profile of a strategy creator, addressed by ENS name or wallet address. */
export function CreatorPage({ handle }: { handle: string }) {
  const { wallet, toast } = useAtlas();
  const store = useStrategyStore();
  const slug = handle.toLowerCase();
  const [view, setView] = useState<ViewMode>("list"),
    [sort, setSort] = useState<SortState>({ key: "1Y", dir: "desc" }),
    [copied, setCopied] = useState(false);

  const authored = useMemo(
    () => store.strategies.filter((s) => matches(s.creator, slug)),
    [store.strategies, slug],
  );
  const creator: Creator | undefined =
    authored[0]?.creator ??
    store.strategies.find((s) => matches(s.originalCreator, slug))
      ?.originalCreator;
  const isMe = !!creator && sameAddress(creator.address, wallet?.address);
  const published = authored.filter((s) => s.visibility === "public");
  const privateCount = authored.length - published.length;
  // Public strategies by other people that trace back to this creator's originals.
  const derived = store.strategies.filter(
    (s) =>
      s.visibility === "public" &&
      matches(s.originalCreator, slug) &&
      !matches(s.creator, slug),
  );

  const aum = published.reduce((t, s) => t + s.stats.aum, 0);
  const deployers = published.reduce((t, s) => t + s.stats.deployers, 0);
  const clones = published.reduce((t, s) => t + s.stats.clones, 0);
  const earned = [...published, ...derived]
    .filter((s) => !s.forkedFrom || matches(s.originalCreator, slug))
    .reduce((t, s) => t + s.stats.creatorEarnings, 0);
  const best = published
    .map((s) => ({ s, r: headlinePerformance(s)?.returns["1Y"] ?? null }))
    .filter((x): x is { s: Strategy; r: number } => x.r !== null)
    .sort((a, b) => b.r - a.r)[0];

  return (
    <DashboardShell>
      <main className="protocol-content strategies-page">
        <Link className="text-button strategy-back" href="/strategies">
          <ArrowLeft size={14} /> Explore strategies
        </Link>

        {!creator ? (
          <div className="panel protocol-empty">
            <UserRound />
            <h2>Creator not found</h2>
            <p>
              No strategies were found for <strong>{handle}</strong>. They may
              not have published anything yet.
            </p>
            <Link className="btn secondary small" href="/strategies">
              Browse all strategies
            </Link>
          </div>
        ) : (
          <>
            <section className="creator-hero">
              <span className="creator-avatar" aria-hidden>
                {(isEns(creator.name) ? creator.name : "0x")
                  .slice(0, 1)
                  .toUpperCase()}
              </span>
              <div className="creator-identity">
                <span className="eyebrow">
                  <UserRound size={13} /> CREATOR PROFILE
                  {isMe && " · YOU"}
                </span>
                <h1>
                  {isEns(creator.name) ? (
                    <span className="ens-chip creator-ens">
                      <AtSign size={22} />
                      <span className="ens-chip-text">{creator.name}</span>
                    </span>
                  ) : (
                    shortAddress(creator.address)
                  )}
                </h1>
                <div className="creator-address">
                  <code>{shortAddress(creator.address)}</code>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      navigator.clipboard
                        ?.writeText(creator.address)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        })
                        .catch(() => toast("Could not copy the address."))
                    }
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? "Copied" : "Copy address"}
                  </button>
                  {isMe && (
                    <Link className="text-button" href="/strategies/mine">
                      <Layers size={14} /> Manage in My strategies
                    </Link>
                  )}
                </div>
              </div>
            </section>

            <div className="creator-stats">
              <div>
                <span>Public strategies</span>
                <strong>{published.length}</strong>
                {isMe && privateCount > 0 && (
                  <small>+ {privateCount} private, visible only to you</small>
                )}
              </div>
              <div>
                <span>
                  <Coins size={14} /> Deployed by users
                </span>
                <strong>{compact(aum)} aUSDT</strong>
                <small>{deployers} deployers</small>
              </div>
              <div>
                <span>
                  <GitFork size={14} /> Times cloned
                </span>
                <strong>{compact(clones)}</strong>
                <small>{derived.length} public forks by others</small>
              </div>
              <div>
                <span>
                  <Users size={14} /> Creator earnings
                </span>
                <strong>{usd(earned)} aUSDT</strong>
                <small>{CREATOR_FEE_BPS / 100}% of funds deployed</small>
              </div>
              <div>
                <span>
                  <Trophy size={14} /> Best 1Y return
                </span>
                <strong
                  className={best && best.r < 0 ? "negative" : "positive"}
                >
                  {best ? pct(best.r) : "—"}
                </strong>
                <small>{best ? best.s.name : "Needs a year of history"}</small>
              </div>
            </div>

            <section className="strategy-browse">
              <div className="strategy-browse-head">
                <h2>Public strategies</h2>
                <ViewToggle view={view} onChange={setView} />
              </div>
              {published.length ? (
                view === "list" ? (
                  <StrategyTable
                    rows={sortStrategies(published, sort)}
                    sort={sort}
                    onSort={setSort}
                    account={wallet?.address}
                  />
                ) : (
                  <div className="strategy-grid">
                    {sortStrategies(published, sort).map((s) => (
                      <StrategyCard key={s.id} s={s} mine={isMe} />
                    ))}
                  </div>
                )
              ) : (
                <div className="panel protocol-empty">
                  <Layers />
                  <h2>No public strategies yet</h2>
                  <p>
                    {isMe
                      ? "Your strategies are private. Make one public from its page to list it here."
                      : "This creator hasn’t published any strategies."}
                  </p>
                </div>
              )}
            </section>

            {derived.length > 0 && (
              <section className="strategy-browse">
                <div className="strategy-browse-head">
                  <h2>Built on their work</h2>
                </div>
                <p className="creator-note">
                  Public forks by other creators. Deployments into these still
                  pay {CREATOR_FEE_BPS / 100}% to the original creator.
                </p>
                <StrategyTable
                  rows={sortStrategies(derived, sort)}
                  sort={sort}
                  onSort={setSort}
                  account={wallet?.address}
                />
              </section>
            )}
          </>
        )}
      </main>
    </DashboardShell>
  );
}
