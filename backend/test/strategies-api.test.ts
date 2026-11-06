import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { generateSpec } from "../src/strategies/core.js";

const origin = "http://localhost:3000";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "atlas-strategies-"));
  const app = createApp({
    dataFile: join(dir, "profiles.json"),
    frontendOrigin: origin,
    demoWallet: true,
    demoWorldId: true,
    production: false,
  });
  const alice = request.agent(app),
    bob = request.agent(app);
  const wallets: string[] = [];
  for (const a of [alice, bob]) {
    const r = await a
      .post("/api/auth/demo")
      .set("Origin", origin)
      .send({})
      .expect(200);
    wallets.push(r.body.wallet.address);
  }
  return {
    app,
    alice,
    bob,
    aliceAddress: wallets[0]!,
    bobAddress: wallets[1]!,
  };
}

test("signed-out visitors see only the public seed marketplace and cannot write", async () => {
  const { app } = await setup();
  const r = await request(app).get("/api/strategies").expect(200);
  assert.ok(r.body.strategies.length >= 8);
  assert.ok(
    r.body.strategies.every(
      (s: { visibility: string }) => s.visibility === "public",
    ),
  );
  assert.equal(r.body.viewer, null);
  assert.equal(r.body.creatorFeeBps, 10);
  await request(app)
    .post("/api/strategies/stg_global_ai/clone")
    .set("Origin", origin)
    .send({})
    .expect(401);
  const creator = await request(app)
    .get("/api/strategies/creators/meera.eth")
    .expect(200);
  assert.equal(creator.body.creator.name, "meera.eth");
  assert.ok(creator.body.strategies.length >= 1);
});

test("create is private by default to others, publish exposes it, spec edits wipe runs", async () => {
  const { alice, bob } = await setup();
  const gen = await alice
    .post("/api/strategies/generate")
    .set("Origin", origin)
    .send({ prompt: "Buy AI chip leaders in the US, rebalance monthly" })
    .expect(200);
  assert.equal(gen.body.spec.schema, "atlas.strategy/v1");
  const created = await alice
    .post("/api/strategies")
    .set("Origin", origin)
    .send({
      name: "Chip Momentum",
      tagline: gen.body.tagline,
      prompt: "Buy AI chip leaders in the US, rebalance monthly",
      spec: gen.body.spec,
      visibility: "private",
    })
    .expect(201);
  const id = created.body.id as string;
  assert.ok(created.body.icon.name);
  await bob.get(`/api/strategies/${id}`).expect(404);
  await bob
    .post(`/api/strategies/${id}/clone`)
    .set("Origin", origin)
    .send({})
    .expect(404);
  await bob
    .patch(`/api/strategies/${id}`)
    .set("Origin", origin)
    .send({ name: "Mine now" })
    .expect(404);

  await alice
    .post(`/api/strategies/${id}/backtest`)
    .set("Origin", origin)
    .send({ capital: 10_000 })
    .expect(200)
    .then((r) => {
      assert.equal(r.body.performance.days, 365);
      assert.ok(r.body.strategy.runs.backtest);
    });
  await alice
    .put(`/api/strategies/${id}/visibility`)
    .set("Origin", origin)
    .send({ visibility: "public" })
    .expect(200);
  await bob.get(`/api/strategies/${id}`).expect(200);
  await bob
    .patch(`/api/strategies/${id}`)
    .set("Origin", origin)
    .send({ name: "Mine now" })
    .expect(403);

  const spec = { ...gen.body.spec, riskProfile: "conservative" };
  const edited = await alice
    .patch(`/api/strategies/${id}`)
    .set("Origin", origin)
    .send({ spec })
    .expect(200);
  assert.deepEqual(edited.body.runs, {});
  await alice
    .patch(`/api/strategies/${id}`)
    .set("Origin", origin)
    .send({ spec: { ...spec, universe: [] } })
    .expect(400)
    .then((r) => assert.equal(r.body.error.code, "INVALID_SPEC"));
});

