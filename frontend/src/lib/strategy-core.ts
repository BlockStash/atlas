/**
 * Strategy marketplace — shared core (no React, no browser APIs).
 *
 * Types, the prompt → spec compiler, validation, the deterministic performance
 * simulator, fee maths and the seed marketplace. The backend runs the same code
 * (copied to backend/src/strategies/core.ts by `npm run strategies:sync`), so
 * the browser and the API always agree on specs, returns and creator fees.
 */
import catalog from "@/lib/protocol/catalog.json";

// ───────────────────────────── Spec (saved format) ─────────────────────────────

export type Market = "india" | "usa" | "uk" | "singapore" | "europe" | "crypto";
export type RiskProfile = "conservative" | "balanced" | "aggressive";
export type Frequency = "weekly" | "monthly" | "quarterly";
export type Visibility = "private" | "public";
export type RunMode = "backtest" | "paper" | "live";
export type Period = "3M" | "6M" | "1Y";

export const PERIODS: Period[] = ["3M", "6M", "1Y"];
export const PERIOD_DAYS: Record<Period, number> = {
  "3M": 91,
  "6M": 182,
  "1Y": 365,
};
/** Share of each deployment paid to the strategy's original creator. */
export const CREATOR_FEE_BPS = 10; // 0.1%

export interface StrategyAsset {
  symbol: string;
  name: string;
  market: Market;
  /** Target weight, percent of the strategy. Weights sum to 100. */
  weight: number;
}

export type RuleCondition =
  | { indicator: "rsi"; period: number; op: "<" | ">"; value: number }
  | {
      indicator: "sma_cross";
      fast: number;
      slow: number;
      op: "crosses_above" | "crosses_below";
    }
  | { indicator: "drawdown"; lookbackDays: number; op: ">"; valuePct: number }
  | {
      indicator: "momentum";
      lookbackDays: number;
      op: ">" | "<";
      valuePct: number;
    };

export interface StrategyRule {
  id: string;
  appliesTo: "each_asset" | string; // a symbol, or every asset in the universe
  when: RuleCondition;
  then: {
    action: "buy" | "sell" | "reduce" | "increase";
    /** Percent of the asset's target weight to move. */
    sizePct: number;
  };
}

/**
 * Versioned, declarative strategy definition. This is what a prompt compiles to,
 * what gets saved, cloned, backtested and executed. JSON keeps it diffable,
 * forkable and easy to validate on the backend.
 */
export interface StrategySpec {
  schema: "atlas.strategy/v1";
  objective: string;
  riskProfile: RiskProfile;
  baseCurrency: "aUSDT";
  universe: StrategyAsset[];
  rebalance: { frequency: Frequency; driftTolerancePct: number };
  rules: StrategyRule[];
  risk: {
    stopLossPct: number | null;
    takeProfitPct: number | null;
    maxAssetWeightPct: number;
    cashBufferPct: number;
  };
  execution: { minDeployment: number; maxSlippageBps: number };
}

// ───────────────────────────── Strategy records ─────────────────────────────

export interface Creator {
  address: string;
  name: string;
}

export interface RunMeta {
  startedAt: string; // ISO
  capital: number;
  nonce: string; // changes when the spec changes / run is restarted
}

// ───────────────────────────── Icons ─────────────────────────────

/** Glyphs a strategy can use, rendered with lucide-react. */
export const STRATEGY_ICONS = [
  "Rocket",
  "Globe",
  "Gem",
  "Flame",
  "Zap",
  "Leaf",
  "Shield",
  "Mountain",
  "Anchor",
  "Compass",
  "Crown",
  "Target",
  "TrendingUp",
  "Landmark",
  "Coins",
  "Bitcoin",
  "Cpu",
  "Sun",
  "Moon",
  "Waves",
  "Sprout",
  "Diamond",
  "Feather",
  "Atom",
  "Orbit",
  "Factory",
  "Banknote",
  "PiggyBank",
  "Trophy",
  "Star",
  "Brain",
  "Telescope",
] as const;
export type StrategyIconName = (typeof STRATEGY_ICONS)[number];
/** Seven colours: coprime with 32 glyphs, so stepping through combos reaches all 224. */
export const STRATEGY_COLORS = [
  "blue",
  "violet",
  "green",
  "amber",
  "rose",
  "cyan",
  "orange",
] as const;
export type StrategyColor = (typeof STRATEGY_COLORS)[number];
export interface StrategyIcon {
  name: StrategyIconName;
  color: StrategyColor;
}
export const iconKey = (i: StrategyIcon) => `${i.name}:${i.color}`;
const ICON_COMBOS = STRATEGY_ICONS.length * STRATEGY_COLORS.length;
const comboAt = (k: number): StrategyIcon => ({
  name: STRATEGY_ICONS[k % STRATEGY_ICONS.length]!,
  color: STRATEGY_COLORS[k % STRATEGY_COLORS.length]!,
});
export function isStrategyIcon(v: unknown): v is StrategyIcon {
  const i = v as StrategyIcon;
  return (
    !!i &&
    (STRATEGY_ICONS as readonly string[]).includes(i.name) &&
    (STRATEGY_COLORS as readonly string[]).includes(i.color)
  );
}
/** Deterministic default from `seed`, skipping combinations already in use. */
export function pickIcon(
  seed: string,
  taken: Iterable<StrategyIcon>,
): StrategyIcon {
  const used = new Set([...taken].map(iconKey));
  const start = hash(seed) % ICON_COMBOS;
  for (let i = 0; i < ICON_COMBOS; i++) {
    const icon = comboAt((start + i) % ICON_COMBOS);
    if (!used.has(iconKey(icon))) return icon;
  }
  return comboAt(start); // All 224 in use: fall back to a repeat.
}

