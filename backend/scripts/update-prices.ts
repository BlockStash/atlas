import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet, NonceManager, id } from "ethers";
import abis from "../src/protocol/abis.json" with { type: "json" };
import {
  DemoPriceProvider,
  HttpPriceProvider,
  normalizeSnapshot,
  PriceHistoryStore,
} from "../src/protocol/price-service.js";
async function main() {
  const manifest = JSON.parse(
    await readFile(
      resolve(
        process.env.PROTOCOL_DEPLOYMENT_FILE ||
          "../contracts/deployments/sepolia.json",
      ),
      "utf8",
    ),
  );
  const provider = new JsonRpcProvider(
    process.env.PROTOCOL_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com",
  );
  const chain = await provider.getNetwork();
  if (chain.chainId === 31337n) provider.pollingInterval = 100;
  if (
    chain.chainId !== BigInt(manifest.chainId) ||
    ![11155111n, 31337n].includes(chain.chainId)
  )
    throw new Error(
      "Price updater only supports the configured Sepolia or local chain.",
    );
  const key = process.env.PRICE_UPDATER_PRIVATE_KEY;
  const localUnlocked =
    chain.chainId === 31337n &&
    process.env.PRICE_UPDATER_UNLOCKED_LOCAL === "true";
  if (!key && !localUnlocked)
    throw new Error("Configure PRICE_UPDATER_PRIVATE_KEY on the backend.");
  const signer = new NonceManager(
    localUnlocked ? await provider.getSigner(0) : new Wallet(key!, provider),
  );
  const engine = new Contract(
    manifest.priceEngine,
    abis.AtlasPriceEngine,
    signer,
  );
  if (
    !(await engine.hasRole(id("PRICE_UPDATER_ROLE"), await signer.getAddress()))
  )
    throw new Error("The configured signer does not have PRICE_UPDATER_ROLE.");
  const source =
    process.env.PRICE_SOURCE === "http"
      ? new HttpPriceProvider(
          process.env.PRICE_PROVIDER_URL || "",
          process.env.PRICE_PROVIDER_TOKEN,
        )
      : new DemoPriceProvider((await provider.getBlock("latest"))!.timestamp);
  const snapshot = normalizeSnapshot(
    await source.snapshot(),
    (await provider.getBlock("latest"))!.timestamp,
    Number(await engine.maxPriceAge()),
  );
  const fx = snapshot.fx.map((f) => [
    `0x${Buffer.from(f.currency).toString("hex")}`,
    f.rate,
    f.timestamp,
    f.validUntil,
  ]);
  const stocks = snapshot.stocks.map((s) => [
    s.stockId,
    s.nativePrice,
    s.timestamp,
    s.validUntil,
  ]);
  await (await engine.updateFxRatesBatch(fx)).wait();
  const receipt = await (await engine.updateStockPricesBatch(stocks)).wait();
  const history = new PriceHistoryStore(
    resolve(process.env.PRICE_HISTORY_FILE || "data/prices.sqlite"),
  );
  history.record(snapshot, receipt.hash);
  history.close();
  console.log(
    `Published ${stocks.length} ${snapshot.demo ? "DEMO" : "provider"} stock observations and ${fx.length} FX rates; history saved. Transaction: ${receipt.hash}`,
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Price update failed.",
  );
  process.exitCode = 1;
});
