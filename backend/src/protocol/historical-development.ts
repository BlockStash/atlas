import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits } from "viem";
import { z } from "zod";
import { readSessionSnapshot } from "./stock-sessions.js";
import type { CatalogStock } from "./country-catalog.js";
import {
  scaledPrice,
  type PriceProvider,
  type PriceSnapshot,
  type Currency,
} from "./price-service.js";

export function historicalDevelopmentMode() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ATLAS_DEVELOPMENT_MARKETS === "true" &&
    process.env.PRICE_SOURCE === "historical-development"
  );
}
export function assertHistoricalDevelopment(chainId: number) {
  if (!historicalDevelopmentMode() || ![11155111, 31337].includes(chainId))
    throw Error(
      "Historical development pricing requires an explicit development setting on Sepolia or a local chain, outside production.",
    );
}
export function readDevelopmentUsdt() {
  const row = z
    .object({
      source: z.string(),
      usdPrice: z.string(),
      timestamp: z.number().int().positive(),
    })
    .parse(
      JSON.parse(
        readFileSync(
          resolve(
            process.env.DEVELOPMENT_PRICE_BASIS_FILE ||
              "config/development-price-basis.json",
          ),
          "utf8",
        ),
      ),
    );
  const price = scaledPrice(row.usdPrice);
  if (
    price < 1000000n ||
    price > 10000000000n ||
    row.timestamp > Math.floor(Date.now() / 1000)
  )
    throw Error("Invalid fixed development USDT basis.");
  return row;
}
export function readReferenceFx() {
  const data = z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      base: z.literal("USD"),
      source: z.string(),
      sourceUrl: z.url(),
      nativePerUSD: z.object({
        USD: z.literal("1"),
        INR: z.string(),
        GBP: z.string(),
        SGD: z.string(),
        EUR: z.string(),
      }),
    })
    .parse(
      JSON.parse(
        readFileSync(
          resolve(process.env.FX_REFERENCE_FILE || "config/fx-reference.json"),
          "utf8",
        ),
      ),
    );
  for (const value of Object.values(data.nativePerUSD)) scaledPrice(value);
  return data;
}

/** A new test-quote lease based on a dated, immutable historical observation.
 * Publication time is not represented as the original market-data timestamp.
 * The original dates and source values remain in the reference snapshot.
 */
export class HistoricalDevelopmentProvider implements PriceProvider {
  constructor(
    private publishedAt: number,
    private stocks: CatalogStock[],
    private chainId: number,
  ) {}
  async snapshot(): Promise<PriceSnapshot> {
    assertHistoricalDevelopment(this.chainId);
    const data = readSessionSnapshot();
    const fx = readReferenceFx();
    const usdt = readDevelopmentUsdt();
    const rows = this.stocks
      .filter((s) => s.active !== false)
      .map((stock) => {
        const row = data.stocks.find(
          (s) =>
            s.stockId === stock.stockId &&
            s.ticker === stock.ticker &&
            s.exchange === stock.exchange &&
            s.currency === stock.nativeCurrency,
        );
        if (!row || row.sessionDate !== fx.date)
          throw Error(
            `No matching historical stock/FX session for ${stock.ticker}; keep the last valid snapshot or refresh references.`,
          );
        return {
          stockId: stock.stockId,
          ticker: stock.ticker,
          nativePrice: row.sessionClose,
          currency: row.currency,
          timestamp: this.publishedAt,
        };
      });
    return {
      source: `atlas-dev-history-${fx.date}`,
      demo: true,
      stocks: rows,
      fx: Object.entries(fx.nativePerUSD).map(([currency, rate]) => ({
        currency: currency as Currency,
        usdPerNative: formatUnits(10000000000000000n / scaledPrice(rate), 8),
        timestamp: this.publishedAt,
      })),
      usdt: { usdPrice: usdt.usdPrice, timestamp: this.publishedAt },
    };
  }
}
