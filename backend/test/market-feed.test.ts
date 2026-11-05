import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import catalog from "../src/protocol/catalog.json" with { type: "json" };
import {
  MarketFeedCache,
  StreamingPriceProvider,
  feedDecimal,
  marketFeedConfig,
  referencePrices,
} from "../src/protocol/market-feed.js";
import { RestBudget } from "../src/protocol/twelve-rest.js";
import { normalizeSnapshot } from "../src/protocol/price-service.js";

const apple = catalog.stocks.find((s) => s.ticker === "AAPL")!;
const shell = catalog.stocks.find((s) => s.region === "uk")!;
const now = 1800000000;

test("REST uses the provider's last-minute timestamp, never the fetch time or daily candle opening", async () => {
  await withCache(async (cache, file) => {
    cache.twelveQuote(
      {
        symbol: "AAPL",
        exchange: "NASDAQ",
        currency: "USD",
        close: "250.12",
        timestamp: now - 86400,
        last_quote_at: now - 3600,
      },
      now,
    );
    cache.kraken(kraken(1, now), now);
    cache.save(file);
    const references = referencePrices(file, now);
    assert.equal(references.length, 1);
    assert.equal(references[0]!.priceUSDT, "25012000000");
    assert.equal(references[0]!.timestamp, now - 3600);
    assert.equal(references[0]!.indicative, true);
    await assert.rejects(
      new StreamingPriceProvider(
        file,
        catalog.stocks,
        900,
        () => now,
      ).snapshot(),
      /No fresh stock/,
    );
    assert.throws(() =>
      cache.twelveQuote(
        {
          symbol: "AAPL",
          exchange: "NASDAQ",
          currency: "USD",
          close: "250",
          timestamp: now,
        },
        now,
      ),
    );
    assert.deepEqual(referencePrices(file, now + 901), []);
  });
});

