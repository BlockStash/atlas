import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createIntentEngine } from "../src/intent/wiring.js";
import { IntentError } from "../src/intent/types.js";
import type { ExecutionRequest } from "../src/intent/adapters.js";
import type { OnchainExecutor } from "../src/intent/onchain.js";

const origin = "http://localhost:3000";
const EXECUTOR = "0x1111111111111111111111111111111111111111";
const MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";

/** Live mode with a stub executor: same contract as OnchainExecutor, no chain. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "atlas-onchain-"));
  let t = Date.UTC(2026, 10, 7, 3, 0);
  const intents = createIntentEngine({
    production: false,
    file: ":memory:",
    now: () => t,
    env: { INTENT_DEMO_MODE: "true" } as NodeJS.ProcessEnv,
  });
  const state = {
    vault: 270_000n,
    wallet: 251_000_000_000n,
    executed: [] as ExecutionRequest[],
  };
  const repo = intents.ctx.repo;
  const stub = {
    kind: "ONCHAIN" as const,
    address: EXECUTOR,
    permissionRequest: async (spend: bigint) => ({
      tokenAddress: "0x1FCA52811785e5c52a651C3b2d9C14E28a494a79",
      allowanceShares: 5_000_000_000_000_000n,
      requiredAssetsUSDT: (spend * 10_110n) / 10_000n,
      delegate: EXECUTOR,
      delegationManager: MANAGER,
    }),
    verifyPermission: (p: { context: string }) => {
      if (p.context !== "0xc0ffee")
        throw new IntentError(
          "USER_REJECTED_SIGNATURE",
          "The MetaMask permission does not delegate your aUSDT to the Atlas executor.",
          422,
        );
    },
    execute: async (r: ExecutionRequest) => {
      state.executed.push(r);
      const steps =
        r.side === "BUY" ? ["pull", "buy", "change"] : ["sell", "payout"];
      steps.forEach((s, i) =>
        repo.saveStep(
          r.executionId,
          s,
          `0x${String(i + 1).repeat(64)}`,
          null,
          Math.floor(t / 1000),
        ),
      );
      const price = 34_466_977_116n;
      const quantity =
        r.quantity ?? ((r.notionalUSDT ?? 0n) * 10n ** 20n) / price;
      const notional = (quantity * price) / 10n ** 20n;
      return {
        txHash: `0x${"2".repeat(64)}`,
        fillPrice: price,
        quantity,
        notionalUSDT: notional,
        feeUSDT: notional / 1000n,
        slippageBps: 0,
      };
    },
  };
  intents.ctx.onchain = stub as unknown as OnchainExecutor;
  intents.ctx.adapter = stub;
  intents.ctx.portfolio = async (user) => {
    const { qty } = repo.ledger(user);
    return {
      totalValueUSDT: state.vault + state.wallet,
      vaultAssetsUSDT: state.vault,
      walletUSDT: state.wallet,
      positions: [...qty]
        .filter(([, q]) => q > 0n)
        .map(([stockId, quantity]) => ({
          stockId,
          country: "US",
          quantity,
          valueUSDT: 0n,
        })),
      activeIntents: repo.countActive(user),
    };
  };
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
  return { agent, state, repo, advance: (ms: number) => (t += ms) };
}

test("live mode: funding replaces the balance block, and activation needs a valid MetaMask permission", async () => {
  const { agent, state, repo, advance } = await setup();
  const post = (path: string, body: unknown) =>
    agent
      .post(path)
      .set("Origin", origin)
      .send(body as object);

  const parsed = await post("/api/intents/parse", {
    prompt: "Buy Apple with 1,000 USDT now and sell 60 seconds after buying",
  }).expect(200);
  const ev = parsed.body.evaluation;
  assert.equal(ev.valid, true, JSON.stringify(ev.blockingRisk));
  assert.equal(ev.funding.vaultUSDT, "0.27");
  assert.ok(Number(ev.funding.shortfallUSDT) > 1000);
  assert.equal(ev.funding.permission.delegate, EXECUTOR);

  const config = await agent.get("/api/intents/config").expect(200);
  assert.equal(config.body.executionMode, "ONCHAIN");
  assert.equal(config.body.onchain.executor, EXECUTOR);

  const created = await post("/api/intents", {
    intent: parsed.body.intent,
    parseHash: parsed.body.parseHash,
  }).expect(201);
  const id = created.body.id as string;
  const good = {
    context: "0xc0ffee",
    delegationManager: MANAGER,
    allowanceShares: "1234",
  };

  // No permission, a foreign permission, and an unfunded vault are all refused.
  const none = await post(`/api/intents/${id}/activate`, {
    signature: "DEMO",
  }).expect(422);
  assert.match(none.body.error.message, /aUSDT permission/);
  await post(`/api/intents/${id}/activate`, {
    signature: "DEMO",
    permission: { ...good, context: "0xbad0" },
  }).expect(422);
  const short = await post(`/api/intents/${id}/activate`, {
    signature: "DEMO",
    permission: good,
  }).expect(422);
  assert.equal(short.body.error.code, "INSUFFICIENT_BALANCE");

  // After converting USDT to aUSDT it activates, keeping no more than MetaMask granted.
  state.vault = 2_000_000_000n;
  const active = await post(`/api/intents/${id}/activate`, {
    signature: "DEMO",
    permission: good,
  }).expect(200);
  assert.equal(active.body.status, "ACTIVE");
  assert.equal(active.body.executionMode, "ONCHAIN");
  assert.equal(repo.permission(id)?.allowance, "1234");

  // The worker buys through the executor, then sells after the hold.
  await post("/api/intents/demo/tick", {}).expect(200);
  assert.equal(state.executed[0]?.side, "BUY");
  assert.equal(state.executed[0]?.maxSlippageBps, 100);
  advance(61_000);
  await post("/api/intents/demo/tick", {}).expect(200);
  assert.equal(state.executed[1]?.side, "SELL");

  const history = (await agent.get("/api/intents/trades").expect(200)).body;
  assert.equal(history.summary.count, 2);
  const [exit, entry] = history.trades;
  assert.equal(entry.mode, "ONCHAIN");
  assert.deepEqual(
    entry.transactions.map((x: { step: string }) => x.step),
    ["pull", "buy", "change"],
  );
  assert.deepEqual(
    exit.transactions.map((x: { step: string }) => x.step),
    ["sell", "payout"],
  );
});

test("RPC errors shown to users are one short line with no URLs", async () => {
  const { publicMessage } = await import("../src/intent/worker.js");
  const limited = {
    shortMessage: "Request exceeds defined limit.",
    details: "rate limit exceeded",
    message:
      'Request exceeds defined limit.\n\nStatus: 429\nURL: https://sepolia.gateway.tenderly.co/SECRETKEY\nRequest body: {"method":"eth_sendRawTransaction"}',
  };
  assert.equal(
    publicMessage(limited),
    "The Sepolia RPC is rate-limiting Atlas; it will retry shortly.",
  );
  const other = publicMessage({
    message: "fetch failed at https://rpc.example/key123\nmore",
  });
  assert.equal(other, "fetch failed at [rpc]");
  assert.doesNotMatch(other, /key123/);
});