test("clones keep the root author; live deploys pay 0.1% to them; deployed strategies cannot be deleted", async () => {
  const { alice, bob, aliceAddress, bobAddress } = await setup();
  const spec = generateSpec(
    "Global balanced portfolio, rebalance quarterly",
  ).spec;
  const root = (
    await alice
      .post("/api/strategies")
      .set("Origin", origin)
      .send({
        name: "Root",
        tagline: "",
        prompt: "x",
        spec,
        visibility: "public",
      })
      .expect(201)
  ).body;

  const fork = (
    await bob
      .post(`/api/strategies/${root.id}/clone`)
      .set("Origin", origin)
      .send({})
      .expect(201)
  ).body;
  assert.equal(fork.visibility, "private");
  assert.equal(fork.originalCreator.address, aliceAddress);
  assert.equal(fork.creator.address, bobAddress);
  assert.equal(fork.forkedFrom.id, root.id);
  assert.notDeepEqual(fork.icon, root.icon);

  await bob
    .post(`/api/strategies/${fork.id}/deploy`)
    .set("Origin", origin)
    .send({ mode: "live", amount: 1 })
    .expect(400)
    .then((r) => assert.equal(r.body.error.code, "BELOW_MINIMUM"));
  // Bob deploys his own fork: the fee still goes to Alice, the root author.
  const deployed = await bob
    .post(`/api/strategies/${fork.id}/deploy`)
    .set("Origin", origin)
    .send({ mode: "live", amount: 1000 })
    .expect(201);
  assert.equal(deployed.body.position.creatorFee, 1);
  assert.equal(deployed.body.position.capital, 999);
  assert.equal(deployed.body.position.feeRecipient, aliceAddress);

  // Bob deploys Alice's strategy directly.
  await bob
    .post(`/api/strategies/${root.id}/deploy`)
    .set("Origin", origin)
    .send({ mode: "live", amount: 2000 })
    .expect(201);
  const after = (await alice.get(`/api/strategies/${root.id}`).expect(200))
    .body;
  assert.equal(after.stats.clones, 1);
  assert.equal(after.stats.deployers, 1);
  assert.equal(after.stats.aum, 1998);
  assert.equal(after.stats.creatorEarnings, 3);

  // Paper trades and the author's own deployments are fee-free.
  const own = await alice
    .post(`/api/strategies/${root.id}/deploy`)
    .set("Origin", origin)
    .send({ mode: "live", amount: 500 })
    .expect(201);
  assert.equal(own.body.position.creatorFee, 0);

  await alice
    .delete(`/api/strategies/${root.id}`)
    .set("Origin", origin)
    .expect(409)
    .then((r) => assert.equal(r.body.error.code, "IN_USE"));

  const positions = (await bob.get("/api/strategies/positions").expect(200))
    .body.positions;
  assert.equal(positions.length, 2);
  await alice
    .delete(`/api/strategies/positions/${positions[0].id}`)
    .set("Origin", origin)
    .expect(404);
  for (const p of positions)
    await bob
      .delete(`/api/strategies/positions/${p.id}`)
      .set("Origin", origin)
      .expect(200);
  const freed = (await alice.get(`/api/strategies/${root.id}`).expect(200))
    .body;
  assert.equal(freed.stats.deployers, 0);
  await alice
    .delete(`/api/strategies/${root.id}`)
    .set("Origin", origin)
    .expect(200);
});

test("strategies can only hold listed tokenized stocks", async () => {
  const { alice } = await setup();
  const gen = await alice
    .post("/api/strategies/generate")
    .set("Origin", origin)
    .send({ prompt: "60% BTC 40% ETH, weekly rebalance" })
    .expect(422);
  assert.equal(gen.body.error.code, "UNSUPPORTED_ASSET");
  assert.match(
    gen.body.error.message,
    /ATLAS doesn’t support Bitcoin \(BTC\) and Ethereum \(ETH\)/,
  );
  const spec = generateSpec("US tech, monthly rebalance").spec;
  const bad = {
    ...spec,
    universe: [
      { symbol: "BTC", name: "Bitcoin", market: "crypto", weight: 50 },
      { ...spec.universe[0]!, weight: 50 },
    ],
  };
  const created = await alice
    .post("/api/strategies")
    .set("Origin", origin)
    .send({
      name: "X",
      tagline: "",
      prompt: "x",
      spec: bad,
      visibility: "private",
    })
    .expect(400);
  assert.match(created.body.error.message, /ATLAS doesn’t support BTC/);
  const list = (await alice.get("/api/strategies").expect(200)).body.strategies;
  for (const s of list)
    for (const a of s.spec.universe) assert.notEqual(a.market, "crypto");
});

test("demo reset clears only the caller's own work and positions", async () => {
  const { alice, bob } = await setup();
  const spec = generateSpec("India income dividend stocks").spec;
  await alice
    .post("/api/strategies")
    .set("Origin", origin)
    .send({ name: "A", tagline: "", prompt: "x", spec, visibility: "public" })
    .expect(201);
  await bob
    .post("/api/strategies")
    .set("Origin", origin)
    .send({ name: "B", tagline: "", prompt: "x", spec, visibility: "public" })
    .expect(201);
  const reset = await alice
    .post("/api/strategies/reset")
    .set("Origin", origin)
    .send({})
    .expect(200);
  const names = reset.body.strategies.map((s: { name: string }) => s.name);
  assert.ok(!names.includes("A"));
  assert.ok(names.includes("B"));
});