test("REST budget survives worker restarts, resets at UTC midnight and caps requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-rest-budget-"));
  try {
    const file = join(directory, "budget.json");
    const time = Date.UTC(2026, 10, 6, 12);
    assert.equal(new RestBudget(file, 2).take(time), true);
    assert.equal(new RestBudget(file, 2).take(time), true);
    assert.equal(new RestBudget(file, 2).take(time), false);
    assert.equal(new RestBudget(file, 2).take(time + 86400000), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
const config = marketFeedConfig.parse({
  stocks: [
    {
      stockId: apple.stockId,
      symbol: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
    },
    {
      stockId: shell.stockId,
      symbol: shell.ticker,
      exchange: "LSE",
      currency: "GBP",
    },
  ],
});
const tick = (extra = {}) => ({
  event: "price",
  symbol: "AAPL",
  exchange: "NASDAQ",
  currency: "USD",
  timestamp: now - 5,
  price: 250,
  ...extra,
});
const kraken = (price = 0.98, time = now - 2, symbol = "USDT/USD") => ({
  channel: "trade",
  type: "update",
  data: [{ symbol, price, timestamp: new Date(time * 1000).toISOString() }],
});

async function withCache(
  run: (cache: MarketFeedCache, file: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-stream-"));
  try {
    await run(
      new MarketFeedCache(config, catalog.stocks),
      join(directory, "feed.json"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("streamed stock + direct native/USD FX + depegged USDT normalize into exact contract units", async () => {
  await withCache(async (cache, file) => {
    cache.twelve(tick(), now);
    cache.twelve(
      tick({
        symbol: shell.ticker,
        exchange: "LSE",
        currency: "GBP",
        price: 20,
      }),
      now,
    );
    cache.twelve(
      { event: "price", symbol: "GBP/USD", price: 1.25, timestamp: now - 3 },
      now,
    );
    cache.kraken(kraken(), now);
    cache.save(file);
    const snapshot = await new StreamingPriceProvider(
      file,
      catalog.stocks,
      900,
      () => now,
    ).snapshot();
    const normalized = normalizeSnapshot(snapshot, now);
    assert.equal(snapshot.demo, false);
    assert.equal(
      normalized.stocks.find((s) => s.stockId === apple.stockId)!.usdtPrice,
      (25000000000n * 100000000n) / 98000000n,
    );
    assert.equal(
      normalized.stocks.find((s) => s.stockId === shell.stockId)!.usdPrice,
      2500000000n,
    );
    assert.equal(normalized.stocks[0]!.validUntil, now - 5 + 900);
    assert.deepEqual(cache.subscriptions().at(-1), {
      symbol: "GBP/USD",
      type: "Forex",
    });
  });
});

test("wrong venues, currencies, future times, unrelated crypto pairs and reordered messages never replace valid quotes", async () => {
  await withCache(async (cache, file) => {
    assert.equal(cache.twelve(tick({ exchange: "OTHER" }), now), false);
    assert.throws(
      () => cache.twelve(tick({ currency: "GBX" }), now),
      /currency/,
    );
    assert.throws(
      () => cache.twelve(tick({ timestamp: now + 1 }), now),
      /timestamp/,
    );
    cache.twelve(tick(), now);
    assert.equal(
      cache.twelve(tick({ timestamp: now - 6, price: 1 }), now),
      false,
    );
    assert.equal(cache.kraken(kraken(60000, now, "BTC/USD"), now), false);
    cache.kraken(kraken(), now);
    assert.equal(cache.kraken(kraken(1, now - 10), now), false);
    assert.throws(() => cache.kraken(kraken(0), now), /price/);
    cache.save(file);
    const snapshot = await new StreamingPriceProvider(
      file,
      catalog.stocks,
      900,
      () => now,
    ).snapshot();
    assert.equal(snapshot.stocks[0]!.nativePrice, "250.00000000");
    assert.equal(snapshot.usdt!.usdPrice, "0.98000000");
  });
});

test("closed-market and disconnected observations expire without re-stamping or fixture fallback", async () => {
  await withCache(async (cache, file) => {
    cache.twelve(tick(), now);
    cache.kraken(kraken(), now);
    cache.save(file);
    await assert.rejects(
      new StreamingPriceProvider(
        file,
        catalog.stocks,
        900,
        () => now + 1000,
      ).snapshot(),
      /fresh Kraken/,
    );
    cache.kraken(kraken(1, now + 1000), now + 1000);
    cache.save(file);
    await assert.rejects(
      new StreamingPriceProvider(
        file,
        catalog.stocks,
        900,
        () => now + 1000,
      ).snapshot(),
      /No fresh stock/,
    );
  });
});

test("missing FX excludes the affected market while fresh AAPL remains publishable", async () => {
  await withCache(async (cache, file) => {
    cache.twelve(tick(), now);
    cache.twelve(
      tick({ symbol: shell.ticker, exchange: "LSE", currency: "GBP" }),
      now,
    );
    cache.kraken(kraken(), now);
    cache.save(file);
    const snapshot = await new StreamingPriceProvider(
      file,
      catalog.stocks,
      900,
      () => now,
    ).snapshot();
    assert.deepEqual(
      snapshot.stocks.map((s) => s.stockId),
      [apple.stockId],
    );
  });
});

test("invalid or duplicate feed mappings and missing cache fail explicitly", async () => {
  assert.throws(
    () =>
      new MarketFeedCache(
        { stocks: [config.stocks[0]!, config.stocks[0]!] },
        catalog.stocks,
      ),
    /distinct/,
  );
  assert.throws(
    () =>
      new MarketFeedCache(
        { stocks: [{ ...config.stocks[0]!, currency: "GBP" }] },
        catalog.stocks,
      ),
    /currencies/,
  );
  await withCache(async (_, file) => {
    await assert.rejects(
      new StreamingPriceProvider(file, catalog.stocks).snapshot(),
      /Start npm run prices:feed/,
    );
  });
  for (const invalid of [0, -1, Infinity, "NaN", "1e9", null])
    assert.throws(() => feedDecimal(invalid));
});