export interface Strategy {
  id: string;
  name: string;
  /** Glyph + colour; unique among the strategies a user can see. */
  icon: StrategyIcon;
  /** ENS subname handle, e.g. `global-ai-leaders.meera.eth`; null until the creator links ENS. */
  ens: string | null;
  tagline: string;
  prompt: string;
  spec: StrategySpec;
  visibility: Visibility;
  creator: Creator;
  /** Root author of a clone chain — receives the creator fee. */
  originalCreator: Creator;
  forkedFrom: { id: string; name: string; creator: string } | null;
  createdAt: string;
  updatedAt: string;
  stats: {
    clones: number;
    deployers: number;
    aum: number; // aUSDT deployed live by other users
    creatorEarnings: number; // aUSDT earned by originalCreator via this strategy
  };
  /** The strategy's own published track record. */
  runs: Partial<Record<RunMode, RunMeta>>;
}

export interface Position {
  id: string;
  strategyId: string;
  mode: "paper" | "live";
  capital: number; // net amount at work
  creatorFee: number;
  feeRecipient: string | null;
  startedAt: string;
}

export interface Performance {
  mode: RunMode;
  days: number;
  capital: number;
  value: number;
  returns: Record<Period, number | null>;
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  curve: number[]; // indexed to 100
  startedAt: string;
}

// ───────────────────────────── Asset universe ─────────────────────────────

export const ASSETS: StrategyAsset[] = [
  ...catalog.stocks.map((s) => ({
    symbol: s.ticker,
    name: s.companyName,
    market: s.region as Market,
    weight: 0,
  })),
];
const bySymbol = new Map(ASSETS.map((a) => [a.symbol.toUpperCase(), a]));

/** Settlement currencies: what strategies are funded in, never a traded asset. */
export const SETTLEMENT_ASSETS = ["aUSDT", "USDT"] as const;

// Atlas trades only its listed tokenized stocks, funded in aUSDT/USDT. Crypto is not listed.
const CRYPTO_WORDS: [RegExp, string][] = [
  [/\b(btc|bitcoin|wbtc)\b/i, "Bitcoin (BTC)"],
  [/\b(eth|ether|ethereum|weth)\b/i, "Ethereum (ETH)"],
  [/\b(sol|solana)\b/i, "Solana (SOL)"],
  [/\b(LINK)\b|\bchainlink\b/i, "Chainlink (LINK)"],
  [/\b(xrp|ripple)\b/i, "XRP"],
  [/\b(bnb|binance coin)\b/i, "BNB"],
  [/\b(doge|dogecoin)\b/i, "Dogecoin (DOGE)"],
  [/\b(ADA)\b|\bcardano\b/i, "Cardano (ADA)"],
  [/\b(matic|pol|polygon)\b/i, "Polygon (POL)"],
  [/\b(avax|avalanche)\b/i, "Avalanche (AVAX)"],
  [/\b(DOT)\b|\bpolkadot\b/i, "Polkadot (DOT)"],
  [/\b(ltc|litecoin)\b/i, "Litecoin (LTC)"],
  [/\b(trx|tron)\b/i, "Tron (TRX)"],
  [/\b(TON)\b|\btoncoin\b/i, "Toncoin (TON)"],
  [/\b(shib|shiba(?: inu)?|pepe)\b/i, "meme coins"],
  [/\b(usdc|dai|busd|tusd|fdusd)\b/i, "other stablecoins"],
  [
    /\b(crypto(?:currenc(?:y|ies)|s)?|altcoins?|memecoins?|defi|nfts?|tokens? other than)\b/i,
    "crypto",
  ],
];
// Upper-case words that are not tickers (markets, indicators, units, time zones…).
const NOT_TICKERS = new Set(
  "USDT AUSDT USD INR GBP EUR SGD AI US USA UK EU ASEAN RSI SMA EMA MACD ETF ETFS NASDAQ NYSE LSE NSE BSE SGX FTSE DAX ENS IPO CEO CFO ATLAS TP SL GMT UTC IST EST EDT PST BST CET ET AM PM ESG EV EVS DCA ATH YTD PE EPS ROI APY APR OK FAQ ID KYC API NAV AUM P L PNL".split(
    " ",
  ),
);

/**
 * Assets the prompt asks for that Atlas cannot trade: crypto, and stock tickers that are not
 * listed (e.g. `$NFLX`). Empty when everything named is tradable.
 */
export function unsupportedAssets(prompt: string): string[] {
  const out = new Set<string>();
  for (const [re, label] of CRYPTO_WORDS) if (re.test(prompt)) out.add(label);
  const tickers = [
    ...prompt.matchAll(/\$([A-Za-z][A-Za-z0-9.]{0,9})\b/g),
    ...prompt.matchAll(
      /(?:^|[^A-Za-z0-9$])([A-Z][A-Z0-9]{1,5}\.?)(?![A-Za-z0-9])/g,
    ),
  ];
  for (const m of tickers) {
    const raw = m[1]!.toUpperCase().replace(/\.$/, "");
    if (NOT_TICKERS.has(raw) || bySymbol.has(raw) || bySymbol.has(raw + "."))
      continue;
    if (CRYPTO_WORDS.some(([re]) => re.test(raw))) continue; // Already named above.
    out.add(raw);
  }
  return [...out];
}

/** The message shown whenever a prompt or spec names something Atlas cannot trade. */
export function unsupportedMessage(assets: string[]) {
  const list =
    assets.length <= 1
      ? (assets[0] ?? "that asset")
      : `${assets.slice(0, -1).join(", ")} and ${assets.at(-1)}`;
  return `ATLAS doesn’t support ${list}. You can only trade the listed tokenized stocks, using aUSDT or USDT.`;
}

