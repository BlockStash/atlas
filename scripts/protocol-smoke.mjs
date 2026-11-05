import {
  mkdtemp,
  mkdir,
  copyFile,
  symlink,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
const repo = fileURLToPath(new URL("../", import.meta.url)),
  contracts = join(repo, "contracts");
const folder = await mkdtemp(join(tmpdir(), "atlas-countries-check-"));
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, RPC_URL: `http://127.0.0.1:${port}` };
for (const name of [
  "DEPLOYER_PRIVATE_KEY",
  "ADMIN_ADDRESS",
  "TREASURY_ADDRESS",
  "MINTER_ADDRESS",
  "PAUSER_ADDRESS",
  "MARKET_ADMIN_ADDRESS",
  "PRICE_UPDATER_ADDRESS",
  "COUNTRY_ADMIN_ADDRESS",
  "SETTLEMENT_TOKEN_ADDRESS",
  "EXISTING_VAULT_ADDRESS",
  "SETTLEMENT_TOKEN_IS_DEMO",
  "DOTENV_CONFIG_PATH",
])
  delete env[name];
function run(command, args, cwd, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, ...extra },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`${command} exited with ${code}`)),
    );
  });
}
await mkdir(join(folder, "scripts"));
for (const name of [
  "deploy-countries.mjs",
  "deployment-utils.mjs",
  "smoke-countries.mjs",
])
  await copyFile(
    join(contracts, "scripts", name),
    join(folder, "scripts", name),
  );
for (const name of ["node_modules", "out", "config"])
  await symlink(join(contracts, name), join(folder, name), "dir");
const anvil = spawn("anvil", ["--silent", "--port", String(port)], {
  stdio: "ignore",
});
let startError;
anvil.on("error", (e) => {
  startError = e;
});
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (startError) throw startError;
    try {
      const response = await fetch(env.RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if ((await response.json()).result === "0x7a69") {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error("Temporary Anvil did not start.");
  await run("node", ["scripts/deploy-countries.mjs", "local"], folder);
  await run("node", ["scripts/smoke-countries.mjs"], folder);
  const manifest = join(folder, "deployments/local-v2.json");
  const backendEnv = {
    PROTOCOL_RPC_URL: env.RPC_URL,
    PROTOCOL_DEPLOYMENT_FILE: manifest,
    PRICE_UPDATER_UNLOCKED_LOCAL: "true",
    PRICE_SOURCE: "demo",
    PRICE_HISTORY_FILE: join(folder, "history.sqlite"),
  };
  await run("npm", ["run", "prices:update"], join(repo, "backend"), backendEnv);
  const fixture = JSON.parse(await readFile(manifest, "utf8"));
  fixture.chainId = 11155111;
  const fixtureFile = join(folder, "api-fixture.json");
  await writeFile(fixtureFile, JSON.stringify(fixture));
  const check = `import assert from 'node:assert/strict';import express from 'express';import request from 'supertest';import {protocolRouter} from './src/protocol/router.ts';const app=express();app.use('/api/protocol',protocolRouter());const config=await request(app).get('/api/protocol/config');assert.equal(config.body.version,2);assert.equal(config.body.countries.length,5);const catalog=await request(app).get('/api/protocol/catalog');assert.equal(catalog.status,200);assert.equal(catalog.body.stocks.length,51);assert.ok(catalog.body.stocks.some(s=>s.ticker==='POCNEW'));const history=await request(app).get('/api/protocol/history/'+catalog.body.stocks[0].stockId);assert.equal(history.status,200);assert.ok(history.body.history.length);assert.ok(history.body.history[0].usdt_price);console.log('PASS: v2 config, dynamic 51-stock catalog, price publisher and USD/USDT history.');`;
  await run(
    "node",
    ["--import", "tsx", "--input-type=module", "-e", check],
    join(repo, "backend"),
    { ...backendEnv, PROTOCOL_DEPLOYMENT_FILE: fixtureFile },
  );
  console.log(
    "PASS: isolated country protocol integration. Existing manifests and Sepolia are untouched.",
  );
} finally {
  anvil.kill("SIGTERM");
  await rm(folder, { recursive: true, force: true });
}
