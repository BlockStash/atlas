import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { Wallet } from "ethers";
import { createApp, type AppOptions } from "../src/app.js";
import { VerificationError } from "../src/world-id.js";
let directory: string;
const origin = "http://localhost:3000";
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "atlas-api-"));
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});
function setup(name: string, overrides: Partial<AppOptions> = {}) {
  const options: AppOptions = {
    dataFile: join(directory, `${name}.json`),
    frontendOrigin: origin,
    demoWallet: true,
    demoWorldId: true,
    production: false,
    portfolioRead: async (address) => ({
      source: "sepolia",
      address,
      chainId: 11155111,
      blockNumber: 1,
      timestamp: 1800000000,
      settlementToken: address,
      vault: address,
      tradingEngine: address,
      walletUSDT: "0",
      vaultShares: "0",
      vaultAssets: "0",
      walletETH: "0",
      cashValueUSDT: "0",
      stockValueUSDT: "0",
      totalValueUSDT: "0",
      positions: [],
      history: [],
    }),
    ...overrides,
  };
  return { app: createApp(options), options };
}
test("Arkiv failure during signed login returns a JSON error without issuing a session", async () => {
  const unavailable = async (): Promise<never> => {
    throw new VerificationError(
      "ARKIV_UNAVAILABLE",
      "Arkiv is temporarily unavailable. Connect again.",
      503,
    );
  };
  const { app } = setup("arkiv-auth-failure", {
    store: { get: unavailable, update: unavailable },
  });
  const agent = request.agent(app),
    wallet = Wallet.createRandom();
  const challenge = await agent
    .post("/api/auth/challenge")
    .send({ address: wallet.address })
    .expect(200);
  const signature = await wallet.signMessage(challenge.body.message);
  const response = await agent
    .post("/api/auth/verify")
    .send({ address: wallet.address, signature })
    .expect(503);
  assert.equal(response.body.error.code, "ARKIV_UNAVAILABLE");
  assert.equal(response.headers["set-cookie"], undefined);
  await agent.get("/api/auth/session").expect(401);
  await agent
    .post("/api/auth/verify")
    .send({ address: wallet.address, signature })
    .expect(401);
});
test("wallet authentication verifies ownership, rejects replay and scopes preferences", async () => {
  const { app, options } = setup("auth");
  const agent = request.agent(app);
  const wallet = Wallet.createRandom();
  const challenge = await agent
    .post("/api/auth/challenge")
    .send({ address: wallet.address })
    .expect(200);
  const signature = await wallet.signMessage(challenge.body.message);
  const authenticated = await agent
    .post("/api/auth/verify")
    .send({ address: wallet.address, signature })
    .expect(200);
  assert.equal(authenticated.body.wallet.address, wallet.address);
  assert.match(authenticated.headers["set-cookie"][0], /HttpOnly/);
  await agent.get("/api/auth/session").expect(200);
  await agent
    .post("/api/auth/verify")
    .send({ address: wallet.address, signature })
    .expect(401);
  await agent
    .put("/api/profile")
    .send({
      selectedMarkets: ["usa", "india"],
      preferredAsset: "ATLAS",
      experienceLevel: "intermediate",
    })
    .expect(200);
  const persisted = JSON.parse(await readFile(options.dataFile, "utf8"));
  assert.equal(persisted[wallet.address.toLowerCase()].preferredAsset, "ATLAS");
  await agent.put("/api/profile").send({ worldIdVerified: true }).expect(400);
  await agent
    .put("/api/profile")
    .send({ walletAddress: Wallet.createRandom().address })
    .expect(400);
  await agent
    .put("/api/profile")
    .send({ onboardingComplete: true })
    .expect(409);
  const other = request.agent(app);
  await other.post("/api/auth/demo").send({}).expect(200);
  assert.deepEqual(
    (await other.get("/api/profile").expect(200)).body.selectedMarkets,
    ["india"],
  );
  await agent.post("/api/auth/logout").send({}).expect(200);
  await agent.get("/api/auth/session").expect(401);
});
test("wrong signer and expired challenge are rejected", async () => {
  let timestamp = Date.now();
  const { app } = setup("invalid", { now: () => timestamp });
  const wallet = Wallet.createRandom();
  const challenge = await request(app)
    .post("/api/auth/challenge")
    .send({ address: wallet.address })
    .expect(200);
  await request(app)
    .post("/api/auth/verify")
    .send({
      address: wallet.address,
      signature: await Wallet.createRandom().signMessage(
        challenge.body.message,
      ),
    })
    .expect(401);
  const expired = await request(app)
    .post("/api/auth/challenge")
    .send({ address: wallet.address })
    .expect(200);
  timestamp += 6 * 60 * 1000;
  await request(app)
    .post("/api/auth/verify")
    .send({
      address: wallet.address,
      signature: await wallet.signMessage(expired.body.message),
    })
    .expect(401);
});
test("demo proof is server controlled and completion can follow verified proof", async () => {
  const { app } = setup("world-id");
  const agent = request.agent(app);
  await agent.post("/api/auth/demo").send({}).expect(200);
  await agent.post("/api/world-id/verify").send({ verified: true }).expect(400);
  await agent.post("/api/world-id/verify").send({}).expect(503);
  const verification = await agent
    .post("/api/world-id/verify")
    .send({ demo: true })
    .expect(200);
  assert.equal(verification.body.profile.worldIdVerified, true);
  assert.equal(verification.body.profile.worldIdVerifiedDemo, true);
  await agent
    .put("/api/profile")
    .send({ onboardingComplete: true, currentStep: 5 })
    .expect(200);
  const portfolio = await agent.get("/api/portfolio").expect(200);
  assert.equal(portfolio.body.source, "sepolia");
  assert.equal(
    portfolio.body.address.toLowerCase(),
    (await agent.get("/api/auth/session")).body.wallet.address.toLowerCase(),
  );
});
test("demo cannot be used in production or when disabled", async () => {
  for (const [name, overrides] of [
    ["production", { production: true }],
    ["disabled", { demoWallet: false, demoWorldId: false }],
  ] as const) {
    const { app } = setup(name, overrides);
    await request(app).post("/api/auth/demo").send({}).expect(403);
    await request(app).get("/api/portfolio").expect(401);
  }
  const { app } = setup("proof-disabled", { demoWorldId: false });
  const agent = request.agent(app);
  await agent.post("/api/auth/demo").send({}).expect(200);
  await agent.post("/api/world-id/verify").send({ demo: true }).expect(403);
});
test("mutation rejects foreign origins, invalid market selection and malformed JSON", async () => {
  const { app } = setup("validation");
  const agent = request.agent(app);
  await agent
    .post("/api/auth/demo")
    .set("Origin", "https://example.com")
    .send({})
    .expect(403);
  await agent.post("/api/auth/demo").send({}).expect(200);
  await agent.put("/api/profile").send({ selectedMarkets: [] }).expect(400);
  await agent
    .put("/api/profile")
    .send({ selectedMarkets: ["mars"] })
    .expect(400);
  await agent
    .put("/api/profile")
    .set("Content-Type", "application/json")
    .send("{broken")
    .expect(400);
  const markets = await agent.get("/api/markets").expect(200);
  assert.equal(markets.body.markets.length, 6);
});

