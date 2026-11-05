import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import catalog from "./catalog.json" with { type: "json" };
import { scaledPrice } from "./price-service.js";
import { RestBudget } from "./twelve-rest.js";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => Number.isFinite(Date.parse(d)));
const decimal = z.string().refine((s) => {
  try {
    scaledPrice(s);
    return true;
  } catch {
    return false;
  }
});
export const sessionSnapshot = z.object({
  version: z.literal(1),
  retrievedAt: z.iso.datetime(),
  method: z.string(),
  stocks: z
    .array(
      z.object({
        stockId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        ticker: z.string(),
        region: z.string(),
        exchange: z.string(),
        currency: z.enum(["INR", "USD", "GBP", "SGD", "EUR"]),
        sourceUnit: z.enum(["INR", "USD", "GBP", "GBX", "SGD", "EUR"]),
        sessionDate: date,
        sessionOpen: decimal,
        sessionClose: decimal,
        previousSessionDate: date,
        previousClose: decimal,
        sourceSessionOpen: decimal,
        sourceSessionClose: decimal,
        sourcePreviousClose: decimal,
        source: z.string().min(1),
        sourceUrl: z.url().refine((url) => new URL(url).protocol === "https:"),
        sourceAsOf: z.string().min(1),
      }),
    )
    .max(1000),
});
export function readSessionSnapshot(
  file = resolve(
    process.env.WEB_REFERENCE_FILE || "config/web-market-reference.json",
  ),
  now = Date.now(),
) {
  const data = sessionSnapshot.parse(JSON.parse(readFileSync(file, "utf8")));
  if (Date.parse(data.retrievedAt) > now + 60000)
    throw Error("Reference retrieval date is in the future.");
  const seen = new Set<string>();
  for (const row of data.stocks) {
    const stock = catalog.stocks.find((s) => s.stockId === row.stockId);
    if (
      !stock ||
      stock.ticker !== row.ticker ||
      stock.region !== row.region ||
      stock.exchange !== row.exchange ||
      stock.nativeCurrency !== row.currency ||
      seen.has(row.stockId)
    )
      throw Error(
        "Historical reference does not match a unique stock listing.",
      );
    if (
      row.previousSessionDate >= row.sessionDate ||
      Date.parse(row.sessionDate) > now
    )
      throw Error("Invalid historical session ordering.");
    if (
      row.sourceUnit !== row.currency &&
      !(row.sourceUnit === "GBX" && row.currency === "GBP")
    )
      throw Error("Unsupported reference quote units.");
    const factor = row.sourceUnit === "GBX" ? 100n : 1n;
    if (
      scaledPrice(row.sessionOpen) !==
        scaledPrice(row.sourceSessionOpen) / factor ||
      scaledPrice(row.sessionClose) !==
        scaledPrice(row.sourceSessionClose) / factor ||
      scaledPrice(row.previousClose) !==
        scaledPrice(row.sourcePreviousClose) / factor
    )
      throw Error("Reference price does not match its source units.");
    seen.add(row.stockId);
  }
  return data;
}

const marketState = z.object({
  code: z.string(),
  name: z.string(),
  is_market_open: z.boolean(),
  time_to_open: z.string().regex(/^\d+:\d{2}:\d{2}$/),
  time_to_close: z.string().regex(/^\d+:\d{2}:\d{2}$/),
});
const statusSnapshot = z.object({
  observedAt: z.number().int(),
  validUntil: z.number().int(),
  states: z.array(marketState).max(500),
});
type StatusSnapshot = z.infer<typeof statusSnapshot>;
export const exchangeCode: Record<string, string> = {
  NSE: "XNSE",
  NASDAQ: "XNAS",
  NYSE: "XNYS",
  LSE: "XLON",
  SGX: "XSES",
  XETRA: "XETR",
  "Euronext Amsterdam": "XAMS",
  "Euronext Paris": "XPAR",
};
export function stockMarketStatus(
  exchange: string,
  data: StatusSnapshot,
  now = Math.floor(Date.now() / 1000),
) {
  const row = data.states.find((s) => s.code === exchangeCode[exchange]);
  return {
    state:
      row && data.observedAt <= now && data.validUntil > now
        ? row.is_market_open
          ? ("open" as const)
          : ("closed" as const)
        : ("unknown" as const),
    observedAt: data.observedAt || null,
    validUntil: data.validUntil,
    source: "Twelve Data",
    sourceUrl: "https://twelvedata.com/docs/markets/market-state",
  };
}

export class MarketStatusService {
  private pending?: Promise<StatusSnapshot>;
  private retryAt = 0;
  constructor(
    private file = resolve(
      process.env.MARKET_STATUS_FILE || "data/market-status.json",
    ),
  ) {}
  async snapshot(): Promise<StatusSnapshot> {
    const now = Math.floor(Date.now() / 1000);
    let cached: StatusSnapshot = { observedAt: 0, validUntil: 0, states: [] };
    try {
      cached = statusSnapshot.parse(
        JSON.parse(readFileSync(this.file, "utf8")),
      );
    } catch {}
    if (cached.observedAt <= now && cached.validUntil > now) return cached;
    if (this.pending) return this.pending;
    if (now < this.retryAt || !process.env.TWELVE_DATA_API_KEY) return cached;
    this.pending = (async () => {
      if (!new RestBudget(`${this.file}.budget.json`, 96).take()) return cached;
      const url = new URL("https://api.twelvedata.com/market_state");
      url.searchParams.set("apikey", process.env.TWELVE_DATA_API_KEY!);
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw Error("Market status unavailable.");
      const states = z
        .array(marketState)
        .max(500)
        .parse(await response.json())
        .filter((s) => Object.values(exchangeCode).includes(s.code));
      const observedAt = Math.floor(Date.now() / 1000);
      // Expire at the next reported opening/closing, even if within the
      // 15-minute cache window. Do not keep an 'open' badge past that boundary.
      const transitions = states
        .map((s) =>
          (s.is_market_open ? s.time_to_close : s.time_to_open)
            .split(":")
            .map(Number)
            .reduce((total, part) => total * 60 + part, 0),
        )
        .filter((s) => s > 0);
      const data = {
        observedAt,
        validUntil: observedAt + Math.min(900, ...transitions),
        states,
      };
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      renameSync(temporary, this.file);
      return data;
    })()
      .catch(() => {
        this.retryAt = now + 60;
        return cached;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
