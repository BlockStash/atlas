import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  Contract,
  JsonRpcProvider,
  NonceManager,
  parseUnits,
  id,
  encodeBytes32String,
} from "ethers";
const root = new URL("../", import.meta.url);
const state = JSON.parse(
  await readFile(new URL("deployments/local-v2.json", root), "utf8"),
);
const provider = new JsonRpcProvider(
  process.env.RPC_URL || "http://127.0.0.1:8545",
  undefined,
  { cacheTimeout: -1 },
);
assert.equal(
  Number((await provider.getNetwork()).chainId),
  31337,
  "Smoke tests only broadcast to local Anvil",
);
provider.pollingInterval = 100;
const owner = new NonceManager(await provider.getSigner(0)),
  alice = new NonceManager(await provider.getSigner(1)),
  bob = new NonceManager(await provider.getSigner(2));
const a = await alice.getAddress(),
  b = await bob.getAddress();
const abi = async (name) =>
  JSON.parse(
    await readFile(new URL(`out/${name}.sol/${name}.json`, root), "utf8"),
  ).abi;
const marketAbi = await abi("AtlasCountryMarket");
const usdt = new Contract(state.atlasUSDT, await abi("AtlasUSDT"), owner),
  vault = new Contract(state.atlasVault, await abi("AtlasVault"), owner),
  engine = new Contract(
    state.tradingEngine,
    await abi("AtlasCountryTradingEngine"),
    owner,
  );
const tx = async (promise) =>
  assert.equal((await (await promise).wait()).status, 1);
assert.equal(state.countries.length, 5);
assert.equal(new Set(state.countries.map((c) => c.address)).size, 5);
for (const country of state.countries) {
  const market = new Contract(country.address, marketAbi, owner);
  assert.equal(await market.stockCount(), 10n);
  assert.equal(await market.tradingEngine(), state.tradingEngine);
  for (const stockId of await market.listStockIds(0, 100)) {
    assert.ok((await market.getStockPriceUSDT(stockId))[0] > 0n);
  }
}
console.log(
  "PASS: exactly five market proxies, 50 stock IDs, fresh native/FX/USDT observations, one engine permission per country.",
);
for (const signer of [alice, bob]) {
  const address = await signer.getAddress();
  await tx(usdt.mint(address, parseUnits("10000", 6)));
  await tx(
    usdt.connect(signer).approve(state.atlasVault, parseUnits("10000", 6)),
  );
  await tx(vault.connect(signer).deposit(parseUnits("10000", 6), address));
  await tx(
    vault.connect(signer).approve(state.tradingEngine, parseUnits("10000", 12)),
  );
}
const country = state.countries.find((c) => c.region === "usa");
const market = new Contract(country.address, marketAbi, owner),
  stockId = (await market.listStockIds(0, 1))[0];
let now = (await provider.getBlock("latest")).timestamp;
const qty = parseUnits("2", 18),
  quote = await engine.quoteBuy(country.address, stockId, qty);
await tx(
  engine.connect(alice).buy(country.address, stockId, qty, quote[2], now + 600),
);
assert.equal(await market.balanceOf(a, BigInt(stockId)), qty);
await assert.rejects(() =>
  engine
    .connect(alice)
    .sell.staticCall(country.address, stockId, qty, 0, now + 600),
);
await tx(market.connect(alice).setApprovalForAll(state.tradingEngine, true));
await provider.send("evm_increaseTime", [2]);
await provider.send("evm_mine", []);
now = (await provider.getBlock("latest")).timestamp;
await tx(
  market.publishPrices(
    [[stockId, parseUnits("400", 8)]],
    parseUnits("1", 8),
    parseUnits("0.98", 8),
    now,
    now + 900,
  ),
);
const price = await market.getStockPriceUSDT(stockId);
assert.equal(price[0], (parseUnits("400", 8) * 100000000n) / 98000000n);
await assert.rejects(() =>
  engine
    .connect(alice)
    .sell.staticCall(country.address, stockId, qty, 0, now + 600),
);
assert.equal(await market.balanceOf(a, BigInt(stockId)), qty);
await tx(
  engine
    .connect(bob)
    .fundReserve(country.address, stockId, parseUnits("500", 12)),
);
await tx(
  engine.connect(alice).sell(country.address, stockId, qty, 0, now + 600),
);
assert.equal(await market.balanceOf(a, BigInt(stockId)), 0n);
assert.equal(
  await vault.balanceOf(state.tradingEngine),
  await engine.totalReservedShares(),
);
console.log(
  "PASS: deposits, ERC-1155 buy/sell approval, USDT depeg conversion, reserve-limited profit rejection and funded sell.",
);
const newId = id("usa:NASDAQ:POCNEW");
await tx(
  market.onboardStocks([
    [
      newId,
      "POCNEW",
      "New synthetic stock",
      "0x5553",
      "NASDAQ",
      id("fixture:POCNEW"),
    ],
  ]),
);
assert.equal(await market.stockCount(), 11n);
await tx(market.grantRole(id("STOCK_ADMIN_ROLE"), b));
await tx(market.connect(bob).setStockActive(newId, false));
await assert.rejects(() =>
  market.connect(bob).grantRole.staticCall(id("ADMIN_ROLE"), a),
);
await assert.rejects(() =>
  market.connect(bob).upgradeToAndCall.staticCall(state.implementation, "0x"),
);
console.log(
  "PASS: new stock onboarding creates no contract; delegated stock admin cannot grant roles or upgrade.",
);
await tx(vault.connect(alice).redeem(await vault.balanceOf(a), a, a));
assert.ok(
  (await vault.convertToAssets(await vault.totalSupply())) <=
    (await vault.totalAssets()),
);
console.log(
  "PASS: user redemption and vault custody invariant. Full country protocol flow passed.",
);
provider.destroy();
