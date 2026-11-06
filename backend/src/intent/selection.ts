/**
 * Price-ranked asset selection, resolved before the parser.
 *
 * Prompts like "buy the highest-priced stock within 1000 USDT" or "the cheapest Indian stock"
 * name a rule, not an asset. The model must never pick assets, so Atlas resolves the rule here,
 * deterministically, against live catalog quotes, then hands the parser the concrete asset.
 */
import { assets, type CatalogAsset } from "./assets.js";
import type { PriceQuote } from "./types.js";

export type Rank = "highest" | "lowest";

const HIGHEST =
  /\b(?:most\s+expensive|priciest|costliest|highest[\s-]*(?:priced?|price|cost(?:ing)?|value(?:d)?)|top[\s-]*priced|max(?:imum)?\s+price)\b/i;
const LOWEST =
  /\b(?:cheapest|least\s+expensive|lowest[\s-]*(?:priced?|price|cost(?:ing)?|value(?:d)?)|min(?:imum)?\s+price)\b/i;

/** Market words → catalog regions. */
const REGIONS: [RegExp, string, string][] = [
  [/\b(?:us|usa|u\.s\.|american|nasdaq|nyse)\b/i, "usa", "US"],
  [/\b(?:india|indian|nse|bse)\b/i, "india", "Indian"],
  [/\b(?:uk|british|london|lse|ftse)\b/i, "uk", "UK"],
  [/\b(?:europe|european|eu)\b/i, "europe", "European"],
  [/\b(?:singapore|singaporean|sgx)\b/i, "singapore", "Singapore"],
];

/** "within / inside / under / up to / less than / max 1,000 USDT" → a per-share price cap. */
const CAP =
  /\b(?:within|inside|under|below|up\s*to|less\s+than|at\s+most|max(?:imum)?|budget\s+of|affordable\s+(?:at|for|with))\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:usdt|usd|dollars?|\$)?/i;

/** The phrase naming the rule, e.g. "the token with the highest price available inside 1000USDT". */
const SUBJECT =
  /\b(?:the\s+)?(?:listed\s+)?(?:token|stock|share|asset|company|coin|equity)s?\s+(?:with|having|that\s+has|of)\s+(?:the\s+)?/i;

export interface Selection {
  rank: Rank;
  asset: CatalogAsset;
  priceUSDT: number;
  /** Per-share price cap from the prompt, if any. */
  capUSDT: number | null;
  region: string | null;
  considered: number;
  /** The prompt with the rule replaced by the chosen asset, for the parser. */
  prompt: string;
  /** One line for the user: what Atlas picked and why. */
  note: string;
}
export type SelectionResult =
  | { status: "NONE" }
  | { status: "SELECTED"; selection: Selection }
  | { status: "NO_MATCH"; reason: string };

export function detectRank(prompt: string): Rank | null {
  if (HIGHEST.test(prompt)) return "highest";
  if (LOWEST.test(prompt)) return "lowest";
  return null;
}

const fmt = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Picks the asset the rule names from current quotes. Pure: quotes are passed in. */
export function selectByPrice(
  prompt: string,
  quotes: Map<string, PriceQuote>,
): SelectionResult {
  const rank = detectRank(prompt);
  if (!rank) return { status: "NONE" };
  const region = REGIONS.find(([re]) => re.test(prompt));
  const capMatch = prompt.match(CAP);
  const cap = capMatch ? Number(capMatch[1]!.replace(/,/g, "")) : null;
  const priced = assets
    .filter((a) => a.active && (!region || a.region === region[1]))
    .map((a) => ({ a, q: quotes.get(a.stockId) }))
    .filter(
      (x): x is { a: CatalogAsset; q: PriceQuote } =>
        !!x.q && Number(x.q.priceUSDT) > 0,
    );
  // Prefer fresh quotes; fall back to stale ones only when nothing is fresh.
  const fresh = priced.filter((x) => !x.q.isStale);
  const pool = (fresh.length ? fresh : priced).filter(
    (x) => cap === null || Number(x.q.priceUSDT) <= cap,
  );
  const scope = `${region ? `${region[2]} ` : ""}listed stock`;
  if (!pool.length)
    return {
      status: "NO_MATCH",
      reason: priced.length
        ? `No ${scope} is priced at or below ${fmt(cap!)} USDT per share right now.`
        : `Atlas has no current prices for ${scope}s, so it can't rank them. Try again shortly or name the stock.`,
    };
  pool.sort((x, y) =>
    rank === "highest"
      ? Number(y.q.priceUSDT) - Number(x.q.priceUSDT)
      : Number(x.q.priceUSDT) - Number(y.q.priceUSDT),
  );
  const { a, q } = pool[0]!;
  const price = Number(q.priceUSDT);
  const named = `${a.companyName} (${a.symbol})`;
  // Swap the rule for the asset so the parser sees a concrete instruction. If the wording is
  // unusual, the asset is stated explicitly instead.
  const rule = new RegExp(
    `${SUBJECT.source}${(rank === "highest" ? HIGHEST : LOWEST).source}(?:\\s+(?:token|stock|share|asset)s?)?(?:\\s+available)?`,
    "i",
  );
  const bare = new RegExp(
    `(?:the\\s+)?${(rank === "highest" ? HIGHEST : LOWEST).source}(?:\\s+(?:listed\\s+)?(?:token|stock|share|asset|company|coin|equity)s?)?(?:\\s+available)?`,
    "i",
  );
  let rewritten = prompt.replace(rule, named);
  if (rewritten === prompt) rewritten = prompt.replace(bare, named);
  if (rewritten === prompt) rewritten = `${prompt.trim()} Asset: ${named}.`;
  // "inside 1000 USDT" is both the price cap and, when no other amount is given, the spend.
  if (
    capMatch &&
    (prompt.match(/\d[\d,]*(?:\.\d+)?\s*(?:usdt|usd|\$)/gi) ?? []).length <= 1
  )
    rewritten = rewritten.replace(capMatch[0], `with ${capMatch[1]} USDT`);
  return {
    status: "SELECTED",
    selection: {
      rank,
      asset: a,
      priceUSDT: price,
      capUSDT: cap,
      region: region?.[1] ?? null,
      considered: pool.length,
      prompt: rewritten,
      note: `Atlas scanned ${pool.length} ${scope}${pool.length === 1 ? "" : "s"}${cap !== null ? ` priced at or below ${fmt(cap)} USDT` : ""} and picked the ${rank === "highest" ? "highest" : "lowest"}-priced: ${named} at ${fmt(price)} USDT per share.`,
    },
  };
}
