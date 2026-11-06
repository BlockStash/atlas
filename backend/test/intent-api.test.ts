import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { Wallet } from "ethers";
import { createApp } from "../src/app.js";
import { createIntentEngine } from "../src/intent/wiring.js";

const origin = "http://localhost:3000";
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "atlas-intent-api-"));
  // Wednesday 10:00 New York time: NASDAQ is open.
  const t = Date.UTC(2026, 10, 4, 15, 0);
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
  return { app, intents };
}

test("intent API requires authentication", async () => {
  const { app } = await setup();
  await request(app).get("/api/intents").expect(401);
  await request(app)
    .post("/api/intents/parse")
    .set("Origin", origin)
    .send({ prompt: "buy apple" })
    .expect(401);
});

test("intent API: parse -> create -> activate (demo signature) -> list -> cancel", async () => {
  const { app, intents } = await setup();
  const agent = request.agent(app);
  const login = await agent
    .post("/api/auth/demo")
    .set("Origin", origin)
    .send({})
    .expect(200);
  const me = login.body.wallet.address as string;
  const cfg = await agent.get("/api/intents/config").expect(200);
  assert.equal(cfg.body.demoMode, true);

  const parsed = await agent
    .post("/api/intents/parse")
    .set("Origin", origin)
    .send({
      prompt:
        "Buy Apple with 1,000 USDT after NASDAQ opens. Maximum slippage 0.5%. Sell at 8% profit or 3% loss.",
    })
    .expect(200);
  assert.equal(parsed.body.status, "OK");
  assert.equal(parsed.body.intent.asset.symbol, "AAPL");
  assert.equal(parsed.body.evaluation.valid, true);

  // Clarification flow
  const amb = await agent
    .post("/api/intents/parse")
    .set("Origin", origin)
    .send({ prompt: "Buy Apple when it looks good with 100 USDT" })
    .expect(200);
  assert.equal(amb.body.status, "CLARIFICATION_NEEDED");

  // The client cannot smuggle in another identity or id.
  const tampered = {
    ...parsed.body.intent,
    userAddress: Wallet.createRandom().address,
    id: "0x" + "1".repeat(64),
  };
  const created = await agent
    .post("/api/intents")
    .set("Origin", origin)
    .send({ intent: tampered, parseHash: parsed.body.parseHash })
    .expect(201);
  assert.notEqual(created.body.id, "0x" + "1".repeat(64));
  assert.equal(created.body.typedData.message.user, me);
  assert.equal(created.body.evaluation.intent.userAddress, me);

  // Not active before signing
  const before = await agent.get(`/api/intents/${created.body.id}`).expect(200);
  assert.equal(before.body.status, "AWAITING_APPROVAL");

  // Garbage signature is rejected with a structured error
  const bad = await agent
    .post(`/api/intents/${created.body.id}/activate`)
    .set("Origin", origin)
    .send({ signature: "0xdeadbeef" })
    .expect(401);
  assert.equal(bad.body.error.code, "USER_REJECTED_SIGNATURE");

  const active = await agent
    .post(`/api/intents/${created.body.id}/activate`)
    .set("Origin", origin)
    .send({ signature: "DEMO" })
    .expect(200);
  assert.equal(active.body.status, "ACTIVE");
  assert.equal(active.body.signatureType, "DEMO");
  const list = await agent.get("/api/intents").expect(200);
  assert.equal(list.body.intents.length, 1);

  const tick = await agent
    .post("/api/intents/demo/tick")
    .set("Origin", origin)
    .send({})
    .expect(200);
  assert.equal(tick.body.processed, 1);
  const after = await agent.get(`/api/intents/${created.body.id}`).expect(200);
  assert.equal(after.body.status, "POSITION_OPEN");
  await agent
    .post(`/api/intents/${created.body.id}/cancel`)
    .set("Origin", origin)
    .send({})
    .expect(409);
  const events = await agent
    .get(`/api/intents/${created.body.id}/events`)
    .expect(200);
  assert.ok(
    events.body.events.some(
      (e: { type: string }) => e.type === "TRADE_CONFIRMED",
    ),
  );
  intents.ctx.repo.close();
});

test("a different wallet cannot see or act on someone else's strategy", async () => {
  const { app } = await setup();
  const a = request.agent(app),
    b = request.agent(app);
  await a.post("/api/auth/demo").set("Origin", origin).send({}).expect(200);
  await b.post("/api/auth/demo").set("Origin", origin).send({}).expect(200);
  const parsed = await a
    .post("/api/intents/parse")
    .set("Origin", origin)
    .send({ prompt: "Buy Apple with 500 USDT when NASDAQ opens" })
    .expect(200);
  const created = await a
    .post("/api/intents")
    .set("Origin", origin)
    .send({ intent: parsed.body.intent })
    .expect(201);
  await b.get(`/api/intents/${created.body.id}`).expect(404);
  await b
    .post(`/api/intents/${created.body.id}/cancel`)
    .set("Origin", origin)
    .send({})
    .expect(404);
  assert.deepEqual((await b.get("/api/intents").expect(200)).body.intents, []);
});

test("live mode (demo off) refuses demo controls", async () => {
  const intents = createIntentEngine({
    production: true,
    file: ":memory:",
    env: { INTENT_DEMO_MODE: "false" } as NodeJS.ProcessEnv,
  });
  const dir = await mkdtemp(join(tmpdir(), "atlas-intent-api-"));
  const app = createApp({
    dataFile: join(dir, "p.json"),
    frontendOrigin: origin,
    demoWallet: true,
    demoWorldId: true,
    production: false,
    intents,
  });
  const agent = request.agent(app);
  await agent.post("/api/auth/demo").set("Origin", origin).send({}).expect(200);
  await agent
    .post("/api/intents/demo/tick")
    .set("Origin", origin)
    .send({})
    .expect(403);
  const cfg = await agent.get("/api/intents/config").expect(200);
  assert.equal(cfg.body.demoMode, false);
  assert.equal(cfg.body.demoControls, false);
  await agent
    .post("/api/intents/demo/price")
    .set("Origin", origin)
    .send({ stockId: "0x" + "1".repeat(64), multiplierBps: 20000 })
    .expect(403);
});
