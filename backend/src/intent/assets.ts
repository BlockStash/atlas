import catalog from "../protocol/catalog.json" with { type: "json" };

export interface CatalogAsset {
  stockId: string;
  symbol: string;
  companyName: string;
  exchange: string;
  region: string;
  country: string;
  currency: string;
  active: boolean;
}
export const assets: CatalogAsset[] = catalog.stocks.map((s) => ({
  stockId: s.stockId.toLowerCase(),
  symbol: s.ticker,
  companyName: s.companyName,
  exchange: s.exchange,
  region: s.region,
  country: s.country,
  currency: s.nativeCurrency,
  active: (s as { active?: boolean }).active !== false,
}));

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const ALIASES: Record<string, string> = {
  apple: "AAPL",
  microsoft: "MSFT",
  nvidia: "NVDA",
  amazon: "AMZN",
  google: "GOOGL",
  alphabet: "GOOGL",
  meta: "META",
  facebook: "META",
  tesla: "TSLA",
  netflix: "NFLX",
  tcs: "TCS",
  reliance: "RELIANCE",
  infosys: "INFY",
  "hdfc bank": "HDFCBANK",
  jpmorgan: "JPM",
  "jp morgan": "JPM",
  visa: "V",
  asml: "ASML",
  sap: "SAP",
  shell: "SHEL",
  hsbc: "HSBA",
};
const byNorm = new Map<string, CatalogAsset>();
for (const a of assets) {
  byNorm.set(norm(a.symbol), a);
  byNorm.set(norm(a.companyName), a);
  const first = norm(a.companyName).split(" ")[0];
  if (first && !byNorm.has(first)) byNorm.set(first, a);
}
for (const [k, v] of Object.entries(ALIASES)) {
  const a = assets.find((x) => x.symbol === v);
  if (a) byNorm.set(k, a);
}
/** Exact catalog resolution only; an unknown name returns undefined rather than a fuzzy guess. */
export function resolveAsset(nameOrSymbol: string): CatalogAsset | undefined {
  return byNorm.get(norm(nameOrSymbol));
}
export const assetByStockId = (id: string) =>
  assets.find((a) => a.stockId === id.toLowerCase());
/** Names the rule parser scans for in free text. Longest first so "hdfc bank" beats "hdfc". */
export const knownNames = [...byNorm.keys()].sort(
  (a, b) => b.length - a.length,
);
