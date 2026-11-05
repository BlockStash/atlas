import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { id } from "ethers";
import {
  collectPortfolio,
  PortfolioHistory,
  type PortfolioChain,
} from "../src/protocol/portfolio.js";
import type { CountryManifest } from "../src/protocol/country-catalog.js";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const wallet = addr(1),
  other = addr(2),
  AAPL = id("AAPL"),
  NEW = id("NEW");
const manifest: CountryManifest = {
  version: 2,
  chainId: 11155111,
  atlasUSDT: addr(3),
  atlasVault: addr(4),
  tradingEngine: addr(5),
  implementation: addr(6),
  deploymentBlock: 1,
  demo: true,
  settlementTokenIsDemo: true,
  countries: ["india", "usa", "uk", "singapore", "europe"].map((region, i) => ({
    region: region as CountryManifest["countries"][number]["region"],
    label: region,
    currency: ["INR", "USD", "GBP", "SGD", "EUR"][i] as "USD",
    address: addr(i + 10),
  })),
};
function chain(
  options: {
    stale?: boolean;
    disabled?: boolean;
    rpcFailure?: boolean;
    newStock?: boolean;
    chainId?: bigint;
  } = {},
): PortfolioChain {
  return {
    head: async () => ({
      chainId: options.chainId ?? 11155111n,
      number: 111,
      timestamp: 1800000000,
    }),
    balance: async (address, block) => {
      assert.equal(block, 111);
      return address === wallet ? 10n ** 18n : 0n;
    },
    read: async (address, module, method, args, block) => {
      assert.equal(block, 111, "All balances/quotes come from the same block");
      if (method === "decimals") return 6n;
      if (method === "asset") return manifest.atlasUSDT;
      if (method === "balanceOf")
        return args[0] === wallet
          ? module === "AtlasUSDT"
            ? 100000000n
            : 500000000000000n
          : 0n;
      if (method === "convertToAssets")
        return BigInt(args[0] as bigint) === 0n ? 0n : 550000000n;
      const usa = address === manifest.countries[1]!.address;
      const ids = usa ? (options.newStock ? [AAPL, NEW] : [AAPL]) : [];
      if (method === "stockCount") return BigInt(ids.length);
      if (method === "listStockIds") return ids;
      if (method === "balanceOfBatch") {
        const owner = (args[0] as string[])[0];
        return ids.map((stockId) =>
          owner === wallet
            ? stockId === AAPL
              ? 1250000000000000000n
              : 2n * 10n ** 18n
            : 0n,
        );
      }
      if (method === "getStock")
        return {
          ticker: args[0] === AAPL ? "AAPL" : "NEW",
          companyName: args[0] === AAPL ? "Apple Inc." : "New stock",
          country: "0x5553",
          exchange: "NASDAQ",
          active: !options.disabled,
        };
      if (method === "getStockPriceUSDT") {
        if (options.rpcFailure) throw new Error("RPC connection lost");
        if (options.stale || options.disabled)
          throw Object.assign(new Error("unavailable"), {
            data: id(
              options.disabled ? "DisabledStock()" : "StalePrice()",
            ).slice(0, 10),
          });
        return [
          args[0] === AAPL ? 27000000000n : 1000000000n,
          1799999990n,
          1800000890n,
          27000000000n,
        ];
      }
      throw Error(`Unexpected read ${method}`);
    },
  };
}
test("portfolio reflects actual owned quantities and proportional vault assets without double counting", async () => {
  const p = await collectPortfolio(manifest, wallet, chain());
  assert.equal(p.positions.length, 1);
  assert.equal(p.positions[0]!.symbol, "AAPL");
  assert.equal(p.positions[0]!.quantity, "1250000000000000000");
  assert.equal(p.vaultShares, "500000000000000");
  assert.equal(p.vaultAssets, "550000000");
  assert.equal(p.stockValueUSDT, "337500000");
  assert.equal(p.totalValueUSDT, "987500000");
  assert.equal(p.walletETH, "1000000000000000000");
  assert.equal(p.source, "sepolia");
  assert.equal(p.blockNumber, 111);
});
test("empty wallets have zero holdings rather than illustrative fallback positions", async () => {
  const p = await collectPortfolio(manifest, other, chain());
  assert.deepEqual(p.positions, []);
  assert.equal(p.totalValueUSDT, "0");
  assert.equal(p.walletUSDT, "0");
});
test("expired or disabled prices retain owned quantities and mark totals unavailable instead of zero", async () => {
  for (const options of [{ stale: true }, { disabled: true }]) {
    const p = await collectPortfolio(manifest, wallet, chain(options));
    assert.equal(p.positions[0]!.quantity, "1250000000000000000");
    assert.equal(p.positions[0]!.valueUSDT, null);
    assert.equal(p.stockValueUSDT, null);
    assert.equal(p.totalValueUSDT, null);
    assert.equal(p.cashValueUSDT, "650000000");
  }
});
test("RPC failures are not misreported as expired quotes or empty portfolios", async () => {
  await assert.rejects(
    collectPortfolio(manifest, wallet, chain({ rpcFailure: true })),
    /RPC connection lost/,
  );
});
test("new stock IDs are discovered onchain without relying on the original sample catalog", async () => {
  const p = await collectPortfolio(manifest, wallet, chain({ newStock: true }));
  assert.equal(p.positions.length, 2);
  assert.equal(p.positions[1]!.symbol, "NEW");
  assert.equal(p.totalValueUSDT, "1007500000");
});
test("wrong-chain portfolio reads are rejected", async () => {
  await assert.rejects(
    collectPortfolio(manifest, wallet, chain({ chainId: 1n })),
    /Sepolia/,
  );
});
test("portfolio history persists exact observed values and isolates accounts and deployments", async () => {
  const folder = await mkdtemp(join(tmpdir(), "atlas-portfolio-"));
  const path = join(folder, "history.sqlite");
  let store: PortfolioHistory | undefined;
  try {
    store = new PortfolioHistory(path);
    const p = await collectPortfolio(manifest, wallet, chain());
    assert.equal(store.record(p).length, 1);
    assert.equal(store.record(p).length, 1);
    assert.equal(
      store.record({
        ...p,
        blockNumber: 112,
        timestamp: p.timestamp + 12,
        totalValueUSDT: "9007199254740993000001",
      })[1]!.valueUSDT,
      "9007199254740993000001",
    );
    assert.equal(store.record({ ...p, address: other }).length, 1);
    assert.equal(store.record({ ...p, tradingEngine: addr(999) }).length, 1);
    store.close();
    store = new PortfolioHistory(path);
    assert.equal(
      store.record({ ...p, blockNumber: 113, totalValueUSDT: null }).length,
      2,
    );
  } finally {
    store?.close();
    await rm(folder, { recursive: true, force: true });
  }
});
