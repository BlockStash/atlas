import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DemoPriceProvider,
  normalizeSnapshot,
  PriceHistoryStore,
  scaledPrice,
} from "../src/protocol/price-service.js";
import { normalizeProfile } from "../src/profile-migrations.js";
test("protocol catalog has 50 unique assets, ten per market, with exact integer FX normalization", async () => {
  const fixture = await new DemoPriceProvider(1800000000).snapshot();
  const normalized = normalizeSnapshot(fixture, 1800000000);
  assert.equal(normalized.stocks.length, 50);
  assert.equal(new Set(normalized.stocks.map((s) => s.stockId)).size, 50);
  const { default: catalog } = await import("../src/protocol/catalog.json", {
    with: { type: "json" },
  });
  for (const region of ["india", "usa", "uk", "singapore", "europe"])
    assert.equal(catalog.stocks.filter((s) => s.region === region).length, 10);
  const reliance = normalized.stocks.find((s) => s.ticker === "RELIANCE")!;
  assert.equal(reliance.usdPrice, 3433734150n);
  assert.equal(
    normalized.stocks.find((s) => s.ticker === "AAPL")!.usdPrice,
    27000000000n,
  );
});
test("price service rejects floats, stale/future observations, missing FX and invalid stock mappings", async () => {
  for (const value of ["0", "-1", "1e3", "1.123456789", "NaN"])
    assert.throws(() => scaledPrice(value));
  assert.equal(scaledPrice("0.00000001"), 1n);
  const fixture = await new DemoPriceProvider(1800000000).snapshot();
  assert.throws(() => normalizeSnapshot(fixture, 1800001000), /stale/);
  assert.throws(() => normalizeSnapshot(fixture, 1799999999), /future/);
  assert.throws(
    () =>
      normalizeSnapshot(
        { ...fixture, fx: fixture.fx.filter((f) => f.currency !== "INR") },
        1800000000,
      ),
    /Missing FX/,
  );
  assert.throws(
    () =>
      normalizeSnapshot(
        { ...fixture, stocks: [{ ...fixture.stocks[0], ticker: "WRONG" }] },
        1800000000,
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      normalizeSnapshot(
        { ...fixture, stocks: [fixture.stocks[0], fixture.stocks[0]] },
        1800000000,
      ),
    /does not match/,
  );
});
test("price history stores precise strings off-chain and reopens persistently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-price-"));
  try {
    const file = join(directory, "history.sqlite"),
      snapshot = normalizeSnapshot(
        await new DemoPriceProvider(1800000000).snapshot(),
        1800000000,
      ),
      store = new PriceHistoryStore(file);
    store.record(snapshot, "0xtransaction");
    const first = store.history(snapshot.stocks[0].stockId);
    assert.equal(first.length, 1);
    assert.equal(first[0].usd_price, snapshot.stocks[0].usdPrice.toString());
    store.close();
    const reopened = new PriceHistoryStore(file);
    assert.equal(reopened.history(snapshot.stocks[0].stockId).length, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("legacy China preferences migrate to Singapore without repeating onboarding", () => {
  const profile = normalizeProfile("0xabc", {
    selectedMarkets: ["india", "china"] as never,
    onboardingComplete: true,
  });
  assert.deepEqual(profile.selectedMarkets, ["india", "singapore"]);
  assert.equal(profile.onboardingComplete, true);
});

test("USDT dollar pricing is explicit for providers and depegs change USDT units", async () => {
  const fixture = await new DemoPriceProvider(1800000000).snapshot();
  const depeg = normalizeSnapshot(
    {
      ...fixture,
      demo: false,
      usdt: { usdPrice: "0.98", timestamp: 1800000000 },
    },
    1800000000,
  );
  const apple = depeg.stocks.find((s) => s.ticker === "AAPL")!;
  assert.equal(apple.usdPrice, 27000000000n);
  assert.equal(apple.usdtPrice, (27000000000n * 100000000n) / 98000000n);
  assert.throws(
    () =>
      normalizeSnapshot(
        { ...fixture, demo: false, usdt: undefined },
        1800000000,
      ),
    /require a USD price/,
  );
  assert.throws(
    () =>
      normalizeSnapshot(
        { ...fixture, usdt: { usdPrice: "1", timestamp: 1799990000 } },
        1800000000,
      ),
    /stale/,
  );
});
test("new onchain stock metadata is supported without editing the seed catalog", async () => {
  const fixture = await new DemoPriceProvider(1800000000).snapshot();
  const row = {
    ...fixture.stocks[0],
    stockId: `0x${"ab".repeat(32)}`,
    ticker: "NEW",
  };
  const registered = {
    stockId: row.stockId,
    ticker: "NEW",
    companyName: "New company",
    country: "IN",
    region: "india",
    exchange: "NSE",
    nativeCurrency: "INR",
    priceFeedId: `0x${"cd".repeat(32)}`,
    demoNativePrice: "10",
  };
  const result = normalizeSnapshot(
    { ...fixture, stocks: [row] },
    1800000000,
    900,
    [registered],
  );
  assert.equal(result.stocks[0]!.ticker, "NEW");
  assert.throws(
    () => normalizeSnapshot({ ...fixture, stocks: [row] }, 1800000000),
    /does not match/,
  );
});
test("country configuration rejects legacy manifests and duplicate country contracts", async () => {
  const { countryManifest } =
    await import("../src/protocol/country-catalog.js");
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const countries = ["india", "usa", "uk", "singapore", "europe"].map(
    (region, i) => ({
      region,
      label: region,
      currency: ["INR", "USD", "GBP", "SGD", "EUR"][i],
      address: addr(i + 10),
    }),
  );
  const manifest = {
    version: 2,
    chainId: 11155111,
    atlasUSDT: addr(1),
    atlasVault: addr(2),
    tradingEngine: addr(3),
    implementation: addr(4),
    deploymentBlock: 0,
    demo: true,
    settlementTokenIsDemo: true,
    countries,
  };
  assert.equal(countryManifest.parse(manifest).countries.length, 5);
  assert.throws(() => countryManifest.parse({ ...manifest, version: 1 }));
  assert.throws(() =>
    countryManifest.parse({
      ...manifest,
      countries: [countries[0], countries[0], ...countries.slice(2)],
    }),
  );
});