test("Sepolia sign-in and World ID proof verification bind action, wallet, environment and nonce", async () => {
  const signingWallet = Wallet.createRandom();
  let remoteCalls = 0;
  const { app, options } = setup("live-world", {
    demoWorldId: false,
    worldId: {
      appId: "app_test",
      rpId: "rp_test",
      action: "verify-human",
      signingKey: signingWallet.privateKey,
      environment: "production",
    },
    worldIdFetch: async (url, init) => {
      remoteCalls++;
      assert.equal(
        String(url),
        "https://developer.world.org/api/v4/verify/rp_test",
      );
      const proof = JSON.parse(init!.body as string);
      return Response.json({
        success: true,
        environment: "production",
        results: [
          {
            success: true,
            identifier: "proof_of_human",
            nullifier: proof.responses[0].nullifier,
          },
        ],
      });
    },
  });
  const agent = request.agent(app),
    wallet = Wallet.createRandom();
  const challenge = await agent
    .post("/api/auth/challenge")
    .send({ address: wallet.address })
    .expect(200);
  assert.match(challenge.body.message, /Chain ID: 11155111/);
  const login = await agent
    .post("/api/auth/verify")
    .send({
      address: wallet.address,
      signature: await wallet.signMessage(challenge.body.message),
    })
    .expect(200);
  assert.equal(login.body.wallet.network, "Sepolia");
  const { hashSignal } = await import("@worldcoin/idkit-core/hashing");
  async function proof() {
    const context = await agent
      .post("/api/world-id/request")
      .send({})
      .expect(200);
    assert.equal(context.body.signal, wallet.address.toLowerCase());
    assert.equal(
      JSON.stringify(context.body).includes(signingWallet.privateKey),
      false,
    );
    return {
      protocol_version: "4.0",
      nonce: context.body.rp_context.nonce,
      action: "verify-human",
      environment: "production",
      responses: [
        {
          identifier: "proof_of_human",
          issuer_schema_id: 1,
          signal_hash: hashSignal(wallet.address.toLowerCase()),
          nullifier: "123456",
          proof: ["1", "2", "3", "4", "5"],
          expires_at_min: Math.floor(Date.now() / 1000) + 300,
        },
      ],
    };
  }
  const wrongAction = await proof();
  wrongAction.action = "different";
  await agent
    .post("/api/world-id/verify")
    .send({ proof: wrongAction })
    .expect(400);
  const wrongWallet = await proof();
  wrongWallet.responses[0]!.signal_hash = hashSignal(
    Wallet.createRandom().address.toLowerCase(),
  );
  await agent
    .post("/api/world-id/verify")
    .send({ proof: wrongWallet })
    .expect(400);
  const wrongEnvironment = await proof();
  wrongEnvironment.environment = "staging";
  await agent
    .post("/api/world-id/verify")
    .send({ proof: wrongEnvironment })
    .expect(400);
  const wrongCredential = await proof();
  wrongCredential.responses[0]!.issuer_schema_id = 11;
  await agent
    .post("/api/world-id/verify")
    .send({ proof: wrongCredential })
    .expect(400);
  assert.equal(remoteCalls, 0);
  const valid = await proof();
  const foreign = request.agent(app);
  const foreignChallenge = await foreign
    .post("/api/auth/challenge")
    .send({ address: wallet.address })
    .expect(200);
  await foreign
    .post("/api/auth/verify")
    .send({
      address: wallet.address,
      signature: await wallet.signMessage(foreignChallenge.body.message),
    })
    .expect(200);
  await foreign.post("/api/world-id/verify").send({ proof: valid }).expect(409);
  const result = await agent
    .post("/api/world-id/verify")
    .send({ proof: valid })
    .expect(200);
  assert.equal(result.body.profile.worldIdVerified, true);
  assert.equal(result.body.profile.worldIdVerifiedDemo, false);
  assert.equal(result.body.profile.worldIdEnvironment, "production");
  assert.equal(remoteCalls, 1);
  await agent.post("/api/world-id/verify").send({ proof: valid }).expect(409);
  await agent
    .put("/api/profile")
    .send({ onboardingComplete: true })
    .expect(200);
  // Persistent claims prevent the same human credential being linked to a second wallet.
  const other = request.agent(app),
    otherWallet = Wallet.createRandom();
  const otherChallenge = await other
    .post("/api/auth/challenge")
    .send({ address: otherWallet.address })
    .expect(200);
  await other
    .post("/api/auth/verify")
    .send({
      address: otherWallet.address,
      signature: await otherWallet.signMessage(otherChallenge.body.message),
    })
    .expect(200);
  const otherContext = await other
    .post("/api/world-id/request")
    .send({})
    .expect(200);
  await other
    .post("/api/world-id/verify")
    .send({
      proof: {
        ...valid,
        nonce: otherContext.body.rp_context.nonce,
        responses: [
          {
            ...valid.responses[0],
            signal_hash: hashSignal(otherWallet.address.toLowerCase()),
          },
        ],
      },
    })
    .expect(409);
  const persisted = JSON.parse(await readFile(options.dataFile, "utf8"));
  assert.ok(persisted[wallet.address.toLowerCase()].worldIdNullifier);
});

