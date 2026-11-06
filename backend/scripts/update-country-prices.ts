import "dotenv/config";
import { resolve } from "node:path";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  NonceManager,
  FetchRequest,
  id,
} from "ethers";
import { readFile } from "node:fs/promises";
import abis from "../src/protocol/abis.json" with { type: "json" };
import {
  countryManifest,
  loadCountryCatalog,
} from "../src/protocol/country-catalog.js";
import {
  DemoPriceProvider,
  HttpPriceProvider,
  normalizeSnapshot,
  PriceHistoryStore,
} from "../src/protocol/price-service.js";
import { StreamingPriceProvider } from "../src/protocol/market-feed.js";
import {
  HistoricalDevelopmentProvider,
  assertHistoricalDevelopment,
} from "../src/protocol/historical-development.js";
import { processLock } from "../src/protocol/process-lock.js";
async function publish() {
  const checkOnly = process.argv.includes("--check");
  const raw = JSON.parse(
    await readFile(
      resolve(
        process.env.PROTOCOL_DEPLOYMENT_FILE ||
          "../contracts/deployments/sepolia-v2.json",
      ),
      "utf8",
    ),
  );
  // Local manifests are accepted only by this explicit CLI, never the public Sepolia app configuration.
  const manifest = countryManifest.parse({ ...raw, chainId: 11155111 });
  if (![11155111, 31337].includes(raw.chainId))
    throw Error("Only Sepolia or a local test chain is supported.");
  const request = new FetchRequest(
    process.env.PROTOCOL_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com",
  );
  request.timeout = 20000;
  const provider = new JsonRpcProvider(request, undefined, {
    cacheTimeout: -1,
    batchMaxCount: 1,
  });
  try {
    if (Number((await provider.getNetwork()).chainId) !== raw.chainId)
      throw Error("The RPC network does not match the deployment.");
    const local =
      raw.chainId === 31337 &&
      process.env.PRICE_UPDATER_UNLOCKED_LOCAL === "true";
    if (!checkOnly && !local && !process.env.PRICE_UPDATER_PRIVATE_KEY)
      throw Error("Configure a dedicated backend PRICE_UPDATER_PRIVATE_KEY.");
    if (local) provider.pollingInterval = 100;
    const signer = checkOnly
      ? undefined
      : new NonceManager(
          local
            ? await provider.getSigner(0)
            : new Wallet(process.env.PRICE_UPDATER_PRIVATE_KEY!, provider),
        );
    const account = signer ? await signer.getAddress() : undefined;
    console.log("Reading onboarded stocks from the five market contracts…");
    const groups = [];
    for (const country of manifest.countries) {
      groups.push(await loadCountryCatalog({ countries: [country] }, provider));
      console.log(`${country.label}: onboarded catalog read.`);
    }
    const catalog = { stocks: groups.flatMap((group) => group.stocks) };
    const block = await provider.getBlock(
      Math.max(0, (await provider.getBlockNumber()) - 2),
    );
    if (!block) throw Error("Could not read a confirmed timestamp.");
    const priceSource = process.env.PRICE_SOURCE || "demo";
    if (
      !["demo", "http", "twelvedata-kraken", "historical-development"].includes(
        priceSource,
      )
    )
      throw Error(
        "PRICE_SOURCE must be demo, http, twelvedata-kraken or historical-development.",
      );
    const historical = priceSource === "historical-development";
    const developmentAge = Number(
      process.env.DEVELOPMENT_PRICE_MAX_AGE_SECONDS || "86400",
    );
    if (historical) {
      assertHistoricalDevelopment(raw.chainId);
      if (
        !Number.isSafeInteger(developmentAge) ||
        developmentAge < 900 ||
        developmentAge > 86400
      )
        throw Error(
          "Development quote lifetime must be between 900 and 86400 seconds.",
        );
    }
    const source = historical
      ? new HistoricalDevelopmentProvider(
          block.timestamp,
          catalog.stocks,
          raw.chainId,
        )
      : priceSource === "twelvedata-kraken"
        ? new StreamingPriceProvider(
            resolve(
              process.env.MARKET_FEED_CACHE_FILE || "data/market-feed.json",
            ),
            catalog.stocks,
          )
        : priceSource === "http"
          ? new HttpPriceProvider(
              process.env.PRICE_PROVIDER_URL || "",
              process.env.PRICE_PROVIDER_TOKEN,
            )
          : new DemoPriceProvider(block.timestamp, catalog.stocks);
    const input = await source.snapshot();
    if (historical)
      console.log(
        `DEVELOPMENT FIXED PRICES: ${input.source}. Historical source dates are preserved; publication timestamps describe test-quote leases.`,
      );
    if (checkOnly) {
      for (const country of manifest.countries) {
        const stockIds = new Set(
          catalog.stocks
            .filter((s) => s.region === country.region)
            .map((s) => s.stockId),
        );
        const stocks = input.stocks.filter((s) => stockIds.has(s.stockId));
        if (!stocks.length) {
          console.log(
            `${country.label}: no fresh configured stock observations.`,
          );
          continue;
        }
        const market = new Contract(
          country.address,
          abis.AtlasCountryMarket,
          provider,
        );
        const normalized = normalizeSnapshot(
          {
            ...input,
            stocks,
            fx: input.fx.filter((f) => f.currency === country.currency),
          },
          Math.floor(Date.now() / 1000),
          historical
            ? developmentAge
            : Number(await market.getFunction("maxPriceAge")()),
          catalog.stocks,
        );
        for (const stock of normalized.stocks)
          console.log(
            `${country.label} ${stock.ticker}: ${stock.usdtPrice} (USDT price, 8 decimals); observed ${new Date(stock.timestamp * 1000).toISOString()}; expires ${new Date(stock.validUntil * 1000).toISOString()}`,
          );
      }
      console.log("Read-only check complete. No transactions sent.");
      return;
    }
    const history = new PriceHistoryStore(
      resolve(process.env.PRICE_HISTORY_FILE || "data/prices.sqlite"),
    );
    try {
      if (historical) {
        // Check every owner before changing quote lifetime on any market.
        for (const country of manifest.countries) {
          const market = new Contract(
            country.address,
            abis.AtlasCountryMarket,
            signer!,
          );
          if (
            String(await market.getFunction("owner")()).toLowerCase() !==
              account!.toLowerCase() &&
            Number(await market.getFunction("maxPriceAge")()) !== developmentAge
          )
            throw Error(
              `Owner must set ${country.label} maxPriceAge to ${developmentAge} before using this development lease.`,
            );
        }
      }
      for (const country of manifest.countries) {
        const known = new Set(
          catalog.stocks
            .filter((s) => s.region === country.region && s.active)
            .map((s) => s.stockId),
        );
        const countryStocks = input.stocks.filter((s) => known.has(s.stockId));
        if (!countryStocks.length) continue;
        const market = new Contract(
          country.address,
          abis.AtlasCountryMarket,
          signer!,
        );
        const owner = String(await market.getFunction("owner")());
        if (
          owner.toLowerCase() !== account!.toLowerCase() &&
          !(await market.getFunction("hasRole")(
            id("PRICE_UPDATER_ROLE"),
            account,
          )) &&
          !(await market.getFunction("hasRole")(id("ADMIN_ROLE"), account))
        )
          throw Error(
            `Signer is not authorized to publish ${country.label} prices.`,
          );
        if (
          historical &&
          Number(await market.getFunction("maxPriceAge")()) !== developmentAge
        ) {
          const configTx =
            await market.getFunction("setMaxPriceAge")(developmentAge);
          console.log(
            `${country.label}: setting development quote lifetime: ${configTx.hash}`,
          );
          if ((await configTx.wait()).status !== 1)
            throw Error("Development lifetime update failed.");
        }
        const normalized = normalizeSnapshot(
          {
            ...input,
            stocks: countryStocks,
            fx: input.fx.filter((f) => f.currency === country.currency),
          },
          Math.max(
            Math.floor(Date.now() / 1000),
            (await provider.getBlock("latest"))!.timestamp,
          ),
          Number(await market.getFunction("maxPriceAge")()),
          catalog.stocks,
        );
        let stocks = normalized.stocks;
        if (!stocks.length) continue;
        const fx = normalized.fx.find((f) => f.currency === country.currency);
        if (!fx) throw Error(`Missing ${country.currency} FX rate.`);
        const observed = Math.min(
          fx.timestamp,
          normalized.usdt.timestamp,
          ...stocks.map((s) => s.timestamp),
        );
        const current = await Promise.all(
          stocks.map((s) => market.getFunction("nativePrices")(s.stockId)),
        );
        if (historical) {
          const [currentFx, currentUsdt, latest] = await Promise.all([
            market.getFunction("fxUsd")(),
            market.getFunction("usdtUsd")(),
            provider.getBlock("latest"),
          ]);
          const sameBasis =
            BigInt(currentFx.value) === fx.rate &&
            BigInt(currentUsdt.value) === normalized.usdt.price;
          stocks = stocks.filter(
            (s, i) =>
              !sameBasis ||
              BigInt(current[i].value) !== s.nativePrice ||
              Math.min(
                Number(current[i].validUntil),
                Number(currentFx.validUntil),
                Number(currentUsdt.validUntil),
              ) -
                latest!.timestamp <=
                developmentAge / 2,
          );
          if (!stocks.length) {
            console.log(
              `${country.label}: fixed development prices are already valid; no renewal needed.`,
            );
            continue;
          }
        } else
          stocks = stocks.filter(
            (_, i) => Number(current[i].updatedAt) < observed,
          );
        if (!stocks.length) {
          console.log(
            `${country.label}: observations are already published or older than onchain data.`,
          );
          continue;
        }
        // A real feed may observe a quote between blocks. Wait for the chain
        // timestamp to catch up instead of fabricating an older feed timestamp.
        for (
          let attempt = 0;
          observed > (await provider.getBlock("latest"))!.timestamp;
          attempt++
        ) {
          if (attempt >= 30)
            throw Error(
              `${country.label}: waiting for the chain timestamp timed out; retry with a fresh snapshot.`,
            );
          if (attempt === 0)
            console.log(
              `${country.label}: waiting for a block at the observation timestamp.`,
            );
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        const args = [
          stocks.map((s) => [s.stockId, s.nativePrice]),
          fx.rate,
          normalized.usdt.price,
          observed,
          observed + Number(await market.getFunction("maxPriceAge")()),
        ];
        const estimated = await market
          .getFunction("publishPrices")
          .estimateGas(...args);
        const tx = await market.getFunction("publishPrices")(...args, {
          gasLimit: (estimated * 130n + 99n) / 100n,
        });
        console.log(
          `${country.label}: ${stocks.length} ${normalized.demo ? "DEMO" : "provider"} prices submitted: ${tx.hash}`,
        );
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw Error("Price publication reverted.");
        history.record({ ...normalized, stocks }, receipt.hash);
      }
    } finally {
      history.close();
    }
  } finally {
    provider.destroy();
  }
}
async function main() {
  if (
    !process.argv.includes("--check") &&
    !processLock(resolve("data/price-publisher.lock"), "Price publisher")
  )
    return;
  const interval = Number(process.env.PRICE_PUBLISH_INTERVAL_SECONDS || "60");
  if (!Number.isSafeInteger(interval) || interval < 60 || interval > 3600) {
    console.error(
      "PRICE_PUBLISH_INTERVAL_SECONDS must be an integer between 60 and 3600.",
    );
    process.exitCode = 1;
    return;
  }
  do {
    try {
      await publish();
    } catch (e) {
      console.error(
        e instanceof Error ? e.message : "Price publication failed.",
      );
      if (!process.argv.includes("--watch")) {
        process.exitCode = 1;
        return;
      }
    }
    if (!process.argv.includes("--watch")) return;
    await new Promise((r) => setTimeout(r, interval * 1000));
  } while (true);
}
void main();
