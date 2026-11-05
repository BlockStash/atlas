import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  JsonRpcProvider,
  Contract,
  NonceManager,
  parseUnits,
  decodeBytes32String,
} from "ethers";
const root = new URL("../", import.meta.url),
  m = JSON.parse(
    await readFile(new URL("deployments/local.json", root), "utf8"),
  );
const provider = new JsonRpcProvider(
  process.env.RPC_URL || "http://127.0.0.1:8545",
);
provider.pollingInterval = 100;
assert.equal((await provider.getNetwork()).chainId, 31337n, "Local test only");
const admin = new NonceManager(await provider.getSigner(0)),
  alice = new NonceManager(await provider.getSigner(1)),
  bob = new NonceManager(await provider.getSigner(2));
const a = await alice.getAddress(),
  b = await bob.getAddress(),
  t = await admin.getAddress();
async function contract(name, address, signer = admin) {
  const artifact = JSON.parse(
    await readFile(new URL(`out/${name}.sol/${name}.json`, root), "utf8"),
  );
  return new Contract(address, artifact.abi, signer);
}
const usdt = await contract("AtlasUSDT", m.atlasUSDT),
  vault = await contract("AtlasVault", m.atlasVault),
  engine = await contract("AtlasTradingEngine", m.tradingEngine),
  registry = await contract("AtlasMarketRegistry", m.marketRegistry),
  prices = await contract("AtlasPriceEngine", m.priceEngine);
const tx = async (result) => {
  assert.equal((await (await result).wait()).status, 1);
};
assert.equal(await registry.stockCount(), 50n);
const regions = {};
for (const item of m.stocks) {
  const row = await registry.getStock(item.stockId);
  const region = decodeBytes32String(row.region);
  regions[region] = (regions[region] || 0) + 1;
  assert.equal(row.token, item.token);
  const p = await prices.getStockPriceUSD(item.stockId);
  assert.ok(p[0] > 0n);
}
assert.deepEqual(Object.values(regions), [10, 10, 10, 10, 10]);
console.log(
  "PASS: 50 registered stock contracts, 10 per region, with fresh stock/FX prices.",
);
await tx(usdt.mint(a, parseUnits("10000", 6)));
await tx(usdt.mint(b, parseUnits("5000", 6)));
for (const [signer, address, amount] of [
  [alice, a, "10000"],
  [bob, b, "5000"],
]) {
  await tx(usdt.connect(signer).approve(m.atlasVault, parseUnits(amount, 6)));
  const preview = await vault.previewDeposit(parseUnits(amount, 6));
  await tx(
    vault
      .connect(signer)
      .depositWithMinShares(parseUnits(amount, 6), address, preview),
  );
}
assert.equal(await vault.totalAssets(), parseUnits("15000", 6));
await tx(usdt.mint(m.atlasVault, parseUnits("100", 6)));
assert.ok(
  (await vault.convertToAssets(parseUnits("1", 12))) > parseUnits("1", 6),
);
console.log(
  "PASS: six-decimal USDT deposits, proportional aUSDT shares, and donated yield.",
);
const stock = m.stocks.find((s) => s.ticker === "AAPL"),
  token = await contract("AtlasStockToken", stock.token),
  quantity = parseUnits("2", 18),
  deadline = BigInt((await provider.getBlock("latest")).timestamp + 600);
const buy = await engine.quoteBuy(stock.stockId, quantity);
await tx(vault.connect(alice).approve(m.tradingEngine, buy[2]));
await tx(engine.connect(alice).buy(stock.stockId, quantity, buy[2], deadline));
assert.equal(await token.balanceOf(a), quantity);
const now = (await provider.getBlock("latest")).timestamp;
await tx(
  prices.updateStockPrice(stock.stockId, parseUnits("300", 8), now, now + 900),
);
await tx(token.connect(alice).approve(m.tradingEngine, quantity));
await assert.rejects(
  engine.connect(alice).sell.staticCall(stock.stockId, quantity, 0, deadline),
);
assert.equal(await token.balanceOf(a), quantity);
const subsidy = await vault.previewWithdraw(parseUnits("200", 6));
await tx(vault.connect(bob).approve(m.tradingEngine, subsidy));
await tx(engine.connect(bob).fundReserve(stock.stockId, subsidy));
const sell = await engine.quoteSell(stock.stockId, quantity);
await tx(
  engine.connect(alice).sell(stock.stockId, quantity, sell[2], deadline),
);
assert.equal(await token.balanceOf(a), 0n);
assert.equal(
  await vault.balanceOf(m.tradingEngine),
  await engine.totalReservedShares(),
);
assert.ok((await vault.balanceOf(t)) > 0n);
console.log(
  "PASS: buy, fees, reserve-limited profit rejection, funded sell, and reserve conservation.",
);
const shares = await vault.balanceOf(a),
  assets = await vault.previewRedeem(shares);
await tx(vault.connect(alice).redeemWithMinAssets(shares, a, a, assets));
assert.equal(await vault.balanceOf(a), 0n);
assert.ok((await usdt.balanceOf(a)) > parseUnits("10000", 6));
let claims = 0n;
for (const who of [a, b, t, m.tradingEngine])
  claims += await vault.previewRedeem(await vault.balanceOf(who));
assert.ok(claims <= (await vault.totalAssets()));
console.log(
  "PASS: withdrawal and final claims <= vault assets. Full local protocol flow passed.",
);
