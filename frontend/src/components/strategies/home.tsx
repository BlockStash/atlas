"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUp,
  AtSign,
  Compass,
  Search,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { DashboardShell } from "@/components/dashboard/shell";
import {
  compact,
  headlinePerformance,
  isEns,
  pct,
  strategyCategory,
  type Strategy,
} from "@/lib/strategies";
import { StrategyIconBadge } from "./icon";
import { creatorHref, useStrategyStore } from "./ui";

type Mode = "build" | "explore";

const MODES: {
  id: Mode;
  label: string;
  Icon: typeof Wand2;
  action: string;
  examples: string[];
}[] = [
  {
    id: "build",
    label: "Build",
    Icon: Wand2,
    action: "Build strategy",
    examples: [
      // Each one builds end to end through Atlas AI (checked against the backend parser).
      "Buy AI chip leaders in the US and Taiwan, rebalance monthly",
      "Buy Apple with 1,000 USDT now. Sell at +8% or -3%.",
      "Dividend portfolio of Indian bluechips with a 10% stop loss",
      "60% NVDA, 40% MSFT, buy the dip when RSI drops below 30",
      "Global all-weather fund, conservative, rebalance quarterly",
      "Momentum portfolio of European industrials with a trend filter",
    ],
  },
  {
    id: "explore",
    label: "Explore strategy",
    Icon: Compass,
    action: "Explore strategy",
    examples: [
      "us momentum",
      "india income",
      "meera.eth",
      "NVDA",
      "global balanced",
    ],
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
  const { state, toast } = useAtlas();
  const router = useRouter();
  const store = useStrategyStore();
  const input = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<Mode>("build"),
    [text, setText] = useState(""),
    [typed, setTyped] = useState(""),
    [focused, setFocused] = useState(false),
    [picked, setPicked] = useState(false),
    [active, setActive] = useState(-1),
    [shown, setShown] = useState<{ mode: Mode; text: string } | null>(null),
    // Build mode: one example prompt at a time, as a badge, changing every 2 seconds.
    [idea, setIdea] = useState(0),
    [ideaPaused, setIdeaPaused] = useState(false);
  const current = MODES.find((m) => m.id === mode)!;
  const ideas = MODES[0].examples;
  useEffect(() => {
    if (mode !== "build" || ideaPaused) return;
    const t = setInterval(() => setIdea((i) => (i + 1) % ideas.length), 2000);
    return () => clearInterval(t);
  }, [mode, ideaPaused, ideas.length]);

  // Typewriter placeholder: every use case until the user picks a mode, then that mode only.
  const examples = useMemo(
    () =>
      picked
        ? current.examples.map((t) => ({ mode: current.id, text: t }))
        : ALL_EXAMPLES.filter((e) => e.mode === "explore"),
    [picked, current],
  );
  useEffect(() => {
    if (mode === "build") {
      setTyped("");
      return;
    }
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
  }, [examples, mode]);

  const everything = useMemo(() => {
    const seen = new Set<string>();
    return [...store.explore, ...store.mine].filter((s) =>
      seen.has(s.id) ? false : (seen.add(s.id), true),
    );
  }, [store.explore, store.mine]);

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

  const firstName = state.ensName?.split(".")[0];

  function submit() {
    // An empty Build bar takes the idea on the badge.
    const t = text.trim() || (mode === "build" ? ideas[idea] : "");
    if (mode === "build") {
      if (t.length < 12) {
        toast("Describe your strategy in a sentence or two.");
        input.current?.focus();
        return;
      }
      router.push(`/strategies/new?prompt=${encodeURIComponent(t)}`);
    } else {
      router.push(t ? `/strategies?q=${encodeURIComponent(t)}` : "/strategies");
    }
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
                      if (
                        e.key === "Tab" &&
                        !e.shiftKey &&
                        !text &&
                        mode === "build"
                      ) {
                        e.preventDefault();
                        setText(ideas[idea]);
                      } else if (
                        e.key === "Tab" &&
                        !e.shiftKey &&
                        !text &&
                        shown
                      ) {
                        e.preventDefault();
                        setMode(shown.mode);
                        setPicked(true);
                        setText(shown.text);
                      }
                    }}
                    placeholder={
                      mode === "build"
                        ? "Describe your strategy, or build the idea below…"
                        : typed
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
                {mode === "build" && (
                  <div
                    className="ai-idea"
                    onMouseEnter={() => setIdeaPaused(true)}
                    onMouseLeave={() => setIdeaPaused(false)}
                    onFocus={() => setIdeaPaused(true)}
                    onBlur={() => setIdeaPaused(false)}
                  >
                    <span className="ai-idea-label">
                      <Wand2 size={13} /> Try
                    </span>
                    <div className="ai-idea-slot" aria-live="polite">
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.button
                          key={idea}
                          type="button"
                          className="ai-idea-badge"
                          title="Use this prompt"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -8 }}
                          transition={{ duration: 0.25 }}
                          onClick={() => {
                            setText(ideas[idea]);
                            input.current?.focus();
                          }}
                        >
                          {ideas[idea]}
                        </motion.button>
                      </AnimatePresence>
                    </div>
                    <span className="ai-idea-dots" aria-hidden>
                      {ideas.map((_, i) => (
                        <i key={i} className={i === idea ? "on" : ""} />
                      ))}
                    </span>
                  </div>
                )}
              </div>

              {showSuggestions && (
                <ExploreSuggestions
                  items={suggestions}
                  active={active}
                  query={text.trim()}
                  onHover={setActive}
                />
              )}
            </div>
          </div>
        </section>
      </main>
    </DashboardShell>
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
