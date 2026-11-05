import "dotenv/config";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet, NonceManager, id } from "ethers";
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
async function publish() {
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
  const provider = new JsonRpcProvider(
    process.env.PROTOCOL_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com",
    undefined,
    { cacheTimeout: -1 },
  );
  try {
    if (Number((await provider.getNetwork()).chainId) !== raw.chainId)
      throw Error("The RPC network does not match the deployment.");
    const local =
      raw.chainId === 31337 &&
      process.env.PRICE_UPDATER_UNLOCKED_LOCAL === "true";
    if (!local && !process.env.PRICE_UPDATER_PRIVATE_KEY)
      throw Error("Configure a dedicated backend PRICE_UPDATER_PRIVATE_KEY.");
    if (local) provider.pollingInterval = 100;
    const signer = new NonceManager(
      local
        ? await provider.getSigner(0)
        : new Wallet(process.env.PRICE_UPDATER_PRIVATE_KEY!, provider),
    );
    const account = await signer.getAddress(),
      catalog = await loadCountryCatalog(manifest, provider);
    const block = await provider.getBlock(
      Math.max(0, (await provider.getBlockNumber()) - 2),
    );
    if (!block) throw Error("Could not read a confirmed timestamp.");
    const source =
      process.env.PRICE_SOURCE === "http"
        ? new HttpPriceProvider(
            process.env.PRICE_PROVIDER_URL || "",
            process.env.PRICE_PROVIDER_TOKEN,
          )
        : new DemoPriceProvider(block.timestamp, catalog.stocks);
    const input = await source.snapshot();
    const history = new PriceHistoryStore(
      resolve(process.env.PRICE_HISTORY_FILE || "data/prices.sqlite"),
    );
    try {
      for (const country of manifest.countries) {
        const market = new Contract(
          country.address,
          abis.AtlasCountryMarket,
          signer,
        );
        const owner = String(await market.getFunction("owner")());
        if (
          owner.toLowerCase() !== account.toLowerCase() &&
          !(await market.getFunction("hasRole")(
            id("PRICE_UPDATER_ROLE"),
            account,
          )) &&
          !(await market.getFunction("hasRole")(id("ADMIN_ROLE"), account))
        )
          throw Error(
            `Signer is not authorized to publish ${country.label} prices.`,
          );
        const normalized = normalizeSnapshot(
          input,
          Math.max(
            Math.floor(Date.now() / 1000),
            (await provider.getBlock("latest"))!.timestamp,
          ),
          Number(await market.getFunction("maxPriceAge")()),
          catalog.stocks,
        );
        const known = new Set(
          catalog.stocks
            .filter((s) => s.region === country.region && s.active)
            .map((s) => s.stockId),
        );
        let stocks = normalized.stocks.filter((s) => known.has(s.stockId));
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
        const tx = await market.getFunction("publishPrices")(
          stocks.map((s) => [s.stockId, s.nativePrice]),
          fx.rate,
          normalized.usdt.price,
          observed,
          observed + Number(await market.getFunction("maxPriceAge")()),
        );
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
    await new Promise((r) => setTimeout(r, 60000));
  } while (true);
}
void main();
