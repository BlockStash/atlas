import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readSessionSnapshot,
  MarketStatusService,
  stockMarketStatus,
} from "../src/protocol/stock-sessions.js";
const sourceFile = resolve("config/web-market-reference.json");
const checkedAt = Date.UTC(2026, 10, 6, 12);

test("researched session data covers all fifty listings and preserves source currencies and dates", () => {
  const data = readSessionSnapshot(sourceFile, checkedAt);
  assert.equal(data.stocks.length, 50);
  assert.equal(new Set(data.stocks.map((s) => s.stockId)).size, 50);
  for (const region of ["india", "usa", "uk", "singapore", "europe"])
    assert.equal(data.stocks.filter((s) => s.region === region).length, 10);
  for (const stock of data.stocks) {
    assert.ok(stock.sourceUrl.startsWith("https://stockanalysis.com/"));
    assert.ok(stock.previousSessionDate < stock.sessionDate);
  }
  const hsbc = data.stocks.find((s) => s.ticker === "HSBA")!;
  assert.equal(hsbc.sourceUnit, "GBX");
  assert.equal(hsbc.sourceSessionOpen, "1335.40");
  assert.equal(hsbc.sessionOpen, "13.35400000");
  assert.equal(hsbc.currency, "GBP");
});

test("incorrect listing, quote-unit conversion and future dates cannot enter the reference view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-sessions-"));
  try {
    const file = join(directory, "reference.json");
    const source = JSON.parse(await readFile(sourceFile, "utf8"));
    for (const mutate of [
      (data: typeof source) => {
        data.stocks[0].ticker = "WRONG";
      },
      (data: typeof source) => {
        data.stocks.push(data.stocks[0]);
      },
      (data: typeof source) => {
        data.stocks[0].sessionClose = "1";
      },
      (data: typeof source) => {
        data.stocks[0].sessionDate = "2030-01-01";
      },
    ]) {
      const data = structuredClone(source);
      mutate(data);
      await writeFile(file, JSON.stringify(data));
      assert.throws(() => readSessionSnapshot(file, checkedAt));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exchange status expires at its boundary and never substitutes a different listing's state", () => {
  const snapshot = {
    observedAt: 100,
    validUntil: 150,
    states: [
      {
        code: "XLON",
        name: "LSE",
        is_market_open: true,
        time_to_open: "00:00:00",
        time_to_close: "00:00:50",
      },
    ],
  };
  assert.equal(stockMarketStatus("LSE", snapshot, 149).state, "open");
  assert.equal(stockMarketStatus("LSE", snapshot, 150).state, "unknown");
  assert.equal(stockMarketStatus("NSE", snapshot, 149).state, "unknown");
  assert.equal(stockMarketStatus("LSE", snapshot, 99).state, "unknown");
});

test("market-status requests share one provider call, persist across service instances and fail to unknown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-market-status-"));
  const original = process.env.TWELVE_DATA_API_KEY;
  process.env.TWELVE_DATA_API_KEY = "test-only";
  let calls = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      JSON.stringify([
        {
          code: "XNAS",
          name: "NASDAQ",
          is_market_open: false,
          time_to_open: "01:00:00",
          time_to_close: "00:00:00",
        },
      ]),
    );
  });
  try {
    const file = join(directory, "status.json");
    const service = new MarketStatusService(file);
    const [first, second] = await Promise.all([
      service.snapshot(),
      service.snapshot(),
    ]);
    assert.deepEqual(first, second);
    assert.equal(calls, 1);
    assert.equal(stockMarketStatus("NASDAQ", first).state, "closed");
    await new MarketStatusService(file).snapshot();
    assert.equal(calls, 1);
    await writeFile(
      file,
      JSON.stringify({ ...first, validUntil: first.observedAt - 1 }),
    );
    fetchMock.mock.mockImplementation(async () => {
      throw Error("offline");
    });
    const failed = await new MarketStatusService(file).snapshot();
    assert.equal(stockMarketStatus("NASDAQ", failed).state, "unknown");
  } finally {
    fetchMock.mock.restore();
    if (original === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = original;
    await rm(directory, { recursive: true, force: true });
  }
});
