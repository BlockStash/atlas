import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseUnits } from "viem";
import catalog from "./catalog.json" with { type: "json" };
import type { CatalogStock } from "./country-catalog.js";
export type Currency = "INR" | "USD" | "GBP" | "SGD" | "EUR";
export interface StockPriceInput {
  stockId: string;
  ticker: string;
  nativePrice: string;
  currency: Currency;
  timestamp: number;
}
export interface FxInput {
  currency: Currency;
  usdPerNative: string;
  timestamp: number;
}
export interface PriceSnapshot {
  source: string;
  demo: boolean;
  stocks: StockPriceInput[];
  fx: FxInput[];
  usdt?: { usdPrice: string; timestamp: number };
}
export interface PriceProvider {
  snapshot(): Promise<PriceSnapshot>;
}
export function scaledPrice(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(value))
    throw new Error(
      "Prices must be nonnegative decimal strings with at most eight fractional digits.",
    );
  const scaled = parseUnits(value, 8);
  if (scaled <= 0n || scaled > 10n ** 20n)
    throw new Error("Price is zero or exceeds the POC bound.");
  return scaled;
}
export class DemoPriceProvider implements PriceProvider {
  constructor(
    private observedAt?: number,
    private stocks: CatalogStock[] = catalog.stocks,
  ) {}
  async snapshot(): Promise<PriceSnapshot> {
    const timestamp = this.observedAt ?? Math.floor(Date.now() / 1000);
    return {
      source: "atlas-demo-fixture",
      demo: true,
      stocks: this.stocks
        .filter((s) => s.active !== false && s.demoNativePrice !== "0")
        .map((s) => ({
          stockId: s.stockId,
          ticker: s.ticker,
          nativePrice: s.demoNativePrice,
          currency: s.nativeCurrency as Currency,
          timestamp,
        })),
      usdt: { usdPrice: "1", timestamp },
      fx: Object.entries(catalog.fx).map(([currency, usdPerNative]) => ({
        currency: currency as Currency,
        usdPerNative,
        timestamp,
      })),
    };
  }
}
export class HttpPriceProvider implements PriceProvider {
  constructor(
    private url: string,
    private token?: string,
  ) {}
  async snapshot(): Promise<PriceSnapshot> {
    const response = await fetch(this.url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error("The market-data provider could not supply a snapshot.");
    return (await response.json()) as PriceSnapshot;
  }
}
export function normalizeSnapshot(
  input: PriceSnapshot,
  now = Math.floor(Date.now() / 1000),
  maxAge = 900,
  registered: CatalogStock[] = catalog.stocks,
) {
  if (
    !input ||
    !input.source ||
    input.source.length > 100 ||
    typeof input.demo !== "boolean" ||
    !Array.isArray(input.fx) ||
    !Array.isArray(input.stocks) ||
    input.stocks.length > 100 ||
    input.fx.length > 10
  )
    throw new Error("Invalid price snapshot.");
  const time = (timestamp: number) => {
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp <= 0 ||
      timestamp > now ||
      now - timestamp > maxAge
    )
      throw new Error("Market data is stale or has a future timestamp.");
    return timestamp;
  };
  if (!input.demo && !input.usdt)
    throw new Error("Provider snapshots require a USD price for USDT.");
  const usdtPrice = scaledPrice(input.usdt?.usdPrice ?? "1");
  if (usdtPrice < 1000000n || usdtPrice > 10000000000n)
    throw new Error("Invalid USD/USDT observation.");
  const usdtTimestamp = time(input.usdt?.timestamp ?? now);
  const fx = new Map<Currency, { rate: bigint; timestamp: number }>();
  for (const rate of input.fx) {
    if (!Object.hasOwn(catalog.fx, rate.currency) || fx.has(rate.currency))
      throw new Error("Invalid or duplicate FX currency.");
    const value = scaledPrice(rate.usdPerNative);
    if (value > 10n ** 16n || (rate.currency === "USD" && value !== 100000000n))
      throw new Error("Invalid USD conversion rate.");
    fx.set(rate.currency, { rate: value, timestamp: time(rate.timestamp) });
  }
  const seen = new Set<string>();
  const stocks = input.stocks.map((row) => {
    const stock = registered.find((s) => s.stockId === row.stockId);
    if (
      !stock ||
      row.ticker !== stock.ticker ||
      stock.nativeCurrency !== row.currency ||
      seen.has(row.stockId)
    )
      throw new Error(
        "Stock feed or currency does not match the registered catalog.",
      );
    seen.add(row.stockId);
    const rate = fx.get(row.currency);
    if (!rate) throw new Error("Missing FX rate for stock.");
    const nativePrice = scaledPrice(row.nativePrice),
      timestamp = time(row.timestamp),
      usdPrice = (nativePrice * rate.rate) / 100000000n;
    if (usdPrice === 0n) throw new Error("Normalized price rounds to zero.");
    if ((usdPrice * 100000000n) / usdtPrice === 0n)
      throw new Error("Normalized USDT price rounds to zero.");
    return {
      ...row,
      nativePrice,
      usdPrice,
      usdtPrice: (usdPrice * 100000000n) / usdtPrice,
      fxRate: rate.rate,
      timestamp,
      validUntil: Math.min(timestamp, rate.timestamp, usdtTimestamp) + maxAge,
    };
  });
  if (stocks.length === 0)
    throw new Error("A snapshot needs at least one stock.");
  return {
    usdt: { price: usdtPrice, timestamp: usdtTimestamp },
    source: input.source,
    demo: input.demo,
    stocks,
    fx: [...fx].map(([currency, row]) => ({
      currency,
      ...row,
      validUntil: row.timestamp + maxAge,
    })),
  };
}
export class PriceHistoryStore {
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS prices(stock_id TEXT NOT NULL,timestamp INTEGER NOT NULL,native_price TEXT NOT NULL,usd_price TEXT NOT NULL,fx_rate TEXT NOT NULL,source TEXT NOT NULL,demo INTEGER NOT NULL,tx_hash TEXT,PRIMARY KEY(stock_id,timestamp,source));",
    );
    const columns = this.db.prepare("PRAGMA table_info(prices)").all();
    if (!columns.some((c) => c.name === "usdt_price"))
      this.db.exec("ALTER TABLE prices ADD COLUMN usdt_price TEXT");
  }
  record(snapshot: ReturnType<typeof normalizeSnapshot>, txHash?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO prices(stock_id,timestamp,native_price,usd_price,fx_rate,source,demo,tx_hash,usdt_price) VALUES(?,?,?,?,?,?,?,?,?)",
      );
      for (const stock of snapshot.stocks)
        insert.run(
          stock.stockId,
          stock.timestamp,
          stock.nativePrice.toString(),
          stock.usdPrice.toString(),
          stock.fxRate.toString(),
          snapshot.source,
          snapshot.demo ? 1 : 0,
          txHash ?? null,
          stock.usdtPrice.toString(),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  history(stockId: string, limit = 100) {
    return this.db
      .prepare(
        "SELECT * FROM prices WHERE stock_id=? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(stockId, Math.min(500, Math.max(1, limit)));
  }
  close() {
    this.db.close();
  }
}
