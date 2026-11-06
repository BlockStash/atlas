import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { paperRouter } from "../src/paper/router.js";
import { EXAMPLE } from "../src/paper/parser.js";
const origin = "http://localhost:3000";
test("paper API requires auth, explicit confirmation and wallet-scoped sessions; no live execution call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-paper-"));
  let liveReads = 0;
  const app = createApp({
    dataFile: join(dir, "profiles.json"),
    frontendOrigin: origin,
    demoWallet: true,
    production: false,
    portfolioRead: async () => {
      liveReads++;
      throw Error("Live portfolio access forbidden");
    },
  });
  await request(app).get("/api/paper").expect(401);
  const alice = request.agent(app),
    bob = request.agent(app);
  for (const a of [alice, bob])
    await a.post("/api/auth/demo").set("Origin", origin).send({}).expect(200);
  const reset = {
    seed: 42,
    startTime: 1793892540,
    volatilityBps: 0,
    driftBps: 0,
    shocks: [{ tick: 12, symbol: "AAPL", changeBps: 300 }],
  };
  await alice
    .post("/api/paper/reset")
    .set("Origin", origin)
    .send(reset)
    .expect(200);
  const p = await alice
    .post("/api/paper/preview")
    .set("Origin", origin)
    .send({ prompt: EXAMPLE, date: "2026-11-05" })
    .expect(200);
  assert.equal(p.body.status, "OK");
  await alice
    .post("/api/paper/clock")
    .set("Origin", origin)
    .send({ action: "step", steps: 6 })
    .expect(200)
    .then((r) => assert.equal(r.body.fills.length, 0));
  await alice
    .post(`/api/paper/${p.body.order.id}/confirm`)
    .set("Origin", origin)
    .send({ confirmed: false, confirmationToken: p.body.confirmationToken })
    .expect(400);
  await bob
    .post(`/api/paper/${p.body.order.id}/confirm`)
    .set("Origin", origin)
    .send({ confirmed: true, confirmationToken: p.body.confirmationToken })
    .expect(404);
  await alice
    .post(`/api/paper/${p.body.order.id}/confirm`)
    .set("Origin", origin)
    .send({ confirmed: true, confirmationToken: p.body.confirmationToken })
    .expect(200);
  const entered = await alice
    .post("/api/paper/clock")
    .set("Origin", origin)
    .send({ action: "step", steps: 1 })
    .expect(200);
  assert.equal(entered.body.fills.length, 1);
  const done = await alice
    .post("/api/paper/clock")
    .set("Origin", origin)
    .send({ action: "step", steps: 6 })
    .expect(200);
  assert.equal(done.body.orders[0].status, "COMPLETED");
  const b = await bob.get("/api/paper").expect(200);
  assert.equal(b.body.orders.length, 0);
  assert.equal(b.body.cash, "25000");
  assert.equal(liveReads, 0);
  await alice
    .post("/api/paper/reset")
    .set("Origin", origin)
    .send({ ...reset, executionMode: "live" })
    .expect(400);
  await alice
    .post("/api/paper/preview")
    .set("Origin", origin)
    .send({
      prompt: EXAMPLE.replace("selected simulation date", "2026-11-06"),
      date: "2026-11-05",
    })
    .expect(422);
});
test("paper route is disabled in production before any engine is created", async () => {
  const app = express();
  app.use("/api/paper", paperRouter(true));
  app.use(
    (
      e: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(e.status ?? 500).json({ message: e.message });
    },
  );
  await request(app).get("/api/paper").expect(403);
});
