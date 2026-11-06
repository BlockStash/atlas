"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ArrowUp,
  AtSign,
  Compass,
  Copy,
  GitFork,
  Search,
  Sparkles,
  Trophy,
  Wand2,
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
  strategyCategory,
  usd,
  type Strategy,
} from "@/lib/strategies";
import { StrategyIconBadge } from "./icon";
import { creatorHref, useStrategyStore } from "./ui";

type Mode = "build" | "explore" | "clone";

const MODES: {
  id: Mode;
  label: string;
  Icon: typeof Wand2;
  hint: string;
  action: string;
  examples: string[];
}[] = [
  {
    id: "build",
    label: "Build",
    Icon: Wand2,
    hint: `Atlas AI turns your words into a backtestable strategy. Publish it and earn ${CREATOR_FEE_BPS / 100}% of every deployment.`,
    action: "Build with AI",
    examples: [
      "Buy AI chip leaders in the US and Taiwan, rebalance monthly",
      "Dividend stocks in India with a 10% stop loss",
      "60% NVDA, 40% MSFT, buy the dip when RSI drops below 30",
      "Global all-weather fund, conservative, rebalance quarterly",
      "Momentum on European industrials with a trend filter",
    ],
  },
  {
    id: "explore",
    label: "Explore",
    Icon: Compass,
    hint: "Search the community marketplace by idea, ticker, market, creator or ENS name.",
    action: "Explore",
    examples: [
      "us momentum",
      "india income",
      "meera.eth",
      "NVDA",
      "global balanced",
    ],
  },
  {
    id: "clone",
    label: "Clone",
    Icon: GitFork,
    hint: "Fork a proven strategy like a repo, then tweak it with AI. The original creator still earns on deployments.",
    action: "Find to clone",
    examples: [
      "AI leaders",
      "US Megacap",
      "dividend",
      "Europe industrials",
      "barbell",
    ],
  },
];

/** Build ideas offered as recommendations; picking one fills the prompt. */
const BUILD_IDEAS = [
  {
    title: "AI chip momentum",
    prompt:
      "Momentum strategy on AI chip makers in the US and Taiwan, rebalance monthly",
  },
  {
    title: "Defensive dividend income",
    prompt:
      "Conservative income strategy with dividend payers in India, the US and UK, 10% stop loss",
  },
];

/** Interleaved examples across every use case, for the empty prompt bar. */
const ALL_EXAMPLES = MODES[0].examples.flatMap((_, i) =>
  MODES.map((m) => ({ mode: m.id, text: m.examples[i % m.examples.length] })),
);