export const MARKET_LABEL: Record<Market, string> = {
  india: "India",
  usa: "United States",
  uk: "United Kingdom",
  singapore: "Singapore",
  europe: "Europe",
  crypto: "Crypto",
};
export const MARKET_FLAG: Record<Market, string> = {
  india: "🇮🇳",
  usa: "🇺🇸",
  uk: "🇬🇧",
  singapore: "🇸🇬",
  europe: "🇪🇺",
  crypto: "₿",
};

const SECTORS: Record<string, string[]> = {
  tech: ["AAPL", "MSFT", "NVDA", "GOOGL", "META", "SAP", "ASML", "TCS", "INFY"],
  ai: ["NVDA", "MSFT", "GOOGL", "ASML", "META"],
  bank: [
    "HDFCBANK",
    "ICICIBANK",
    "SBIN",
    "JPM",
    "HSBA",
    "BARC",
    "D05",
    "O39",
    "U11",
  ],
  energy: ["RELIANCE", "SHEL", "BP.", "TTE"],
  consumer: ["HINDUNILVR", "ITC", "ULVR", "DGE", "MC", "ADS", "AMZN"],
  health: ["AZN", "GSK"],
  pharma: ["AZN", "GSK"],
  industrial: ["LT", "SIE", "AIR", "RR.", "S63", "BN4"],
  defence: ["RR.", "AIR", "S63"],
  telecom: ["BHARTIARTL", "Z74", "DTE"],
  payment: ["V", "JPM"],
  dividend: ["ITC", "HSBA", "SHEL", "ULVR", "D05", "O39", "ALV", "TTE"],
  luxury: ["MC", "MBG"],
  auto: ["TSLA", "MBG"],
  ev: ["TSLA"],
};

// ───────────────────────────── Prompt → spec (mock AI) ─────────────────────────────

export interface Generated {
  spec: StrategySpec;
  suggestedName: string;
  tagline: string;
  assumptions: string[];
  /** Assets the prompt named that Atlas cannot trade; callers must not save such a strategy. */
  unsupported: string[];
}

export const uid = (p = "") =>
  p +
  Math.random().toString(36).slice(2, 8) +
  Date.now().toString(36).slice(-4);

function equalWeights(assets: StrategyAsset[], cryptoCap?: number) {
  if (!assets.length) return assets;
  const crypto = assets.filter((a) => a.market === "crypto");
  const rest = assets.filter((a) => a.market !== "crypto");
  let cryptoShare = crypto.length
    ? rest.length
      ? Math.min((crypto.length / assets.length) * 100, cryptoCap ?? 100)
      : 100
    : 0;
  cryptoShare = Math.round(cryptoShare);
  const out = [
    ...rest.map((a) => ({ ...a, weight: (100 - cryptoShare) / rest.length })),
    ...crypto.map((a) => ({ ...a, weight: cryptoShare / crypto.length })),
  ];
  return normalizeWeights(out);
}

/** Round to 1dp and push rounding drift into the largest weight so the sum is exactly 100. */
export function normalizeWeights(assets: StrategyAsset[]) {
  const total = assets.reduce((s, a) => s + a.weight, 0) || 1;
  const out = assets.map((a) => ({
    ...a,
    weight: Math.round((a.weight / total) * 1000) / 10,
  }));
  const drift =
    Math.round((100 - out.reduce((s, a) => s + a.weight, 0)) * 10) / 10;
  if (out.length && drift) {
    const i = out.reduce((m, a, j) => (a.weight > out[m]!.weight ? j : m), 0);
    out[i] = {
      ...out[i]!,
      weight: Math.round((out[i]!.weight + drift) * 10) / 10,
    };
  }
  return out;
}

