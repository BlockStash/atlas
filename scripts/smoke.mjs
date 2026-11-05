import assert from "node:assert/strict";
import { createRequire } from "node:module";
const base = process.env.ATLAS_URL || "http://127.0.0.1:3000";
let cookie = "";
async function request(path, { method = "GET", body, expected = 200 } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${await response.clone().text()}`,
  );
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return response.json();
}
for (const route of [
  "/",
  "/onboarding",
  "/dashboard",
  "/markets",
  "/portfolio",
  "/wallet",
  "/vault",
  "/trade",
]) {
  const response = await fetch(`${base}${route}`);
  assert.equal(response.status, 200, route);
  const html = await response.text();
  assert.ok(
    html.includes("Atlas") || html.includes("ATLAS"),
    `${route} renders app shell`,
  );
}
const adminRedirect = await fetch(`${base}/admin`, { redirect: "manual" });
assert.ok(
  [307, 308].includes(adminRedirect.status),
  "Admin bookmarks redirect to the independent dashboard",
);
const health = await request("/health");
const catalog = await request("/protocol/catalog");
assert.ok(catalog.stocks.length >= 50);
const protocol = await request("/protocol/config");
assert.equal(protocol.chainId, 11155111);
assert.equal(typeof protocol.configured, "boolean");
if (!health.demo.wallet || !health.demo.worldId) {
  const { Wallet } = createRequire(
    new URL("../backend/package.json", import.meta.url),
  )("ethers");
  const signer = Wallet.createRandom();
  const challenge = await request("/auth/challenge", {
    method: "POST",
    body: { address: signer.address },
  });
  assert.match(challenge.message, /Chain ID: 11155111/);
  const authenticated = await request("/auth/verify", {
    method: "POST",
    body: {
      address: signer.address,
      signature: await signer.signMessage(challenge.message),
    },
  });
  assert.equal(authenticated.wallet.network, "Sepolia");
  await request("/profile", {
    method: "PUT",
    body: { onboardingComplete: true },
    expected: 409,
  });
  assert.equal((await request("/auth/session")).wallet.address, signer.address);
  assert.equal((await request("/portfolio")).demo, true);
  await request("/auth/logout", { method: "POST", body: {} });
  await request("/portfolio", { expected: 401 });
  console.log(
    "PASS: all routes, Sepolia signed authentication, session restoration, onboarding verification gate and logout. World App proof and MetaMask transfer require manual testing.",
  );
  process.exit(0);
}
await request("/auth/session", { expected: 401 });
const { wallet } = await request("/auth/demo", { method: "POST", body: {} });
assert.equal(wallet.demo, true);
await request("/profile", {
  method: "PUT",
  body: { onboardingComplete: true },
  expected: 409,
});
await request("/profile", {
  method: "PUT",
  body: {
    selectedMarkets: ["india", "usa", "uk", "singapore", "europe"],
    preferredAsset: "ATLAS",
    experienceLevel: "intermediate",
    currentStep: 1,
  },
});
const verified = await request("/world-id/verify", {
  method: "POST",
  body: { demo: true },
});
assert.equal(verified.verified, true);
await request("/profile", {
  method: "PUT",
  body: { currentStep: 5, onboardingComplete: true, productTourComplete: true },
});
const session = await request("/auth/session");
assert.equal(session.wallet.address, wallet.address);
assert.equal(session.profile.onboardingComplete, true);
assert.equal(session.profile.worldIdVerified, true);
assert.equal(session.profile.preferredAsset, "ATLAS");
assert.equal(session.profile.selectedMarkets.length, 5);
const portfolio = await request("/portfolio");
assert.equal(portfolio.totalValue, 42840.45);
assert.equal(portfolio.balances.length, 2);
const markets = await request("/markets");
assert.equal(markets.markets.length, 5);
await request("/auth/logout", { method: "POST", body: {} });
await request("/portfolio", { expected: 401 });
console.log(
  "PASS: all six routes render; proxied demo auth, identity verification, preferences, session restoration, portfolio, markets and logout work.",
);
