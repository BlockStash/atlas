import { test } from "node:test";
import assert from "node:assert/strict";
import catalog from "../src/protocol/catalog.json" with { type: "json" };
import {
  HistoricalDevelopmentProvider,
  assertHistoricalDevelopment,
} from "../src/protocol/historical-development.js";
import { normalizeSnapshot } from "../src/protocol/price-service.js";
import { readSessionSnapshot } from "../src/protocol/stock-sessions.js";
import {
  parseHistory,
  normalizeHistoricalRows,
  robotsAllow,
  sourceUrl,
} from "../src/protocol/historical-scraper.js";

const reference = readSessionSnapshot().stocks.find(
  (s) => s.ticker === "HSBA",
)!;
const html = `<html><head><title>HSBC Holdings plc (LON:HSBA) Historical Stock Price Data</title></head><body>Currency is GBP · Price in GBX<table><thead><tr><th>Date</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Adj. Close</th></tr></thead><tbody><tr><td>Nov 5, 2026</td><td><span>1,335.40</span></td><td>1,341.20</td><td>1,286.40</td><td>1,307.40</td><td>1,307.40</td></tr><tr><td>Nov 4, 2026</td><td>1,283.00</td><td>1,324.60</td><td>1,281.60</td><td>1,318.20</td><td>1,310.77</td></tr></tbody></table></body></html>`;
test("historical parser validates listing and columns and converts pence without floats", () => {
  const rows = parseHistory(html, reference);
  const stock = normalizeHistoricalRows(reference, rows, "2026-11-05");
  assert.equal(stock.sessionOpen, "13.354");
  assert.equal(stock.sessionClose, "13.074");
  assert.equal(stock.previousClose, "13.182");
  assert.equal(stock.sessionDate, "2026-11-05");
  assert.throws(
    () => parseHistory(html.replace("LON:HSBA", "LON:OTHER"), reference),
    /identity/,
  );
  assert.throws(
    () =>
      parseHistory(
        html.replace("Currency is GBP", "Currency is USD"),
        reference,
      ),
    /currency/,
  );
  assert.throws(
    () =>
      parseHistory(html.replace("<th>Close</th>", "<th>Wrong</th>"), reference),
    /columns/,
  );
  assert.throws(
    () => normalizeHistoricalRows(reference, rows, "2026-11-04"),
    /preceding/,
  );
});
test("source fetches are restricted to saved public history URLs and crawling rules", () => {
  assert.equal(sourceUrl(reference.sourceUrl).hostname, "stockanalysis.com");
  for (const url of [
    "http://stockanalysis.com/stocks/aapl/history/",
    "https://example.com/stocks/aapl/history/",
    "https://stockanalysis.com/e/private/",
    "https://stockanalysis.com/stocks/aapl/history/?next=localhost",
  ])
    assert.throws(() => sourceUrl(url));
  const robots =
    "User-agent: *\nDisallow: /e/\nDisallow: /p/\n\nUser-agent: dotbot\nDisallow: /";
  assert.equal(robotsAllow(robots, "/quote/lon/HSBA/history/"), true);
  assert.equal(robotsAllow(robots, "/e/private"), false);
  assert.equal(
    robotsAllow("User-agent: *\nDisallow: /quote/", "/quote/lon/HSBA/history/"),
    false,
  );
});
test("fixed test quotes cover the active catalog and retain historical provenance instead of claiming live data", async () => {
  const original = {
    source: process.env.PRICE_SOURCE,
    flag: process.env.ATLAS_DEVELOPMENT_MARKETS,
    node: process.env.NODE_ENV,
  };
  process.env.PRICE_SOURCE = "historical-development";
  process.env.ATLAS_DEVELOPMENT_MARKETS = "true";
  process.env.NODE_ENV = "development";
  try {
    const lease = Math.floor(Date.now() / 1000);
    const snapshot = await new HistoricalDevelopmentProvider(
      lease,
      catalog.stocks,
      11155111,
    ).snapshot();
    const normalized = normalizeSnapshot(snapshot, lease, 86400);
    assert.equal(normalized.demo, true);
    assert.equal(normalized.stocks.length, 50);
    assert.match(normalized.source, /^atlas-dev-history-\d{4}-\d{2}-\d{2}$/);
    assert.ok(snapshot.stocks.every((s) => s.timestamp === lease));
    assert.ok(
      readSessionSnapshot().stocks.every(
        (s) => Date.parse(s.sessionDate) < lease * 1000,
      ),
    );
    assert.throws(() => assertHistoricalDevelopment(1), /development setting/);
    process.env.NODE_ENV = "production";
    await assert.rejects(
      new HistoricalDevelopmentProvider(
        lease,
        catalog.stocks,
        11155111,
      ).snapshot(),
      /outside production/,
    );
  } finally {
    for (const [key, value] of Object.entries({
      PRICE_SOURCE: original.source,
      ATLAS_DEVELOPMENT_MARKETS: original.flag,
      NODE_ENV: original.node,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