test("World ID refuses missing configuration, simulated wallets, foreign sessions and unverified upstream responses", async () => {
  const { app } = setup("world-unconfigured");
  const demo = request.agent(app);
  await demo.post("/api/auth/demo").send({}).expect(200);
  await demo.post("/api/world-id/request").send({}).expect(403);
  const wallet = Wallet.createRandom(),
    agent = request.agent(app);
  const challenge = await agent
    .post("/api/auth/challenge")
    .send({ address: wallet.address })
    .expect(200);
  await agent
    .post("/api/auth/verify")
    .send({
      address: wallet.address,
      signature: await wallet.signMessage(challenge.body.message),
    })
    .expect(200);
  await agent.post("/api/world-id/request").send({}).expect(503);
  const { verifyWorldId } = await import("../src/world-id.js");
  const { hashSignal } = await import("@worldcoin/idkit-core/hashing");
  const config = {
    appId: "app_test",
    rpId: "rp_test",
    action: "verify-human",
    signingKey: Wallet.createRandom().privateKey,
    environment: "production" as const,
  };
  const pending = {
    walletAddress: wallet.address,
    sessionToken: "test",
    nonce: "nonce",
    expiresAt: Date.now() + 300000,
  };
  const proof = {
    protocol_version: "4.0",
    nonce: "nonce",
    action: "verify-human",
    environment: "production",
    responses: [
      {
        identifier: "proof_of_human",
        issuer_schema_id: 1,
        signal_hash: hashSignal(wallet.address.toLowerCase()),
        nullifier: "1",
        proof: ["1", "2", "3", "4", "5"],
      },
    ],
  };
  const options = {
    demoEnabled: false,
    production: false,
    portfolioRead: async (address) => ({
      source: "sepolia",
      address,
      chainId: 11155111,
      blockNumber: 1,
      timestamp: 1800000000,
      settlementToken: address,
      vault: address,
      tradingEngine: address,
      walletUSDT: "0",
      vaultShares: "0",
      vaultAssets: "0",
      walletETH: "0",
      cashValueUSDT: "0",
      stockValueUSDT: "0",
      totalValueUSDT: "0",
      positions: [],
      history: [],
    }),
    config,
    pending,
    address: wallet.address,
  };
  await assert.rejects(
    verifyWorldId(
      { proof },
      { ...options, pending: { ...pending, expiresAt: Date.now() - 1 } },
    ),
    /expired/,
  );
  await assert.rejects(
    verifyWorldId({ proof }, { ...options, pending: undefined }),
    /expired/,
  );
  for (const body of [
    { success: false },
    { success: true, results: [{ success: false }] },
    {
      success: true,
      results: [
        { success: true, identifier: "proof_of_human", nullifier: "different" },
      ],
    },
  ]) {
    await assert.rejects(
      verifyWorldId(
        { proof },
        { ...options, fetcher: async () => Response.json(body) },
      ),
      /did not accept/,
    );
  }
  await assert.rejects(
    verifyWorldId(
      { proof },
      {
        ...options,
        fetcher: async () => {
          throw new Error("offline");
        },
      },
    ),
    /could not be reached/,
  );
  await assert.rejects(
    verifyWorldId(
      { proof },
      {
        ...options,
        production: true,
        config: { ...config, environment: "staging" },
      },
    ),
    /production World ID/,
  );
});

