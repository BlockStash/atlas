import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { CatalogStock } from "./country-catalog.js";
import {
  scaledPrice,
  type Currency,
  type PriceProvider,
  type PriceSnapshot,
} from "./price-service.js";

const currency = z.enum(["INR", "USD", "GBP", "SGD", "EUR"]);
export const marketFeedConfig = z.object({
  stocks: z
    .array(
      z.object({
        stockId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        symbol: z.string().min(1).max(50),
        exchange: z.string().min(1).max(50),
        currency,
        stream: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type MarketFeedConfig = z.infer<typeof marketFeedConfig>;
const timestamp = z.number().int().positive();
const price = z.string().refine((value) => {
  try {
    scaledPrice(value);
    return true;
  } catch {
    return false;
  }
});
const cacheSchema = z.object({
  source: z.literal("twelvedata-kraken-websocket"),
  demo: z.literal(false),
  stocks: z
    .array(
      z.object({
        stockId: z.string(),
        ticker: z.string(),
        nativePrice: price,
        currency,
        timestamp,
      }),
    )
    .max(100),
  fx: z.array(z.object({ currency, usdPerNative: price, timestamp })).max(5),
  usdt: z.object({ usdPrice: price, timestamp }).optional(),
});

export function validateFeedMapping(
  config: MarketFeedConfig,
  catalog: CatalogStock[],
) {
  const ids = new Set<string>(),
    instruments = new Set<string>();
  for (const row of config.stocks) {
    const stock = catalog.find((s) => s.stockId === row.stockId);
    const key = `${row.symbol}:${row.exchange}`;
    if (
      !stock ||
      stock.active === false ||
      stock.nativeCurrency !== row.currency ||
      ids.has(row.stockId) ||
      instruments.has(key)
    )
      throw Error(
        "Feed mapping must identify distinct active onchain stocks with matching native currencies.",
      );
    ids.add(row.stockId);
    instruments.add(key);
  }
}

// Both services emit JSON numbers. Quantize once to Atlas's eight-decimal
// price scale; integer arithmetic is used for all subsequent conversions.
export function feedDecimal(input: unknown): string {
  if (
    (typeof input !== "number" && typeof input !== "string") ||
    !/^\d+(\.\d+)?$/.test(String(input))
  )
    throw Error("Invalid feed price.");
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0 || value > 1e12)
    throw Error("Invalid feed price.");
  const result = value.toFixed(8);
  scaledPrice(result);
  return result;
}
function feedTime(input: unknown, now: number): number {
  const value =
    typeof input === "string" ? Math.floor(Date.parse(input) / 1000) : input;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > now
  )
    throw Error("Invalid feed observation timestamp.");
  return value;
}

export class MarketFeedCache {
  private data: PriceSnapshot = {
    source: "twelvedata-kraken-websocket",
    demo: false,
    stocks: [],
    fx: [],
  };
  constructor(
    private config: MarketFeedConfig,
    private catalog: CatalogStock[],
  ) {
    validateFeedMapping(config, catalog);
  }
  subscriptions() {
    const currencies = new Set(this.config.stocks.map((s) => s.currency));
    return [
      ...this.config.stocks
        .filter((s) => s.stream !== false)
        .map((s) => ({
          symbol: s.symbol,
          exchange: s.exchange,
        })),
      ...[...currencies]
        .filter((c) => c !== "USD")
        .map((c) => ({ symbol: `${c}/USD`, type: "Forex" })),
    ];
  }
  latest(stockId: string) {
    return this.data.stocks.find((s) => s.stockId === stockId)?.timestamp;
  }
  twelveQuote(message: unknown, now = Math.floor(Date.now() / 1000)): boolean {
    const quote = z
      .object({
        symbol: z.string(),
        exchange: z.string(),
        currency: z.string(),
        close: z.string(),
        last_quote_at: z.number().int().positive(),
      })
      .parse(message);
    return this.twelve(
      {
        event: "price",
        symbol: quote.symbol,
        exchange: quote.exchange,
        currency: quote.currency,
        price: quote.close,
        timestamp: quote.last_quote_at,
      },
      now,
    );
  }
  twelve(message: unknown, now = Math.floor(Date.now() / 1000)): boolean {
    const row = z
      .object({
        event: z.literal("price"),
        symbol: z.string(),
        exchange: z.string().optional(),
        currency: z.string().optional(),
        timestamp: z.number(),
        price: z.union([z.number(), z.string()]),
      })
      .safeParse(message);
    if (!row.success) return false;
    const tick = row.data;
    const mapping = this.config.stocks.find(
      (s) => s.symbol === tick.symbol && s.exchange === tick.exchange,
    );
    const fxCurrency = this.config.stocks
      .map((s) => s.currency)
      .find((c) => c !== "USD" && tick.symbol === `${c}/USD`);
    if (!mapping && !fxCurrency) return false;
    const observedAt = feedTime(tick.timestamp, now),
      value = feedDecimal(tick.price);
    if (mapping) {
      // Reject GBX/GBP (and other currency mismatches) rather than silently
      // pricing a pence quote as pounds. Map only verified native-currency feeds.
      if (tick.currency !== mapping.currency)
        throw Error(
          "Twelve Data quote currency does not match the configured stock.",
        );
      const previous = this.data.stocks.find(
        (s) => s.stockId === mapping.stockId,
      );
      if (previous && previous.timestamp >= observedAt) return false;
      this.data.stocks = this.data.stocks.filter(
        (s) => s.stockId !== mapping.stockId,
      );
      this.data.stocks.push({
        stockId: mapping.stockId,
        ticker: this.catalog.find((s) => s.stockId === mapping.stockId)!.ticker,
        currency: mapping.currency,
        nativePrice: value,
        timestamp: observedAt,
      });
    } else if (fxCurrency) {
      const previous = this.data.fx.find((f) => f.currency === fxCurrency);
      if (previous && previous.timestamp >= observedAt) return false;
      this.data.fx = this.data.fx.filter((f) => f.currency !== fxCurrency);
      this.data.fx.push({
        currency: fxCurrency,
        usdPerNative: value,
        timestamp: observedAt,
      });
    }
    return true;
  }
  kraken(message: unknown, now = Math.floor(Date.now() / 1000)): boolean {
    const parsed = z
      .object({
        channel: z.literal("trade"),
        type: z.enum(["snapshot", "update"]),
        data: z.array(
          z.object({
            symbol: z.string(),
            price: z.union([z.number(), z.string()]),
            timestamp: z.string(),
          }),
        ),
      })
      .safeParse(message);
    if (!parsed.success) return false;
    let changed = false;
    for (const tick of parsed.data.data) {
      if (tick.symbol !== "USDT/USD") continue;
      const observedAt = feedTime(tick.timestamp, now),
        usdPrice = feedDecimal(tick.price);
      const scaled = scaledPrice(usdPrice);
      if (scaled < 1000000n || scaled > 10000000000n)
        throw Error("USDT/USD is outside Atlas's permitted range.");
      if (this.data.usdt && this.data.usdt.timestamp >= observedAt) continue;
      this.data.usdt = { usdPrice, timestamp: observedAt };
      changed = true;
    }
    return changed;
  }
  save(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, file);
  }
}

// Only fresh, fully convertible observations are offered to the publisher.
// Closed-market quotes retain their original time and are never re-stamped.
export class StreamingPriceProvider implements PriceProvider {
  constructor(
    private file: string,
    private catalog: CatalogStock[],
    private maxAge = 900,
    private now = () => Math.floor(Date.now() / 1000),
  ) {}
  async snapshot(): Promise<PriceSnapshot> {
    let data;
    try {
      data = cacheSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      throw Error(
        "No valid streaming price cache. Start npm run prices:feed first.",
      );
    }
    const now = this.now();
    const fresh = (time: number) => time <= now && now - time < this.maxAge;
    if (!data.usdt || !fresh(data.usdt.timestamp))
      throw Error("Waiting for a fresh Kraken USDT/USD trade.");
    const fx = data.fx.filter(
      (row) => row.currency !== "USD" && fresh(row.timestamp),
    );
    // USD/USD is an identity, not a fabricated market observation.
    fx.push({ currency: "USD" as Currency, usdPerNative: "1", timestamp: now });
    const stocks = data.stocks.filter(
      (row) =>
        fresh(row.timestamp) &&
        fx.some((f) => f.currency === row.currency) &&
        this.catalog.some(
          (s) =>
            s.stockId === row.stockId &&
            s.ticker === row.ticker &&
            s.nativeCurrency === row.currency &&
            s.active !== false,
        ),
    );
    if (!stocks.length)
      throw Error(
        "No fresh stock/FX observations. Check exchange hours, subscriptions and Twelve Data plan access.",
      );
    return { ...data, stocks, fx };
  }
}

/** Indicative reference values only. Never passed to the executable quote path. */
export function readUsdtObservation(
  file: string,
  now = Math.floor(Date.now() / 1000),
  maxAge = 900,
) {
  try {
    const data = cacheSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return data.usdt &&
      data.usdt.timestamp <= now &&
      now - data.usdt.timestamp < maxAge
      ? data.usdt
      : null;
  } catch {
    return null;
  }
}
export function referencePrices(
  file: string,
  now = Math.floor(Date.now() / 1000),
) {
  const data = cacheSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (
    !data.usdt ||
    data.usdt.timestamp > now ||
    now - data.usdt.timestamp > 900
  )
    return [];
  return data.stocks.flatMap((stock) => {
    const fx =
      stock.currency === "USD"
        ? { usdPerNative: "1", timestamp: stock.timestamp }
        : data.fx.find((f) => f.currency === stock.currency);
    // Permit a recent trading-session close for display, including weekends.
    // Quotes older than seven days (or unavailable FX) are not displayed.
    if (
      !fx ||
      [stock.timestamp, fx.timestamp].some(
        (t) => t > now || now - t > 7 * 86400,
      )
    )
      return [];
    const price =
      (scaledPrice(stock.nativePrice) * scaledPrice(fx.usdPerNative)) /
      scaledPrice(data.usdt!.usdPrice);
    return [
      {
        stockId: stock.stockId,
        priceUSDT: price.toString(),
        timestamp: Math.min(stock.timestamp, fx.timestamp),
        usdtTimestamp: data.usdt!.timestamp,
        source: "Twelve Data / Kraken",
        indicative: true as const,
      },
    ];
  });
}