function matchStrategies(list: Strategy[], query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return list
    .filter((s) => {
      const c = strategyCategory(s);
      const hay = [
        s.name,
        s.ens ?? "",
        s.creator.name,
        s.prompt,
        c.group,
        c.style,
        ...s.spec.universe.flatMap((a) => [a.symbol, a.name, a.market]),
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .slice(0, 5);
}

export function StrategyHomePage() {
  const { wallet, state, toast } = useAtlas();
  const router = useRouter();
  const store = useStrategyStore();
  const input = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<Mode>("build"),
    [text, setText] = useState(""),
    [typed, setTyped] = useState(""),
    [focused, setFocused] = useState(false),
    [picked, setPicked] = useState(false),
    [active, setActive] = useState(-1),
    [shown, setShown] = useState<{ mode: Mode; text: string } | null>(null);
  const current = MODES.find((m) => m.id === mode)!;

  // Typewriter placeholder: every use case until the user picks a mode, then that mode only.
  const examples = useMemo(
    () =>
      picked
        ? current.examples.map((t) => ({ mode: current.id, text: t }))
        : ALL_EXAMPLES,
    [picked, current],
  );
  useEffect(() => {
    let example = 0,
      chars = 0,
      deleting = false;
    const tick = () => {
      const item = examples[example];
      const full = item.text;
      setShown(item);
      if (!deleting) {
        chars++;
        if (chars >= full.length) deleting = true;
      } else {
        chars -= 2;
        if (chars <= 0) {
          chars = 0;
          deleting = false;
          example = (example + 1) % examples.length;
        }
      }
      setTyped(full.slice(0, chars));
      timer = setTimeout(
        tick,
        deleting && chars >= full.length ? 1800 : deleting ? 25 : 45,
      );
    };
    let timer = setTimeout(tick, 300);
    return () => clearTimeout(timer);
  }, [examples]);

  const everything = useMemo(() => {
    const seen = new Set<string>();
    return [...store.explore, ...store.mine].filter((s) =>
      seen.has(s.id) ? false : (seen.add(s.id), true),
    );
  }, [store.explore, store.mine]);
  // A few recommendations: best performer, most cloned (not yours), and two build ideas.
  const recommended = useMemo(() => {
    const others = store.explore.filter(
      (s) => !sameAddress(s.creator.address, wallet?.address),
    );
    const ret = (s: Strategy) =>
      headlinePerformance(s)?.returns["1Y"] ??
      headlinePerformance(s)?.returns["6M"] ??
      -Infinity;
    const top = [...others].sort((a, b) => ret(b) - ret(a))[0];
    const cloned = [...others]
      .filter((s) => s.id !== top?.id)
      .sort((a, b) => b.stats.clones - a.stats.clones)[0];
    return { top, cloned };
  }, [store.explore, wallet?.address]);
  const matches = useMemo(
    () =>
      mode === "build"
        ? []
        : matchStrategies(mode === "clone" ? store.explore : everything, text),
    [mode, text, store.explore, everything],
  );

  // Explore suggestions: plain text search, ENS names (creators), strategies.
  const suggestions = useMemo((): Suggestion[] => {
    if (mode !== "explore") return [];
    const q = text.trim().toLowerCase();
    const creators = new Map<
      string,
      { name: string; address: string; count: number; aum: number }
    >();
    for (const s of store.explore) {
      if (!isEns(s.creator.name)) continue;
      const row = creators.get(s.creator.name) ?? {
        name: s.creator.name,
        address: s.creator.address,
        count: 0,
        aum: 0,
      };
      row.count++;
      row.aum += s.stats.aum;
      creators.set(s.creator.name, row);
    }
    const ens = [...creators.values()]
      .filter((c) => !q || c.name.toLowerCase().includes(q.replace(/^@/, "")))
      .sort((a, b) => b.aum - a.aum)
      .slice(0, q ? 3 : 3)
      .map((c): Suggestion => ({
        kind: "ens",
        key: `ens:${c.name}`,
        href: creatorHref(c.name, c.address)!,
        title: c.name,
        sub: `${c.count} public strateg${c.count === 1 ? "y" : "ies"} · ${compact(c.aum)} aUSDT deployed`,
      }));
    const strategies = (
      q
        ? matchStrategies(everything, q)
        : [...store.explore].sort((a, b) => b.stats.aum - a.stats.aum)
    )
      .slice(0, q ? 5 : 3)
      .map((s): Suggestion => ({
        kind: "strategy",
        key: `s:${s.id}`,
        href: `/strategies/${s.id}`,
        title: s.name,
        sub: s.ens ?? strategyCategory(s).group,
        strategy: s,
      }));
    const search: Suggestion[] = q
      ? [
          {
            kind: "text",
            key: "text",
            href: `/strategies?q=${encodeURIComponent(text.trim())}`,
            title: text.trim(),
            sub: "Search all strategies",
          },
        ]
      : [];
    return [...search, ...ens, ...strategies];
  }, [mode, text, store.explore, everything]);
  const showSuggestions =
    mode === "explore" && (focused || !!text.trim()) && suggestions.length > 0;

  const totalAum = store.explore.reduce((t, s) => t + s.stats.aum, 0);
  const totalEarned = store.explore.reduce(
    (t, s) => t + s.stats.creatorEarnings,
    0,
  );
  const totalClones = store.explore.reduce((t, s) => t + s.stats.clones, 0);
  const firstName = state.ensName?.split(".")[0];

  async function clone(s: Strategy) {
    try {
      const copy = await store.clone(s.id);
      toast(`Cloned “${s.name}”. Tweak it with Atlas AI, then backtest.`);
      router.push(`/strategies/${copy.id}?edit=1`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not clone this strategy.");
    }
  }

  function submit() {
    const t = text.trim();
    if (mode === "build") {
      if (t.length < 12) {
        toast(
          "Describe your strategy in a sentence, or pick a recommendation below.",
        );
        input.current?.focus();
        return;
      }
      router.push(`/strategies/new?prompt=${encodeURIComponent(t)}`);
    } else if (mode === "explore") {
      router.push(t ? `/strategies?q=${encodeURIComponent(t)}` : "/strategies");
    } else {
      const top = matches.find(
        (s) => !sameAddress(s.creator.address, wallet?.address),
      );
      if (top) clone(top);
      else
        router.push(
          t ? `/strategies?q=${encodeURIComponent(t)}` : "/strategies",
        );
    }
  }

  function applyIdea(prompt: string) {
    setMode("build");
    setPicked(true);
    setText(prompt);
    input.current?.focus({ preventScroll: true });
    input.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <DashboardShell>
      <main className="ai-home">
        <div className="ai-home-bg" aria-hidden>
          <span className="ai-blob one" />
          <span className="ai-blob two" />
          <span className="ai-blob three" />
          <span className="ai-grid" />
          <span className="ai-orbit one" />
          <span className="ai-orbit two" />
        </div>

        <section className="ai-hero">
          <div className="ai-center">
            <span className="ai-eyebrow">
              <span className="ai-pulse" /> ATLAS AI · STRATEGY ENGINE
            </span>
            <h1>
              {firstName ? `${firstName}, what` : "What"} should your money{" "}
              <span className="ai-gradient-text">do next?</span>
            </h1>
            <p className="ai-sub">
              Describe a strategy in plain words. Atlas AI builds, backtests and
              deploys it across six markets, or finds one the community has
              already proven.
            </p>

            <div className={`ai-prompt ${focused ? "focused" : ""}`}>
              <div className="ai-prompt-inner">
                <div
                  className="ai-modes"
                  role="tablist"
                  aria-label="What do you want to do?"
                >
                  {MODES.map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={mode === id}
                      className={mode === id ? "active" : ""}
                      onClick={() => {
                        setMode(id);
                        setPicked(true);
                        setActive(-1);
                        input.current?.focus();
                      }}
                    >
                      <Icon size={15} /> {label}
                    </button>
                  ))}
                </div>
                <div className="ai-prompt-row">
                  <Sparkles size={20} className="ai-prompt-spark" />
                  <textarea
                    ref={input}
                    rows={mode === "build" ? 2 : 1}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setActive(-1);
                    }}
                    role={mode === "explore" ? "combobox" : undefined}
                    aria-autocomplete={mode === "explore" ? "list" : undefined}
                    aria-expanded={
                      mode === "explore" ? showSuggestions : undefined
                    }
                    aria-controls="ai-suggestions"
                    aria-activedescendant={
                      showSuggestions && active >= 0
                        ? `ai-sug-${active}`
                        : undefined
                    }
                    onFocus={() => setFocused(true)}
                    onBlur={() => setTimeout(() => setFocused(false), 150)}
                    onKeyDown={(e) => {
                      if (
                        showSuggestions &&
                        (e.key === "ArrowDown" || e.key === "ArrowUp")
                      ) {
                        e.preventDefault();
                        const n = suggestions.length;
                        setActive((i) =>
                          e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n,
                        );
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        const pick = showSuggestions
                          ? suggestions[active]
                          : undefined;
                        if (pick) router.push(pick.href);
                        else submit();
                      }
                      if (e.key === "Escape") setText("");
                      // Tab on an empty bar takes the example being shown.
                      if (e.key === "Tab" && !e.shiftKey && !text && shown) {
                        e.preventDefault();
                        setMode(shown.mode);
                        setPicked(true);
                        setText(shown.text);
                      }
                    }}
                    placeholder={
                      typed
                        ? `${picked || !shown ? "" : `${MODES.find((m) => m.id === shown.mode)!.label} · `}${typed}▍`
                        : ""
                    }
                    aria-label={current.action}
                    maxLength={1000}
                    spellCheck={mode === "build"}
                  />
                  <button
                    type="button"
                    className="ai-send"
                    onClick={submit}
                    aria-label={current.action}
                  >
                    <span>{current.action}</span>
                    <ArrowUp size={18} />
                  </button>
                </div>
                <p className="ai-hint">
                  {current.hint}
                  {!text && (
                    <span className="ai-tab-hint">
                      <kbd>Tab</kbd> use example
                    </span>
                  )}
                </p>
              </div>

              {showSuggestions && (
                <ExploreSuggestions
                  items={suggestions}
                  active={active}
                  query={text.trim()}
                  onHover={setActive}
                />
              )}
              {mode === "clone" && matches.length > 0 && (
                <ul className="ai-results" role="listbox">
                  {matches.map((s) => {
                    const perf = headlinePerformance(s);
                    const mine = sameAddress(
                      s.creator.address,
                      wallet?.address,
                    );
                    return (
                      <li key={s.id}>
                        <Link
                          href={`/strategies/${s.id}`}
                          className="ai-result-main"
                        >
                          <StrategyIconBadge icon={s.icon} size={36} />
                          <span>
                            <b>{s.name}</b>
                            <small>
                              {mine ? "you" : s.creator.name} ·{" "}
                              {strategyCategory(s).group}
                            </small>
                          </span>
                          <span
                            className={
                              (perf?.returns["1Y"] ?? 0) < 0
                                ? "negative"
                                : "positive"
                            }
                          >
                            {pct(perf?.returns["1Y"])} <small>1Y</small>
                          </span>
                        </Link>
                        {mode === "clone" && !mine ? (
                          <button
                            type="button"
                            className="btn primary small"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => clone(s)}
                          >
                            <Copy size={14} /> Clone
                          </button>
                        ) : (
                          <Link
                            className="btn secondary small"
                            href={`/strategies/${s.id}`}
                          >
                            Open
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {mode === "clone" && text.trim() && matches.length === 0 && (
                <p className="ai-results-empty">
                  Nothing matches “{text.trim()}” yet.{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setMode("build")}
                  >
                    Build it with AI instead <ArrowRight size={14} />
                  </button>
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="ai-recs" aria-label="Recommended for you">
          <h2>
            <Sparkles size={18} /> Recommended for you
          </h2>
          <div className="ai-recs-grid">
            {recommended.top && (
              <Rec
                tag="Top performer"
                Icon={Trophy}
                s={recommended.top}
                action={
                  <Link
                    className="btn secondary small"
                    href={`/strategies/${recommended.top.id}`}
                  >
                    Explore <ArrowRight size={14} />
                  </Link>
                }
              />
            )}
            {recommended.cloned && (
              <Rec
                tag={`Most cloned · ${recommended.cloned.stats.clones} clones`}
                Icon={GitFork}
                s={recommended.cloned}
                action={
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => clone(recommended.cloned!)}
                  >
                    <Copy size={14} /> Clone
                  </button>
                }
              />
            )}
            {BUILD_IDEAS.map((idea) => (
              <article key={idea.title} className="ai-rec idea">
                <span className="ai-rec-tag">
                  <Wand2 size={13} /> Build idea
                </span>
                <h3>{idea.title}</h3>
                <p>{idea.prompt}</p>
                <button
                  type="button"
                  className="btn secondary small"
                  onClick={() => applyIdea(idea.prompt)}
                >
                  <Sparkles size={14} /> Use this prompt
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="ai-stats">
          <div>
            <strong>{store.explore.length}</strong>
            <span>public strategies</span>
          </div>
          <div>
            <strong>{compact(totalAum)}</strong>
            <span>aUSDT deployed by users</span>
          </div>
          <div>
            <strong>{usd(totalEarned, 0)}</strong>
            <span>aUSDT paid to creators</span>
          </div>
          <div>
            <strong>{compact(totalClones)}</strong>
            <span>strategies cloned</span>
          </div>
        </section>

        <section className="ai-paths">
          {[
            {
              Icon: Wand2,
              title: "Build",
              text: "Say it in plain words. Atlas AI writes the rules, weights and risk limits, then backtests a year in seconds.",
              href: "/strategies/new",
              cta: "Open the studio",
            },
            {
              Icon: Compass,
              title: "Explore",
              text: "Browse community strategies with live, paper and backtest track records across six markets.",
              href: "/strategies",
              cta: "Browse strategies",
            },
            {
              Icon: GitFork,
              title: "Clone & earn",
              text: `Fork any public strategy and make it yours. Publish your own and earn ${CREATOR_FEE_BPS / 100}% of every deployment, clones included.`,
              href: "/strategies/mine",
              cta: "My strategies",
            },
          ].map(({ Icon, title, text, href, cta }) => (
            <Link key={title} href={href} className="ai-path">
              <span className="ai-path-icon">
                <Icon size={22} />
              </span>
              <h2>{title}</h2>
              <p>{text}</p>
              <span className="ai-path-cta">
                {cta} <ArrowRight size={15} />
              </span>
            </Link>
          ))}
        </section>

        <p className="strategy-disclaimer ai-disclaimer">
          Demo: strategies, returns and earnings are simulated in your browser
          until the strategy backend ships. Past or simulated performance does
          not predict future results.
        </p>
      </main>
    </DashboardShell>
  );
}

function Rec({
  tag,
  Icon,
  s,
  action,
}: {
  tag: string;
  Icon: typeof Wand2;
  s: Strategy;
  action: React.ReactNode;
}) {
  const perf = headlinePerformance(s);
  const r = perf?.returns["1Y"] ?? perf?.returns["6M"] ?? null;
  const period = perf?.returns["1Y"] != null ? "1Y" : "6M";
  return (
    <article className="ai-rec">
      <span className="ai-rec-tag">
        <Icon size={13} /> {tag}
      </span>
      <Link href={`/strategies/${s.id}`} className="ai-rec-title">
        <StrategyIconBadge icon={s.icon} size={38} />
        <h3>{s.name}</h3>
      </Link>
      <p>
        {strategyCategory(s).group} · by {s.creator.name}
      </p>
      <div className="ai-rec-foot">
        {r !== null && (
          <span className={r < 0 ? "negative" : "positive"}>
            {pct(r)} <small>{period}</small>
          </span>
        )}
        {action}
      </div>
    </article>
  );
}

type Suggestion = {
  kind: "text" | "ens" | "strategy";
  key: string;
  href: string;
  title: string;
  sub: string;
  strategy?: Strategy;
};

const GROUP_LABEL: Record<Suggestion["kind"], string> = {
  text: "Search",
  ens: "ENS names",
  strategy: "Strategies",
};

/** Highlights the query inside a suggestion title. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.replace(/^@/, "").toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

function ExploreSuggestions({
  items,
  active,
  query,
  onHover,
}: {
  items: Suggestion[];
  active: number;
  query: string;
  onHover: (i: number) => void;
}) {
  return (
    <div
      id="ai-suggestions"
      className="ai-results ai-suggestions"
      role="listbox"
      // Keep focus in the prompt while clicking a suggestion.
      onMouseDown={(e) => e.preventDefault()}
    >
      {!query && <p className="ai-sug-intro">Recommended</p>}
      {items.map((item, i) => {
        const perf = item.strategy ? headlinePerformance(item.strategy) : null;
        const r = perf?.returns["1Y"] ?? perf?.returns["6M"] ?? null;
        return (
          <div key={item.key}>
            {(i === 0 || items[i - 1].kind !== item.kind) && (
              <p className="ai-sug-group">{GROUP_LABEL[item.kind]}</p>
            )}
            <Link
              id={`ai-sug-${i}`}
              role="option"
              aria-selected={i === active}
              href={item.href}
              className={`ai-sug ${item.kind} ${i === active ? "active" : ""}`}
              onMouseEnter={() => onHover(i)}
            >
              <span className="ai-sug-icon">
                {item.kind === "text" ? (
                  <Search size={17} />
                ) : item.kind === "ens" ? (
                  <AtSign size={17} />
                ) : (
                  <StrategyIconBadge icon={item.strategy!.icon} size={34} />
                )}
              </span>
              <span className="ai-sug-body">
                {item.kind === "text" ? (
                  <b>
                    “<Highlight text={item.title} query="" />”
                  </b>
                ) : item.kind === "ens" ? (
                  <span className="ens-chip">
                    <AtSign size={12} />
                    <span className="ens-chip-text">
                      <Highlight text={item.title} query={query} />
                    </span>
                  </span>
                ) : (
                  <b>
                    <Highlight text={item.title} query={query} />
                  </b>
                )}
                <small>
                  {item.kind === "strategy" && item.strategy?.ens ? (
                    <Highlight text={item.sub} query={query} />
                  ) : (
                    item.sub
                  )}
                </small>
              </span>
              {item.kind === "strategy" && r !== null ? (
                <span className={r < 0 ? "negative" : "positive"}>
                  {pct(r)}{" "}
                  <small>{perf?.returns["1Y"] != null ? "1Y" : "6M"}</small>
                </span>
              ) : (
                <span className="ai-sug-go">
                  {item.kind === "text" ? "Search" : "View profile"}
                  <ArrowRight size={14} />
                </span>
              )}
            </Link>
          </div>
        );
      })}
      <p className="ai-sug-foot">
        <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open
      </p>
    </div>
  );
}
