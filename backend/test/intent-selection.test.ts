import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { assets } from "../src/intent/assets.js";
import { detectRank, selectByPrice } from "../src/intent/selection.js";
import type { PriceQuote } from "../src/intent/types.js";

const origin = "http://localhost:3000";
const quote = (stockId: string, price: number, isStale = false): PriceQuote =>
  ({
    stockId,
    nativePrice: String(price),
    nativeCurrency: "USD",
    priceUSDT: String(price),
    updatedAt: 0,
    isStale,
    source: "test",
  }) as PriceQuote;

function quotes(prices: Record<string, number>, stale: string[] = []) {
  const m = new Map<string, PriceQuote>();
  for (const a of assets)
    if (prices[a.symbol] !== undefined)
      m.set(
        a.stockId,
        quote(a.stockId, prices[a.symbol]!, stale.includes(a.symbol)),
      );
  return m;
}

test("detects price-ranked asset rules, and only those", () => {
  assert.equal(
    detectRank("buy token with the highest price available"),
    "highest",
  );
  assert.equal(detectRank("the most expensive US stock"), "highest");
  assert.equal(detectRank("Buy the cheapest Indian stock"), "lowest");
  assert.equal(detectRank("lowest-priced share in Europe"), "lowest");
  assert.equal(
    detectRank("Buy Apple with 1,000 USDT, sell at the highest"),
    null,
  );
  assert.equal(detectRank("Buy Apple with 1,000 USDT now"), null);
});

test("picks by price within a cap and a market, preferring fresh quotes", () => {
  const q = quotes({ AAPL: 230, MSFT: 420, META: 650, ASML: 810, TCS: 45 }, [
    "META",
  ]);
  const r = selectByPrice(
    "buy token with the highest price available inside 1000USDT and sell it after 30sec",
    q,
  );
  assert.equal(r.status, "SELECTED");
  if (r.status !== "SELECTED") return;
  assert.equal(r.selection.asset.symbol, "ASML"); // META is stale, skipped while fresh quotes exist
  assert.equal(r.selection.capUSDT, 1000);
  assert.match(r.selection.prompt, /ASML \(ASML\)/);
  assert.match(r.selection.prompt, /with 1000 USDT/); // the cap doubles as the spend
  assert.doesNotMatch(r.selection.prompt, /highest/i);

  const capped = selectByPrice(
    "Buy the most expensive stock under 500 USDT",
    q,
  );
  assert.equal(
    capped.status === "SELECTED" && capped.selection.asset.symbol,
    "MSFT",
  );
  const us = selectByPrice("Buy the cheapest US stock with 300 USDT", q);
  assert.equal(us.status === "SELECTED" && us.selection.asset.symbol, "AAPL");
  // A separate spend amount is kept; the cap is not turned into a second amount.
  const two = selectByPrice(
    "Spend 200 USDT on the highest priced stock under 500 USDT",
    q,
  );
  assert.ok(two.status === "SELECTED" && /200 USDT/.test(two.selection.prompt));
  assert.equal(
    selectByPrice("Buy the highest priced stock under 1 USDT", q).status,
    "NO_MATCH",
  );
  assert.equal(selectByPrice("Buy Apple now", q).status, "NONE");
});

test("the parse API resolves a price-ranked prompt into an executable buy-then-sell plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-select-"));
  const app = createApp({
    dataFile: join(dir, "profiles.json"),
    frontendOrigin: origin,
    demoWallet: true,
    demoWorldId: true,
    production: false,
  });
  const a = request.agent(app);
  await a.post("/api/auth/demo").set("Origin", origin).send({}).expect(200);
  const r = await a
    .post("/api/intents/parse")
    .set("Origin", origin)
    .send({
      prompt:
        "buy token with the highest price available inside 1000USDT and sell it after 30sec at market price",
    })
    .expect(200);
  assert.equal(r.body.status, "OK");
  assert.ok(r.body.selection.note.includes(r.body.intent.asset.symbol));
  assert.ok(r.body.selection.priceUSDT <= 1000);
  assert.deepEqual(r.body.intent.allocation, {
    type: "FIXED_USDT",
    value: "1000",
  });
  assert.deepEqual(r.body.intent.entryConditions, [{ type: "MARKET_OPEN" }]);
  const exit = r.body.intent.exitConditions.find(
    (e: { type: string }) => e.type === "TIME_EXIT",
  );
  assert.equal(exit?.holdSeconds, 30);
  assert.equal(r.body.evaluation.valid, true);

  const none = await a
    .post("/api/intents/parse")
    .set("Origin", origin)
    .send({ prompt: "Buy the highest priced stock under 1 USDT" })
    .expect(200);
  assert.equal(none.body.status, "CLARIFICATION_NEEDED");
  assert.equal(none.body.field, "asset");
});
