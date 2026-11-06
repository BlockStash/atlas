import { test } from "node:test";
import assert from "node:assert/strict";
import {
  historicalSharePrices,
  sharesForStockPrice,
  type VaultPricing,
} from "../src/protocol/vault-pricing.js";

const vault: VaultPricing = {
  blockNumber: 123,
  timestamp: 1800000000,
  vault: "0xvault",
  settlementToken: "0xusdt",
  totalAssets: "999999",
  totalShares: "999999000000",
  assetsPerShare: "1000000",
  shareDecimals: 12,
  assetDecimals: 6,
  markets: [],
};
test("aUSDT stock prices use actual ERC4626 backing and adjust when the vault receives assets", () => {
  assert.equal(sharesForStockPrice(100000000n, vault), 1000000000000n);
  assert.equal(
    sharesForStockPrice(100000000n, { ...vault, totalAssets: "1999999" }),
    500000000000n,
  );
  assert.equal(sharesForStockPrice(27000000000n, vault), 270000000000000n);
});
test("unit prices round up through USDT's six decimals and aUSDT's twelve decimals", () => {
  assert.equal(sharesForStockPrice(1n, vault), 1000000n);
  assert.equal(sharesForStockPrice(100000001n, vault), 1000001000000n);
  assert.equal(
    sharesForStockPrice(100000000n, { totalAssets: "0", totalShares: "0" }),
    1000000000000n,
  );
  assert.throws(() => sharesForStockPrice(0n, vault));
});
test("historical conversions preserve the FX date and account for USDT/USD instead of assuming dollar parity", () => {
  const inputs = {
    fx: {
      date: "2026-11-05",
      base: "USD" as const,
      source: "test",
      sourceUrl: "https://example.com/fx",
      nativePerUSD: {
        USD: "1" as const,
        GBP: "0.5",
        INR: "100",
        SGD: "2",
        EUR: "0.8",
      },
    },
    usdt: { usdPrice: "0.98", timestamp: 1800000000 },
  };
  const stock = {
    currency: "GBP" as const,
    sessionDate: "2026-11-05",
    sessionClose: "100",
    sessionOpen: "101",
  };
  const prices = historicalSharePrices(stock, vault, inputs)!;
  assert.equal(prices.close.priceUSDT, "20408163265");
  assert.equal(prices.close.priceAUSDT, "204081633000000");
  assert.equal(prices.indicative, true);
  assert.equal(prices.fxDate, "2026-11-05");
  assert.equal(prices.vaultBlock, 123);
  assert.equal(
    historicalSharePrices(
      { ...stock, sessionDate: "2026-11-06" },
      vault,
      inputs,
    ),
    null,
  );
  assert.equal(historicalSharePrices(stock, vault, null), null);
});