test("ENS login requires the resolved wallet signature and links only server-verified names", async () => {
  const wallet = Wallet.createRandom(),
    other = Wallet.createRandom();
  let record: string | null = wallet.address;
  const { app } = setup("ens", {
    ensResolve: async (name) => (name === "alice.eth" ? record : null),
  });
  const client = request.agent(app);
  const resolved = await client
    .get("/api/ens/resolve")
    .query({ name: "Alice.ETH" })
    .expect(200);
  assert.equal(resolved.body.name, "alice.eth");
  assert.equal(resolved.body.chainId, 11155111);
  await client
    .get("/api/ens/resolve")
    .query({ name: "missing.eth" })
    .expect(404);
  await client
    .get("/api/ens/resolve")
    .query({ name: "not-a-name" })
    .expect(400);
  await client
    .post("/api/auth/challenge")
    .send({ address: other.address, ensName: "alice.eth" })
    .expect(403);
  const challenge = await client
    .post("/api/auth/challenge")
    .send({ address: wallet.address, ensName: "Alice.ETH" })
    .expect(200);
  assert.match(challenge.body.message, /ENS Name: alice.eth/);
  const signed = await client
    .post("/api/auth/verify")
    .send({
      address: wallet.address,
      signature: await wallet.signMessage(challenge.body.message),
    })
    .expect(200);
  assert.equal(signed.body.profile.ensName, "alice.eth");
  assert.equal(signed.body.profile.ensChainId, 11155111);
  await client
    .put("/api/profile")
    .send({ ensName: "attacker.eth" })
    .expect(400);
  record = other.address;
  await client.post("/api/profile/ens").send({ name: "alice.eth" }).expect(403);
  record = wallet.address;
  await client.post("/api/profile/ens").send({ name: "alice.eth" }).expect(200);
  const unlinked = await client.delete("/api/profile/ens").expect(200);
  assert.equal(unlinked.body.ensName, null);
  const storage = await client.get("/api/storage/status").expect(200);
  assert.equal(storage.body.driver, "local");
  const changed = await client
    .post("/api/auth/challenge")
    .send({ address: wallet.address, ensName: "alice.eth" })
    .expect(200);
  record = other.address;
  await client
    .post("/api/auth/verify")
    .send({
      address: wallet.address,
      signature: await wallet.signMessage(changed.body.message),
    })
    .expect(409);
});
test("passkey registration issues localhost options and rejects forged responses", async () => {
  const { app } = setup("passkey", { demoWorldId: false });
  const agent = request.agent(app);
  await agent.post("/api/auth/demo").send({}).expect(200);
  await agent
    .post("/api/passkey/register/verify")
    .send({ response: { id: "x" } })
    .expect(400);
  const options = await agent
    .post("/api/passkey/register/options")
    .send({})
    .expect(200);
  assert.equal(options.body.rp.id, "localhost");
  assert.equal(
    options.body.authenticatorSelection.userVerification,
    "required",
  );
  await agent
    .post("/api/passkey/register/verify")
    .send({
      response: { id: "x", rawId: "x", type: "public-key", response: {} },
    })
    .expect(400);
  const profile = await agent.get("/api/profile").expect(200);
  assert.equal(profile.body.passkeyVerified, false);
  await agent
    .put("/api/profile")
    .send({ onboardingComplete: true })
    .expect(409);
});
test("simulated crypto trades debit cash, track holdings and reject overspend", async () => {
  const { app } = setup("crypto");
  const agent = request.agent(app);
  await agent.post("/api/auth/demo").send({}).expect(200);
  const initial = await agent.get("/api/crypto").expect(200);
  assert.equal(initial.body.account.cashMicros, "10000000000");
  assert.ok(
    initial.body.assets.some((a: { symbol: string }) => a.symbol === "BTC"),
  );
  const bought = await agent
    .post("/api/crypto/trade")
    .send({ symbol: "ETH", side: "buy", amount: "1000" })
    .expect(200);
  assert.equal(bought.body.account.cashMicros, "9000000000");
  const qty = BigInt(bought.body.account.holdings.ETH.quantity);
  // $1000 minus 0.10% fee at $3612.48 ≈ 0.27654 ETH
  assert.ok(qty > 27_650_000n && qty < 27_660_000n);
  await agent
    .post("/api/crypto/trade")
    .send({ symbol: "ETH", side: "sell", amount: "5" })
    .expect(400);
  await agent
    .post("/api/crypto/trade")
    .send({ symbol: "BTC", side: "buy", amount: "999999" })
    .expect(400);
  await agent
    .post("/api/crypto/trade")
    .send({ symbol: "NOPE", side: "buy", amount: "1" })
    .expect(404);
  const sold = await agent
    .post("/api/crypto/trade")
    .send({
      symbol: "ETH",
      side: "sell",
      amount: (Number(qty) / 1e8).toFixed(8),
    })
    .expect(200);
  assert.equal(sold.body.account.holdings.ETH, undefined);
  assert.ok(BigInt(sold.body.account.cashMicros) < 10_000_000_000n);
  const profile = await agent
    .put("/api/profile")
    .send({ selectedMarkets: ["crypto", "usa"] })
    .expect(200);
  assert.deepEqual(profile.body.selectedMarkets, ["crypto", "usa"]);
});

test("portfolio reads stay bound to the signed-in wallet rather than a supplied address", async () => {
  const { app } = setup("portfolio-scope");
  const agent = request.agent(app),
    wallet = Wallet.createRandom(),
    foreign = Wallet.createRandom();
  const challenge = await agent
    .post("/api/auth/challenge")
    .send({ address: wallet.address })
    .expect(200);
  await agent
    .post("/api/auth/verify")
    .send({
      address: wallet.address,
      signature: await wallet.signMessage(challenge.body.message),
    })
    .expect(200);
  const result = await agent
    .get(`/api/portfolio?address=${foreign.address}`)
    .expect(200);
  assert.equal(result.body.address, wallet.address);
  assert.equal(result.body.source, "sepolia");
  assert.equal(result.body.totalValueUSDT, "0");
  assert.deepEqual(result.body.positions, []);
});
