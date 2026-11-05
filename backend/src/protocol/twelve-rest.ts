import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { MarketFeedConfig } from "./market-feed.js";

// Persist calls before requesting so restarting the worker cannot reset its
// daily allowance. Leave 100 of Basic's 800 credits for diagnostics/manual use.
export class RestBudget {
  constructor(
    private file: string,
    private limit = 700,
  ) {}
  take(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    let calls = 0;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved.day === day) {
        if (!Number.isSafeInteger(saved.calls) || saved.calls < 0) return false;
        calls = saved.calls;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    if (calls >= this.limit) return false;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ day, calls: calls + 1 }), {
      mode: 0o600,
    });
    renameSync(temporary, this.file);
    return true;
  }
}

export async function twelveRestQuote(
  key: string,
  stock: MarketFeedConfig["stocks"][number],
  signal?: AbortSignal,
) {
  const url = new URL("https://api.twelvedata.com/quote");
  url.searchParams.set("symbol", stock.symbol);
  url.searchParams.set("exchange", stock.exchange);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("apikey", key);
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  const quote = await response.json();
  if (response.status === 429 || quote.code === 429)
    return { rateLimited: true as const };
  if (!response.ok || quote.status === "error")
    throw Error("Twelve Data rejected a REST instrument.");
  // Bind each response to its request before accepting it into the cache.
  if (
    quote.symbol !== stock.symbol ||
    quote.exchange !== stock.exchange ||
    quote.currency !== stock.currency ||
    typeof quote.is_market_open !== "boolean"
  )
    throw Error("Twelve Data REST instrument or currency mismatch.");
  return { rateLimited: false as const, quote };
}