export function generateSpec(prompt: string): Generated {
  const text = prompt.toLowerCase();
  const assumptions: string[] = [];
  const has = (...words: string[]) =>
    // Whole words only ("something" must not match "eth", "small" not "sma").
    // A trailing * allows a prefix match, e.g. "diversif*".
    words.some((w) =>
      new RegExp(
        `(^|[^a-z0-9])${w.replace(/[.&]/g, "\\$&").replace(/\*$/, "[a-z]*")}($|[^a-z0-9])`,
      ).test(text),
    );

  /** Position of the LAST mention of any word, so later chat turns override earlier ones. */
  const last = (...words: string[]) =>
    Math.max(
      -1,
      ...words.map((w) => {
        const re = new RegExp(
          `(^|[^a-z0-9])${w.replace(/[.&]/g, "\\$&").replace(/\*$/, "[a-z]*")}($|[^a-z0-9])`,
          "g",
        );
        let at = -1;
        for (const m of text.matchAll(re)) at = m.index ?? at;
        return at;
      }),
    );
  const pickLatest = <T extends string>(
    options: [T, string[]][],
    fallback: T,
  ) => {
    const scored = options
      .map(([value, words]) => [value, last(...words)] as const)
      .filter(([, at]) => at >= 0)
      .sort((a, b) => b[1] - a[1]);
    return scored[0]?.[0] ?? fallback;
  };

  // Risk
  const riskProfile = pickLatest<RiskProfile>(
    [
      [
        "conservative",
        [
          "safe*",
          "conservative",
          "low risk",
          "low-risk",
          "defensive",
          "stable",
          "dividend*",
          "less risk*",
        ],
      ],
      [
        "aggressive",
        [
          "aggressive",
          "high risk",
          "high-risk",
          "moon",
          "degen",
          "momentum",
          "growth",
          "lever*",
          "more risk*",
        ],
      ],
      ["balanced", ["balanced", "moderate", "medium risk"]],
    ],
    "balanced",
  );

  // Universe — explicit tickers first
  const picked = new Map<string, StrategyAsset>();
  for (const token of prompt.match(/\$?[A-Za-z0-9.]{1,10}/g) ?? []) {
    const raw = token.replace(/^\$/, "");
    if (raw.length < 2 || raw !== raw.toUpperCase()) continue; // tickers are upper-case
    const asset = bySymbol.get(raw) ?? bySymbol.get(raw + ".");
    if (asset) picked.set(asset.symbol, asset);
  }
  const named: Record<string, string> = {
    apple: "AAPL",
    microsoft: "MSFT",
    nvidia: "NVDA",
    tesla: "TSLA",
    amazon: "AMZN",
    google: "GOOGL",
    reliance: "RELIANCE",
    infosys: "INFY",
  };
  for (const [word, sym] of Object.entries(named))
    if (has(word)) picked.set(sym, bySymbol.get(sym)!);

  // Any-case tickers or names next to a weight ("30%btc", "40% in sol") are explicit picks.
  const resolveToken = (token: string) => {
    const raw = token.replace(/^\$/, "");
    const up = raw.toUpperCase();
    const word = named[raw.toLowerCase()];
    return (
      bySymbol.get(up) ??
      bySymbol.get(up + ".") ??
      (word ? bySymbol.get(word) : undefined)
    );
  };
  const WEIGHTED =
    /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:in |of |into )?\$?([A-Za-z0-9.]{2,10})/g;
  for (const m of prompt.matchAll(WEIGHTED)) {
    const a = resolveToken(m[2]!);
    if (a) picked.set(a.symbol, a);
  }

  for (const [sector, symbols] of Object.entries(SECTORS))
    if (has(sector, `${sector}s`))
      for (const s of symbols)
        if (bySymbol.has(s)) picked.set(s, bySymbol.get(s)!);

  const marketWords: [Market, string[]][] = [
    ["india", ["india", "indian", "nse", "nifty"]],
    ["usa", ["us", "usa", "american", "nasdaq", "s&p", "wall street"]],
    ["uk", ["uk", "british", "london", "ftse"]],
    ["singapore", ["singapore", "sgx", "asean"]],
    ["europe", ["europe", "european", "eu", "dax", "germany"]],
  ];
  const markets = marketWords
    .filter(([, words]) => has(...words))
    .map(([m]) => m);
  if (has("global", "world*", "diversif*", "all markets"))
    markets.push("india", "usa", "uk", "singapore", "europe");

  // Filter sector picks to the mentioned markets, if both were given.
  if (picked.size && markets.length) {
    const scoped = [...picked.values()].filter((a) =>
      markets.includes(a.market),
    );
    if (scoped.length >= 2) {
      picked.clear();
      scoped.forEach((a) => picked.set(a.symbol, a));
    }
  }
  if (!picked.size) {
    const pool = markets.length
      ? markets
      : (["usa", "india", "europe"] as Market[]);
    for (const m of new Set(pool)) {
      const top = ASSETS.filter((a) => a.market === m).slice(
        0,
        m === "crypto" ? 2 : new Set(pool).size > 3 ? 2 : 3,
      );
      top.forEach((a) => picked.set(a.symbol, a));
    }
    if (!markets.length)
      assumptions.push(
        "No market named — defaulted to large caps in the US, India and Europe.",
      );
    else
      assumptions.push(
        "No specific assets named — used the largest listings in each market you mentioned.",
      );
  }

  const assetsList = [...picked.values()].slice(0, 12);
  if (picked.size > 12)
    assumptions.push(
      `Matched ${picked.size} assets — kept the first 12 to keep the basket focused.`,
    );
  const cryptoCap =
    riskProfile === "conservative" ? 10 : riskProfile === "balanced" ? 25 : 50;
  let universe = equalWeights(assetsList, cryptoCap);

  // Explicit weights like "60% BTC 40% ETH" override the equal split.
  const explicit = new Map<string, number>();
  for (const m of prompt.matchAll(WEIGHTED)) {
    const a = resolveToken(m[2]!);
    if (a && universe.some((u) => u.symbol === a.symbol))
      explicit.set(a.symbol, Number(m[1]));
  }
  if (explicit.size) {
    const fixed = [...explicit.values()].reduce((t, v) => t + v, 0);
    const rest = universe.filter((u) => !explicit.has(u.symbol));
    if (fixed <= 100) {
      universe = normalizeWeights(
        universe.map((u) => ({
          ...u,
          weight:
            explicit.get(u.symbol) ??
            (rest.length ? (100 - fixed) / rest.length : 0),
        })),
      ).filter((u) => u.weight > 0);
      assumptions.push("Used the explicit weights from your prompt.");
    }
  }
  if (
    !explicit.size &&
    assetsList.some((a) => a.market === "crypto") &&
    assetsList.some((a) => a.market !== "crypto")
  )
    assumptions.push(
      `Crypto is capped at ${cryptoCap}% of the strategy for a ${riskProfile} profile.`,
    );

  // Rebalance
  const frequency = pickLatest<Frequency>(
    [
      ["weekly", ["weekly", "week"]],
      ["monthly", ["monthly", "month"]],
      ["quarterly", ["quarter*"]],
    ],
    "monthly",
  );
  if (!has("weekly", "week", "quarter*", "monthly", "month"))
    assumptions.push(
      "Rebalances monthly — mention weekly or quarterly to change it.",
    );

  // Risk numbers
  /** Number captured by the latest match across several patterns. */
  const latestNumber = (patterns: RegExp[]) => {
    let best: { at: number; v: number } | null = null;
    for (const re of patterns)
      for (const m of text.matchAll(re))
        if (!best || (m.index ?? 0) >= best.at)
          best = { at: m.index ?? 0, v: Number(m[1]) };
    return best?.v ?? null;
  };
  const pct = (re: RegExp) =>
    latestNumber([
      new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"),
    ]);
  const stopLossPct =
    latestNumber([
      /stop[- ]?loss(?: of| at| to)?\s*(\d{1,2}(?:\.\d)?)\s*%/g,
      /(\d{1,2}(?:\.\d)?)\s*%\s*stop/g,
    ]) ??
    (riskProfile === "conservative" ? 8 : riskProfile === "balanced" ? 12 : 20);
  const takeProfitPct =
    pct(/take[- ]?profit(?: of| at)?\s*(\d{1,3})\s*%/) ??
    pct(/(\d{1,3})\s*%\s*(?:take[- ]?profit|profit)/);

  // Rules
  const rules: StrategyRule[] = [];
  if (has("rsi", "oversold", "overbought")) {
    rules.push({
      id: uid("r_"),
      appliesTo: "each_asset",
      when: { indicator: "rsi", period: 14, op: "<", value: 30 },
      then: { action: "increase", sizePct: 25 },
    });
    rules.push({
      id: uid("r_"),
      appliesTo: "each_asset",
      when: { indicator: "rsi", period: 14, op: ">", value: 70 },
      then: { action: "reduce", sizePct: 25 },
    });
  }
  if (has("dip*", "drawdown*", "crash*", "discount*")) {
    const dip = pct(/(\d{1,2})\s*%\s*(?:dip|drop|fall|drawdown)/) ?? 10;
    rules.push({
      id: uid("r_"),
      appliesTo: "each_asset",
      when: { indicator: "drawdown", lookbackDays: 30, op: ">", valuePct: dip },
      then: { action: "buy", sizePct: 20 },
    });
  }
  if (has("trend*", "moving average", "sma", "golden cross", "momentum")) {
    rules.push({
      id: uid("r_"),
      appliesTo: "each_asset",
      when: {
        indicator: "sma_cross",
        fast: 50,
        slow: 200,
        op: "crosses_below",
      },
      then: { action: "reduce", sizePct: 50 },
    });
    rules.push({
      id: uid("r_"),
      appliesTo: "each_asset",
      when: { indicator: "momentum", lookbackDays: 90, op: ">", valuePct: 10 },
      then: { action: "increase", sizePct: 15 },
    });
  }
  if (!rules.length)
    assumptions.push(
      "No entry/exit signals described — this is a pure target-weight portfolio with periodic rebalancing.",
    );

  const spec: StrategySpec = {
    schema: "atlas.strategy/v1",
    objective: prompt.trim().slice(0, 280),
    riskProfile,
    baseCurrency: "aUSDT",
    universe,
    rebalance: {
      frequency,
      driftTolerancePct: riskProfile === "aggressive" ? 8 : 5,
    },
    rules,
    risk: {
      stopLossPct,
      takeProfitPct,
      maxAssetWeightPct: Math.max(
        35,
        Math.ceil(Math.max(...universe.map((a) => a.weight), 0)),
      ),
      cashBufferPct: riskProfile === "conservative" ? 5 : 2,
    },
    execution: { minDeployment: 50, maxSlippageBps: 50 },
  };

  return {
    spec,
    ...suggestName(spec, text),
    assumptions,
    unsupported: unsupportedAssets(prompt),
  };
}

