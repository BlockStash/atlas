import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createIntentEngine } from "../src/intent/wiring.js";

const origin = "http://localhost:3000";

test("markets are always open: a timed buy executes outside exchange hours and exits after the hold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-always-open-"));
  // Saturday 03:00 UTC: every real exchange is closed.
  let t = Date.UTC(2026, 10, 7, 3, 0);
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

  const parsed = await agent
    .post("/api/intents/parse")
    .set("Origin", origin)
    .send({
      prompt:
        "Buy Apple with 1,000 USDT after 30 seconds and sell 10 seconds after buying",
    })
    .expect(200);
  assert.equal(parsed.body.status, "OK");
  const ev = parsed.body.evaluation;
  assert.equal(ev.valid, true, JSON.stringify(ev.issues));
  assert.equal(ev.market.open, true);
  assert.doesNotMatch(ev.summary, /exchange to be open|wait until NASDAQ/);
  assert.ok(
    !ev.simulation.warnings.some((w: { message: string }) =>
      /closed/.test(w.message),
    ),
  );

  const created = await agent
    .post("/api/intents")
    .set("Origin", origin)
    .send({ intent: parsed.body.intent, parseHash: parsed.body.parseHash })
    .expect(201);
  const id = created.body.id as string;
  await agent
    .post(`/api/intents/${id}/activate`)
    .set("Origin", origin)
    .send({ signature: "DEMO" })
    .expect(200);
  const tick = () =>
    agent
      .post("/api/intents/demo/tick")
      .set("Origin", origin)
      .send({})
      .expect(200);
  const status = async () =>
    (await agent.get(`/api/intents/${id}`).expect(200)).body.status as string;

  await tick();
  assert.equal(await status(), "WAITING_FOR_ENTRY"); // Waits only for its own 30 s delay.
  t += 31_000;
  await tick();
  assert.equal(await status(), "POSITION_OPEN"); // Filled on a Saturday.
  t += 10_000;
  await tick();
  assert.notEqual(await status(), "POSITION_OPEN"); // Time exit 10 s after the buy.

  // The portfolio trade history shows both fills, newest first, with realized P&L on the exit.
  const history = (await agent.get("/api/intents/trades").expect(200)).body;
  assert.equal(history.summary.count, 2);
  assert.deepEqual(
    history.trades.map(
      (x: { kind: string; side: string }) => `${x.kind}:${x.side}`,
    ),
    ["EXIT:SELL", "ENTRY:BUY"],
  );
  assert.equal(history.trades[1].symbol, "AAPL");
  assert.ok(Number(history.trades[1].notionalUSDT) > 990);
  assert.match(history.trades[0].realizedPnlUSDT, /^-?\d+(\.\d+)?$/);
  assert.equal(
    history.summary.realizedPnlUSDT,
    history.trades[0].realizedPnlUSDT,
  );

  // No timing at all: buys straight away.
  const now = await agent
    .post("/api/intents/parse")
    .set("Origin", origin)
    .send({ prompt: "Buy Apple with 500 USDT" })
    .expect(200);
  assert.equal(now.body.status, "OK");
  assert.deepEqual(now.body.intent.entryConditions, [{ type: "MARKET_OPEN" }]);
});
