import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPortfolioAmount,
  portfolioAtTime,
  portfolioHistory,
  type PortfolioSnapshot,
} from "../src/lib/portfolio";
test("balances format integer units without losing large-value precision", () => {
  assert.equal(
    formatPortfolioAmount("9007199254740993000001", 6),
    "9,007,199,254,740,993.000001",
  );
  assert.equal(formatPortfolioAmount("1250000000000000000", 18), "1.25");
  assert.equal(formatPortfolioAmount("1", 18, 8), "<0.00000001");
});
test("expired quote quantities stay visible while current valuation becomes unavailable", () => {
  const p = {
    cashValueUSDT: "1000000",
    positions: [
      {
        quantity: "1000000000000000000",
        priceUSDT: "27000000000",
        valueUSDT: "270000000",
        priceValidUntil: 100,
        status: "fresh",
      },
    ],
  } as PortfolioSnapshot;
  const expired = portfolioAtTime(p, 101);
  assert.equal(expired.positions[0].quantity, "1000000000000000000");
  assert.equal(expired.totalValueUSDT, null);
  assert.equal(portfolioAtTime(p, 99).totalValueUSDT, "271000000");
});
test("chart periods use only real observations within the selected window", () => {
  const points = [
    { timestamp: 1, blockNumber: 1, valueUSDT: "100" },
    { timestamp: 100000, blockNumber: 2, valueUSDT: "200" },
  ];
  assert.deepEqual(portfolioHistory(points, "1D", 100000), [points[1]]);
  assert.deepEqual(portfolioHistory(points, "ALL", 100000), points);
});