function suggestName(spec: StrategySpec, text: string) {
  const ms = [...new Set(spec.universe.map((a) => a.market))];
  const region =
    ms.length >= 4
      ? "Global"
      : ms.length === 1
        ? {
            india: "India",
            usa: "US",
            uk: "UK",
            singapore: "Singapore",
            europe: "Europe",
            crypto: "Crypto",
          }[ms[0]!]
        : ms.includes("crypto")
          ? "Hybrid"
          : "Multi-Market";
  const theme =
    Object.keys(SECTORS)
      .find((s) => new RegExp(`\\b${s}`).test(text))
      ?.replace(/^./, (c) => c.toUpperCase())
      .replace("Ai", "AI")
      .replace("Ev", "EV") ?? "";
  const style = spec.rules.some((r) => r.when.indicator === "sma_cross")
    ? "Momentum"
    : spec.rules.some((r) => r.when.indicator === "drawdown")
      ? "Value Dip"
      : spec.riskProfile === "conservative"
        ? "Income"
        : spec.riskProfile === "aggressive"
          ? "Growth"
          : "Balanced";
  return {
    suggestedName:
      `Atlas ${region} ${theme ? theme + " " : ""}${style} Fund`.replace(
        /\s+/g,
        " ",
      ),
    tagline: `${spec.universe.length} assets · ${spec.rebalance.frequency} rebalance · ${spec.riskProfile} risk`,
  };
}

export function validateSpec(value: unknown): {
  spec?: StrategySpec;
  error?: string;
} {
  const s = value as StrategySpec;
  if (!s || typeof s !== "object")
    return { error: "Spec must be a JSON object." };
  if (s.schema !== "atlas.strategy/v1")
    return { error: 'schema must be "atlas.strategy/v1".' };
  if (!Array.isArray(s.universe) || !s.universe.length)
    return { error: "universe needs at least one asset." };
  for (const a of s.universe) {
    if (!bySymbol.has(String(a.symbol).toUpperCase()))
      return { error: unsupportedMessage([String(a.symbol)]) };
    if (typeof a.weight !== "number" || a.weight < 0)
      return { error: `Invalid weight for ${a.symbol}.` };
  }
  const total = s.universe.reduce((t, a) => t + a.weight, 0);
  if (Math.abs(total - 100) > 0.5)
    return {
      error: `Weights sum to ${total.toFixed(1)}% — they must total 100%.`,
    };
  if (!["weekly", "monthly", "quarterly"].includes(s.rebalance?.frequency))
    return {
      error: "rebalance.frequency must be weekly, monthly or quarterly.",
    };
  if (!["conservative", "balanced", "aggressive"].includes(s.riskProfile))
    return { error: "riskProfile is invalid." };
  if (!Array.isArray(s.rules)) return { error: "rules must be an array." };
  if (!s.risk || typeof s.risk.maxAssetWeightPct !== "number")
    return { error: "risk block is missing." };
  return { spec: s };
}

