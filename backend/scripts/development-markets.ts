import "dotenv/config";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  id,
} from "ethers";
import abis from "../src/protocol/abis.json" with { type: "json" };
import { readCountryManifest } from "../src/protocol/country-catalog.js";

export async function openDevelopmentMarkets() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ATLAS_DEVELOPMENT_MARKETS !== "true"
  )
    throw Error(
      "Development market renewal requires ATLAS_DEVELOPMENT_MARKETS=true outside production.",
    );
  const secret =
    process.env.MARKET_ADMIN_PRIVATE_KEY ||
    process.env.PRICE_UPDATER_PRIVATE_KEY;
  if (!secret)
    throw Error(
      "Configure a dedicated MARKET_ADMIN_PRIVATE_KEY or authorised PRICE_UPDATER_PRIVATE_KEY.",
    );
  const manifest = await readCountryManifest();
  const request = new FetchRequest(
    process.env.PROTOCOL_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com",
  );
  request.timeout = 10000;
  const rpc = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
  try {
    if (
      Number((await rpc.getNetwork()).chainId) !== 11155111 ||
      manifest.chainId !== 11155111
    )
      throw Error("Development market renewal is restricted to Sepolia.");
    const signer = new NonceManager(new Wallet(secret, rpc));
    const account = await signer.getAddress();
    const markets = manifest.countries.map((country) => ({
      country,
      contract: new Contract(country.address, abis.AtlasCountryMarket, signer),
    }));
    // Preflight every market before making any changes. A paused market needs
    // an explicit admin decision; this keeper never overrides a pause.
    for (const { country, contract } of markets) {
      if (await contract.getFunction("paused")())
        throw Error(
          `${country.label} is paused; unpause explicitly in the admin dashboard.`,
        );
      if (
        String(await contract.getFunction("owner")()).toLowerCase() !==
          account.toLowerCase() &&
        !(await contract.getFunction("hasRole")(id("ADMIN_ROLE"), account)) &&
        !(await contract.getFunction("hasRole")(
          id("MARKET_ADMIN_ROLE"),
          account,
        ))
      )
        throw Error(
          `Signer ${account} needs MARKET_ADMIN_ROLE on ${country.label}.`,
        );
    }
    for (const { country, contract } of markets) {
      const block = await rpc.getBlock("latest");
      if (!block) throw Error("Cannot read a Sepolia timestamp.");
      const open = await contract.getFunction("isMarketOpen")();
      const until = Number(await contract.getFunction("marketValidUntil")());
      if (open && until - block.timestamp > 12 * 3600) {
        console.log(
          `${country.label}: development market open until ${new Date(until * 1000).toISOString()}; renewal not needed.`,
        );
        continue;
      }
      const validUntil = BigInt(block.timestamp + 23 * 3600);
      const estimate = await contract
        .getFunction("setMarket")
        .estimateGas(true, true, validUntil);
      const tx = await contract.getFunction("setMarket")(
        true,
        true,
        validUntil,
        { gasLimit: (estimate * 125n + 99n) / 100n },
      );
      console.log(`${country.label}: opening development market: ${tx.hash}`);
      const receipt = await rpc.waitForTransaction(tx.hash, 1, 120000);
      if (receipt?.status !== 1)
        throw Error(
          "Market update was not confirmed. Check the printed transaction hash before retrying.",
        );
      if (!(await contract.getFunction("isMarketOpen")()))
        throw Error(`${country.label} did not open.`);
    }
    console.log(
      "All five development markets checked. Onchain quote expiry rules remain enforced.",
    );
  } finally {
    rpc.destroy();
  }
}
async function main() {
  // One keeper per checkout, including when npm run dev starts it automatically.
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ATLAS_DEVELOPMENT_MARKETS !== "true"
  ) {
    console.error(
      "Development market renewal requires ATLAS_DEVELOPMENT_MARKETS=true outside production.",
    );
    process.exitCode = 1;
    return;
  }
  mkdirSync(resolve("data"), { recursive: true });
  const lock = resolve("data/development-markets.lock");
  try {
    if (readFileSync(lock, "utf8").trim() !== "") {
      const pid = Number(readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw Error(
          "Invalid development keeper lock; inspect data/development-markets.lock.",
        );
      try {
        process.kill(pid, 0);
        console.log("Development market keeper is already running.");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          console.log("Development market keeper is already running.");
          return;
        }
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      unlinkSync(lock);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    console.log("Development market keeper is already starting.");
    return;
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  process.once("exit", () => {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
    } catch {}
  });
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
  do {
    try {
      await openDevelopmentMarkets();
    } catch (error) {
      console.error(
        error instanceof Error
          ? error.message
          : "Development market renewal failed.",
      );
      process.exitCode = 1;
      return;
    }
    if (!process.argv.includes("--watch")) return;
    await new Promise((resolve) => setTimeout(resolve, 3600000));
  } while (true);
}
void main().catch(() => {
  console.error(
    "Development keeper could not start; check its lock file and configuration.",
  );
  process.exitCode = 1;
});
