import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createIntentEngine } from "../src/intent/wiring.js";

const origin = "http://localhost:3000";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "atlas-intent-backtest-"));
  const t = Date.UTC(2026, 10, 4, 15, 0); // NASDAQ open
  const intents = createIntentEngine({
    production: false,
    file: ":memory:",
    now: () => t,
    env: { INTENT_DEMO_MODE: "true" } as NodeJS.ProcessEnv,
  });
  const app = createApp({
    dataFile: join(dir, "p.json"),
    frontendOrigin: origin,
    demoWallet: true,
    demoWorldId: true,
    production: false,
    intents,
    now: () => t,
  });
  const agent = request.agent(app);
  await agent.post("/api/auth/demo").set("Origin", origin).send({}).expect(200);
  return agent;
}

test("backtest runs the plan's bracket over seeded paths and is deterministic", async () => {
  const agent = await setup();
  const parsed = await agent
    .post("/api/intents/parse")
    .set("Origin", origin)
    .send({
      prompt:
        "Buy Apple with 1,000 USDT when NASDAQ opens. Max slippage 0.5%. Sell at +8% or -3%.",
    })
    .expect(200);
  assert.equal(parsed.body.status, "OK");
  const run = () =>
    agent
      .post("/api/intents/backtest")
      .set("Origin", origin)
      .send({ intent: parsed.body.intent, days: 90 })
      .expect(200);
  const a = (await run()).body.backtest,
    b = (await run()).body.backtest;
  assert.deepEqual(a, b);
  assert.equal(a.days, 90);
  assert.ok(a.band.length > 10 && a.band.length <= 125);
  for (const p of a.band) assert.ok(p.p10 <= p.p50 && p.p50 <= p.p90);
  const s = a.stats;
  assert.equal(s.triggeredPct, 100); // Market-open entry always fills.
  const total =
    s.takeProfitPct + s.stopLossPct + s.otherExitPct + s.stillOpenPct;
  assert.ok(Math.abs(total - 100) < 0.1, `exits sum to ${total}`);
  assert.ok(s.takeProfitPct > 0 && s.stopLossPct > 0);
  assert.ok(s.p10PnlUSDT <= s.medianPnlUSDT && s.medianPnlUSDT <= s.p90PnlUSDT);
  // A -3% stop on 1,000 USDT caps typical losses near -30 plus costs and gaps.
  assert.ok(s.p10PnlUSDT > -80, `p10 ${s.p10PnlUSDT}`);
  assert.match(a.disclaimer, /Not historical performance/);

  await agent
    .post("/api/intents/backtest")
    .set("Origin", origin)
    .send({ intent: parsed.body.intent, days: 45 })
    .expect(400);
});

test("an Atlas AI plan becomes a confirmable paper order", async () => {
  const agent = await setup();
  const p = await agent
    .post("/api/paper/from-intent")
    .set("Origin", origin)
    .send({
      symbol: "AAPL",
      notionalUSDT: 1000,
      maxSlippageBps: 50,
      takeProfitBps: 800,
    })
    .expect(200);
  assert.equal(p.body.order.status, "PREVIEW");
  assert.equal(p.body.order.draft.takeProfitBps, 800);
  assert.equal(p.body.order.draft.stopLossBps, 500);
  assert.deepEqual(p.body.defaults, ["stop loss -5%"]);
  assert.ok(Number(p.body.order.quantity) > 0);
  await agent
    .post(`/api/paper/${p.body.order.id}/confirm`)
    .set("Origin", origin)
    .send({ confirmed: true, confirmationToken: p.body.confirmationToken })
    .expect(200);
  const filled = await agent
    .post("/api/paper/clock")
    .set("Origin", origin)
    .send({ action: "step", steps: 12 })
    .expect(200);
  assert.equal(filled.body.fills.length, 1);
});

test("crypto and unlisted assets are refused; stock baskets route to a strategy", async () => {
  const agent = await setup();
  const parse = (prompt: string) =>
    agent
      .post("/api/intents/parse")
      .set("Origin", origin)
      .send({ prompt })
      .expect(200)
      .then((r) => r.body);
  const crypto = await parse(
    "split 1000usdt into 30%btc 30%eth 40%sol for next 3month",
  );
  assert.equal(crypto.status, "UNSUPPORTED_INTENT");
  assert.match(
    crypto.reason,
    /^ATLAS doesn’t support Bitcoin \(BTC\), Ethereum \(ETH\) and Solana \(SOL\)\./,
  );
  assert.match(crypto.reason, /listed tokenized stocks, using aUSDT or USDT/);
  const unlisted = await parse("Buy 500 USDT of $PLTR at market open");
  assert.equal(unlisted.status, "UNSUPPORTED_INTENT");
  assert.match(unlisted.reason, /PLTR/);
  const basket = await parse(
    "split 1000 USDT into 30% AAPL 30% MSFT 40% NVDA for the next 3 months",
  );
  assert.equal(basket.status, "PORTFOLIO_STRATEGY");
  const both = await parse("both");
  assert.equal(both.status, "CLARIFICATION_NEEDED");
  assert.deepEqual(
    both.options.map((o: { label: string }) => o.label),
    ["Buy", "Sell"],
  );
  const put = await parse("Put 1,000 USDT in Apple when NASDAQ opens");
  assert.equal(put.status, "OK");
  assert.equal(put.intent.side, "BUY");
});