export function describeRule(r: StrategyRule) {
  const who = r.appliesTo === "each_asset" ? "any asset" : r.appliesTo;
  const w = r.when;
  const cond =
    w.indicator === "rsi"
      ? `RSI(${w.period}) of ${who} ${w.op === "<" ? "drops below" : "rises above"} ${w.value}`
      : w.indicator === "sma_cross"
        ? `${w.fast}-day average of ${who} ${w.op === "crosses_above" ? "crosses above" : "crosses below"} its ${w.slow}-day average`
        : w.indicator === "drawdown"
          ? `${who} falls more than ${w.valuePct}% from its ${w.lookbackDays}-day high`
          : `${who} ${w.op === ">" ? "gains" : "loses"} more than ${w.valuePct}% over ${w.lookbackDays} days`;
  const act = { buy: "buy", sell: "sell", reduce: "trim", increase: "add to" }[
    r.then.action
  ];
  return `When ${cond}, ${act} it by ${r.then.sizePct}% of target weight.`;
}

// ───────────────────────────── Simulated performance ─────────────────────────────

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
export const daysSince = (iso: string) =>
  Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DAY));

export function simulate(
  spec: StrategySpec,
  seedKey: string,
  days: number,
  capital: number,
  mode: RunMode,
  startedAt: string,
): Performance {
  const rand = rng(hash(seedKey));
  const crypto =
    spec.universe
      .filter((a) => a.market === "crypto")
      .reduce((s, a) => s + a.weight, 0) / 100;
  const base = {
    conservative: [0.09, 0.1],
    balanced: [0.15, 0.17],
    aggressive: [0.24, 0.3],
  }[spec.riskProfile];
  const mu = base[0]! + crypto * 0.18 + (rand() - 0.45) * 0.16;
  const vol = base[1]! + crypto * 0.45;
  const stop = spec.risk.stopLossPct ? spec.risk.stopLossPct / 100 : 1;
  const curve = [100];
  let peak = 100,
    maxDd = 0;
  const daily: number[] = [];
  for (let d = 0; d < days; d++) {
    const z =
      Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    let r = mu / 365 + (vol / Math.sqrt(365)) * z;
    const prev = curve[curve.length - 1]!;
    if ((peak - prev) / peak > stop) r = Math.max(r, 0) * 0.3; // stop-loss parks risk
    const next = prev * (1 + r);
    curve.push(next);
    daily.push(r);
    peak = Math.max(peak, next);
    maxDd = Math.max(maxDd, (peak - next) / peak);
  }
  const last = curve[curve.length - 1]!;
  const returns = Object.fromEntries(
    PERIODS.map((p) => [
      p,
      days >= PERIOD_DAYS[p]
        ? last / curve[curve.length - 1 - PERIOD_DAYS[p]]! - 1
        : null,
    ]),
  ) as Record<Period, number | null>;
  const mean = daily.reduce((s, r) => s + r, 0) / (daily.length || 1);
  const sd =
    Math.sqrt(
      daily.reduce((s, r) => s + (r - mean) ** 2, 0) / (daily.length || 1),
    ) || 1;
  return {
    mode,
    days,
    capital,
    value: (capital * last) / 100,
    returns,
    totalReturn: last / 100 - 1,
    maxDrawdown: maxDd,
    sharpe: days > 20 ? ((mean - 0.04 / 365) / sd) * Math.sqrt(365) : 0,
    curve,
    startedAt,
  };
}

export function performanceFor(s: Strategy, mode: RunMode): Performance | null {
  const run = s.runs[mode];
  if (!run) return null;
  const days = mode === "backtest" ? 365 : daysSince(run.startedAt);
  return simulate(
    s.spec,
    `${s.id}:${mode}:${run.nonce}`,
    days,
    run.capital,
    mode,
    run.startedAt,
  );
}

export function positionPerformance(s: Strategy, p: Position) {
  return simulate(
    s.spec,
    `${s.id}:${p.id}`,
    daysSince(p.startedAt),
    p.capital,
    p.mode,
    p.startedAt,
  );
}

/** Best available track record for cards: live > paper > backtest. */
export function headlinePerformance(s: Strategy): Performance | null {
  return (
    performanceFor(s, "live") ??
    performanceFor(s, "paper") ??
    performanceFor(s, "backtest")
  );
}

export const creatorFee = (amount: number) =>
  (amount * CREATOR_FEE_BPS) / 10_000;

// ───────────────────────────── Seed marketplace ─────────────────────────────

const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const w = (pairs: [string, number][]): StrategyAsset[] =>
  pairs.map(([s, weight]) => ({ ...bySymbol.get(s)!, weight }));
const C = {
  meera: {
    address: "0x8a3f1c2b9e4d5a6b7c8d9e0f1a2b3c4d5e6f7a81",
    name: "meera.eth",
  },
  kai: {
    address: "0x1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b02",
    name: "0xkai.eth",
  },
  research: {
    address: "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765403",
    name: "atlasresearch.eth",
  },
  lena: {
    address: "0x2a4c6e8f0b1d3f5a7c9e1b3d5f7a9c1e3b5d7f04",
    name: "lena.eth",
  },
  rohan: {
    address: "0x7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c05",
    name: "rohan.eth",
  },
};

function seed(
  id: string,
  name: string,
  creator: Creator,
  prompt: string,
  overrides: Partial<StrategySpec> & { universe: StrategyAsset[] },
  stats: Strategy["stats"],
  runs: { paper?: number; live?: number; created: number },
  forkedFrom?: { strategy: string; name: string; root: Creator },
): Strategy {
  const generated = generateSpec(prompt);
  const spec: StrategySpec = {
    ...generated.spec,
    ...overrides,
    objective: prompt,
  };
  spec.risk = {
    ...spec.risk,
    maxAssetWeightPct: Math.max(
      35,
      ...spec.universe.map((a) => Math.ceil(a.weight)),
    ),
  };
  return {
    id,
    name,
    ens: strategyHandle(name, creator.name),
    icon: SEED_ICONS[id] ?? pickIcon(id, []),
    tagline: generated.tagline.replace(
      /^\d+ assets/,
      `${spec.universe.length} assets`,
    ),
    prompt,
    spec,
    visibility: "public",
    creator,
    originalCreator: forkedFrom?.root ?? creator,
    forkedFrom: forkedFrom
      ? {
          id: forkedFrom.strategy,
          name: forkedFrom.name,
          creator: forkedFrom.root.name,
        }
      : null,
    createdAt: ago(runs.created),
    updatedAt: ago(Math.min(runs.created, 12)),
    stats,
    runs: {
      backtest: {
        startedAt: ago(runs.created),
        capital: 10_000,
        nonce: "seed",
      },
      ...(runs.paper
        ? {
            paper: {
              startedAt: ago(runs.paper),
              capital: 10_000,
              nonce: "seed",
            },
          }
        : {}),
      ...(runs.live
        ? { live: { startedAt: ago(runs.live), capital: 2_500, nonce: "seed" } }
        : {}),
    },
  };
}

export const SEED_ICONS: Record<string, StrategyIcon> = {
  stg_global_ai: { name: "Cpu", color: "violet" },
  stg_india_bluechip: { name: "Landmark", color: "amber" },
  stg_us_megacap: { name: "Rocket", color: "orange" },
  stg_all_weather: { name: "Globe", color: "cyan" },
  stg_asean_banks: { name: "Crown", color: "green" },
  stg_euro_industrial: { name: "Factory", color: "blue" },
  stg_ai_banks_fork: { name: "Atom", color: "rose" },
  stg_uk_value: { name: "Shield", color: "blue" },
};

export function seedStrategies(): Strategy[] {
  return [
    seed(
      "stg_global_ai",
      "Atlas Global AI Leaders Fund",
      C.research,
      "Own the AI supply chain across the US and Europe — NVIDIA, Microsoft, Alphabet, ASML and SAP — with momentum trend filter, rebalance monthly, 12% stop loss.",
      {
        riskProfile: "aggressive",
        universe: w([
          ["NVDA", 25],
          ["MSFT", 20],
          ["GOOGL", 20],
          ["ASML", 20],
          ["SAP", 15],
        ]),
      },
      { clones: 184, deployers: 612, aum: 1_284_300, creatorEarnings: 1_284.3 },
      { paper: 410, live: 380, created: 430 },
    ),
    seed(
      "stg_india_bluechip",
      "Bharat Bluechip Dividend Fund",
      C.rohan,
      "Conservative Indian large caps for steady dividends: Reliance, HDFC Bank, ITC, Hindustan Unilever, TCS. Rebalance quarterly, 8% stop loss.",
      {
        universe: w([
          ["RELIANCE", 22],
          ["HDFCBANK", 22],
          ["ITC", 18],
          ["HINDUNILVR", 18],
          ["TCS", 20],
        ]),
      },
      { clones: 96, deployers: 341, aum: 642_900, creatorEarnings: 642.9 },
      { paper: 520, live: 400, created: 560 },
    ),
    seed(
      "stg_us_megacap",
      "US Megacap Dip Buyer Fund",
      C.kai,
      "Aggressive US megacaps: Apple, Microsoft, NVIDIA, Amazon, Tesla — buy the dip when any falls 15% drawdown, weekly rebalance.",
      {
        universe: w([
          ["AAPL", 20],
          ["MSFT", 20],
          ["NVDA", 25],
          ["AMZN", 20],
          ["TSLA", 15],
        ]),
      },
      { clones: 241, deployers: 903, aum: 2_110_500, creatorEarnings: 2_110.5 },
      { paper: 300, live: 200, created: 380 },
    ),
    seed(
      "stg_all_weather",
      "Atlas All-Weather Global Fund",
      C.meera,
      "Diversified global balanced portfolio across India, US, UK, Singapore and Europe. Monthly rebalance.",
      {
        universe: w([
          ["AAPL", 12],
          ["MSFT", 12],
          ["RELIANCE", 10],
          ["HDFCBANK", 10],
          ["HSBA", 10],
          ["SHEL", 8],
          ["D05", 10],
          ["SIE", 10],
          ["MC", 10],
          ["ASML", 8],
        ]),
      },
      { clones: 132, deployers: 455, aum: 918_000, creatorEarnings: 918 },
      { paper: 250, created: 420 },
    ),
    seed(
      "stg_asean_banks",
      "Lion City Banking Income Fund",
      C.lena,
      "Safe Singapore banks dividend income: DBS, OCBC, UOB with RSI oversold top-ups. Quarterly.",
      {
        universe: w([
          ["D05", 40],
          ["O39", 30],
          ["U11", 30],
        ]),
      },
      { clones: 38, deployers: 120, aum: 211_400, creatorEarnings: 211.4 },
      { paper: 150, created: 300 },
    ),
    seed(
      "stg_euro_industrial",
      "EuroStoxx Industrial Momentum Fund",
      C.research,
      "European industrial momentum — Siemens, Airbus, Rolls-Royce, Mercedes — moving average trend filter, monthly.",
      {
        universe: w([
          ["SIE", 30],
          ["AIR", 30],
          ["RR.", 20],
          ["MBG", 20],
        ]),
      },
      { clones: 22, deployers: 0, aum: 0, creatorEarnings: 0 },
      { created: 60 },
    ),
    seed(
      "stg_ai_banks_fork",
      "AI + Banks Barbell Fund",
      C.lena,
      "Fork of the Global AI Leaders with a banking sleeve: NVIDIA, Microsoft, ASML plus JPMorgan and HDFC Bank, momentum trend filter, aggressive.",
      {
        universe: w([
          ["NVDA", 25],
          ["MSFT", 20],
          ["ASML", 15],
          ["JPM", 25],
          ["HDFCBANK", 15],
        ]),
      },
      { clones: 17, deployers: 58, aum: 88_700, creatorEarnings: 88.7 },
      { paper: 120, live: 95, created: 140 },
      {
        strategy: "stg_global_ai",
        name: "Atlas Global AI Leaders Fund",
        root: C.research,
      },
    ),
    seed(
      "stg_uk_value",
      "Britannia Value Dip Fund",
      C.meera,
      "UK value stocks — Shell, BP, HSBC, Unilever, Diageo, GSK — buy the 10% dip, rebalance monthly, balanced risk.",
      {
        universe: w([
          ["SHEL", 18],
          ["BP.", 16],
          ["HSBA", 18],
          ["ULVR", 16],
          ["DGE", 16],
          ["GSK", 16],
        ]),
      },
      { clones: 41, deployers: 76, aum: 154_200, creatorEarnings: 154.2 },
      { paper: 200, created: 260 },
    ),
  ];
}

export const isEns = (name?: string | null) =>
  !!name && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(name);

/** `Atlas Global AI Leaders Fund` + `meera.eth` → `global-ai-leaders.meera.eth`. */
export function strategyHandle(name: string, ownerEns?: string | null) {
  if (!isEns(ownerEns)) return null;
  const slug = name
    .toLowerCase()
    .replace(/^atlas\s+/, "")
    .replace(/\s+fund$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug ? `${slug}.${ownerEns!.toLowerCase()}` : null;
}

export const sameAddress = (a?: string, b?: string) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function rootId(all: Strategy[], s: Strategy): string {
  let cur: Strategy | undefined = s;
  const seen = new Set<string>();
  while (cur?.forkedFrom && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent: Strategy | undefined = all.find(
      (x) => x.id === cur!.forkedFrom!.id,
    );
    if (!parent) break;
    cur = parent;
  }
  return cur?.id ?? s.id;
}

// ───────────────────────────── Formatting ─────────────────────────────

export const pct = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
export const usd = (v: number, digits = 2) =>
  v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
export const compact = (v: number) =>
  v.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });

// ───────────────────────────── Fund-style labels ─────────────────────────────

/** Fund-style category, e.g. "India Equity" + "Income", derived from the spec. */
export function strategyCategory(s: Strategy): {
  group: string;
  style: string;
} {
  const markets = [...new Set(s.spec.universe.map((a) => a.market))];
  const stocks = markets.filter((m) => m !== "crypto");
  const short: Record<Market, string> = {
    india: "India",
    usa: "US",
    uk: "UK",
    singapore: "Singapore",
    europe: "Europe",
    crypto: "Crypto",
  };
  const group = !stocks.length
    ? "Crypto"
    : markets.includes("crypto")
      ? "Hybrid Multi-Asset"
      : stocks.length >= 3
        ? "Global Equity"
        : stocks.length === 2
          ? `${short[stocks[0]!]} + ${short[stocks[1]!]} Equity`
          : `${short[stocks[0]!]} Equity`;
  const indicators = new Set(s.spec.rules.map((r) => r.when.indicator));
  const style = indicators.has("sma_cross")
    ? "Momentum"
    : indicators.has("drawdown")
      ? "Value Dip"
      : indicators.has("rsi")
        ? "Mean Reversion"
        : s.spec.riskProfile === "conservative"
          ? "Income"
          : s.spec.riskProfile === "aggressive"
            ? "Growth"
            : "Balanced";
  return { group, style };
}

export type RiskLevel = "Low" | "Moderate" | "High" | "Very High";
export function riskLevel(s: Strategy): RiskLevel {
  const crypto =
    s.spec.universe
      .filter((a) => a.market === "crypto")
      .reduce((t, a) => t + a.weight, 0) / 100;
  if (s.spec.riskProfile === "conservative")
    return crypto > 0.1 ? "Moderate" : "Low";
  if (s.spec.riskProfile === "balanced")
    return crypto >= 0.3 ? "High" : "Moderate";
  return crypto >= 0.4 ? "Very High" : "High";
}

/**
 * 1–5 star rating from the risk-adjusted return (Sharpe) of the best available
 * track record. Null until there are at least 90 days of history. Demo heuristic;
 * the backend should rate against category peers.
 */
export function strategyRating(perf: Performance | null): number | null {
  if (!perf || perf.days < 90) return null;
  const sh = perf.sharpe;
  return sh >= 2.5 ? 5 : sh >= 1.75 ? 4 : sh >= 1 ? 3 : sh >= 0.25 ? 2 : 1;
}
