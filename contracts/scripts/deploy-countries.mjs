import "dotenv/config";
import { readFile, writeFile, mkdir, access, unlink } from "node:fs/promises";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  NonceManager,
  encodeBytes32String,
  parseUnits,
  id,
  getAddress,
  ZeroAddress,
} from "ethers";
import {
  estimateDeployment,
  sendSetupTransaction,
  marketExpiry,
  deploymentError,
} from "./deployment-utils.mjs";
const root = new URL("../", import.meta.url);
const labels = {
  india: "India",
  usa: "United States",
  uk: "United Kingdom",
  singapore: "Singapore",
  europe: "Europe",
};
async function main() {
  const network = process.argv[2] || "sepolia";
  if (!["local", "sepolia"].includes(network))
    throw Error("Use local or sepolia.");
  const provider = new JsonRpcProvider(
    process.env.RPC_URL || (network === "local" ? "http://127.0.0.1:8545" : ""),
    undefined,
    { cacheTimeout: -1 },
  );
  const chainId = network === "local" ? 31337 : 11155111;
  if (Number((await provider.getNetwork()).chainId) !== chainId)
    throw Error("RPC chain does not match the requested network.");
  if (network === "local") provider.pollingInterval = 100;
  if (network === "sepolia" && !process.env.DEPLOYER_PRIVATE_KEY)
    throw Error(
      "Configure the dedicated DEPLOYER_PRIVATE_KEY in contracts/.env.",
    );
  const signer = new NonceManager(
    network === "local"
      ? await provider.getSigner(0)
      : new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider),
  );
  const deployer = await signer.getAddress(),
    owner = getAddress(process.env.ADMIN_ADDRESS || deployer),
    treasury = getAddress(process.env.TREASURY_ADDRESS || owner);
  const updater = getAddress(process.env.PRICE_UPDATER_ADDRESS || deployer),
    admin = process.env.COUNTRY_ADMIN_ADDRESS
      ? getAddress(process.env.COUNTRY_ADMIN_ADDRESS)
      : null;
  if ([owner, treasury, updater, admin].includes(ZeroAddress))
    throw Error("Role addresses cannot be zero.");
  const settings = {
    deployer,
    owner,
    treasury,
    updater,
    admin,
    asset: process.env.SETTLEMENT_TOKEN_ADDRESS || null,
    vault: process.env.EXISTING_VAULT_ADDRESS || null,
  };
  if (settings.vault && !settings.asset)
    throw Error(
      "Reusing a vault requires its SETTLEMENT_TOKEN_ADDRESS too. No contracts were deployed.",
    );
  const final = new URL(`deployments/${network}-v2.json`, root),
    pending = new URL(`deployments/${network}-v2.pending.json`, root);
  await mkdir(new URL("deployments/", root), { recursive: true });
  try {
    await access(final);
    throw Error(
      "A completed country deployment already exists. Keep its manifest; do not redeploy accidentally.",
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let state;
  try {
    state = JSON.parse(await readFile(pending, "utf8"));
    if (
      JSON.stringify(state.settings) !== JSON.stringify(settings) ||
      state.chainId !== chainId
    )
      throw Error(
        "Pending deployment settings changed. Restore the same configuration to resume.",
      );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    state = {
      version: 2,
      chainId,
      demo: true,
      settings,
      deploymentBlock: await provider.getBlockNumber(),
      deployments: {},
      countries: [],
      settlementTokenIsDemo:
        !settings.asset || process.env.SETTLEMENT_TOKEN_IS_DEMO === "true",
    };
  }
  const save = () => writeFile(pending, JSON.stringify(state, null, 2) + "\n");
  await save();
  const artifact = async (name) =>
    JSON.parse(
      await readFile(new URL(`out/${name}.sol/${name}.json`, root), "utf8"),
    );
  const options = {
    onRetry: (n) => console.log(`RPC estimate retry ${n}/3`),
    onSubmitted: (hash) => console.log(`Submitted ${hash}`),
    onConfirmed: (r) => console.log(`Confirmed block ${r.blockNumber}`),
  };
  const tx = (c, method, args = []) =>
    sendSetupTransaction(provider, c, deployer, method, args, options);
  async function deploy(key, name, args) {
    const a = await artifact(name);
    let saved = state.deployments[key];
    if (saved) {
      if ((await provider.getCode(saved.address)) === "0x") {
        console.log(`Checking saved deployment ${key}: ${saved.hash}`);
        const receipt = await provider.waitForTransaction(saved.hash);
        if (receipt?.status !== 1)
          throw Error(`Saved deployment ${key} failed; inspect ${saved.hash}.`);
      }
      return new Contract(saved.address, a.abi, signer);
    }
    const f = new ContractFactory(a.abi, a.bytecode.object, signer),
      request = await f.getDeployTransaction(...args);
    const gasLimit = await estimateDeployment(
      provider,
      { ...request, from: deployer },
      options,
    );
    const c = await f.deploy(...args, { gasLimit });
    saved = {
      address: await c.getAddress(),
      hash: c.deploymentTransaction().hash,
    };
    state.deployments[key] = saved;
    await save();
    console.log(`${key} submitted: ${saved.hash}`);
    await c.waitForDeployment();
    console.log(`${key}: ${saved.address}`);
    return c;
  }
  let token;
  if (settings.asset) {
    state.atlasUSDT = getAddress(settings.asset);
    token = new Contract(
      state.atlasUSDT,
      (await artifact("AtlasUSDT")).abi,
      signer,
    );
    if ((await token.decimals()) !== 6n)
      throw Error("Settlement token must have six decimals.");
  } else {
    token = await deploy("usdt", "AtlasUSDT", [deployer]);
    state.atlasUSDT = await token.getAddress();
  }
  let vault;
  if (settings.vault) {
    state.atlasVault = getAddress(settings.vault);
    vault = new Contract(
      state.atlasVault,
      (await artifact("AtlasVault")).abi,
      signer,
    );
    if ((await vault.asset()).toLowerCase() !== state.atlasUSDT.toLowerCase())
      throw Error("Existing vault asset does not match the settlement token.");
  } else {
    vault = await deploy("vault", "AtlasVault", [state.atlasUSDT, deployer]);
    state.atlasVault = await vault.getAddress();
  }
  const implementation = await deploy(
    "implementation",
    "AtlasCountryMarket",
    [],
  );
  state.implementation = await implementation.getAddress();
  await save();
  const catalog = JSON.parse(
    await readFile(new URL("config/stocks.json", root), "utf8"),
  );
  const marketAbi = (await artifact("AtlasCountryMarket")).abi;
  for (const [region, label] of Object.entries(labels)) {
    const items = catalog.stocks.filter((s) => s.region === region),
      currency = items[0].nativeCurrency;
    const proxy = await deploy(region, "AtlasCountryProxy", [
      state.implementation,
      implementation.interface.encodeFunctionData("initialize", [
        deployer,
        encodeBytes32String(region),
        "0x" + Buffer.from(currency).toString("hex"),
      ]),
    ]);
    const address = await proxy.getAddress(),
      market = new Contract(address, marketAbi, signer);
    if (!(await market.stockCount())) {
      console.log(
        `Onboarding ${items.length} stocks into ${label}: one transaction.`,
      );
      await tx(market, "onboardStocks", [
        items.map((s) => [
          s.stockId,
          s.ticker,
          s.companyName,
          "0x" + Buffer.from(s.country).toString("hex"),
          s.exchange,
          s.priceFeedId,
        ]),
      ]);
    }
    const entry = { region, label, currency, address };
    state.countries = state.countries.filter((s) => s.region !== region);
    state.countries.push(entry);
    await save();
  }
  const engine = await deploy("engine", "AtlasCountryTradingEngine", [
    deployer,
    state.atlasVault,
    state.countries.map((s) => s.address),
    treasury,
  ]);
  state.tradingEngine = await engine.getAddress();
  await save();
  for (const country of state.countries) {
    console.log(
      `Configure ${country.label} (one engine permission for every stock).`,
    );
    const market = new Contract(country.address, marketAbi, signer);
    if (
      (await market.tradingEngine()).toLowerCase() !==
      state.tradingEngine.toLowerCase()
    )
      await tx(market, "setTradingEngine", [state.tradingEngine]);
    if (
      (updater !== deployer || owner !== deployer) &&
      !(await market.hasRole(id("PRICE_UPDATER_ROLE"), updater))
    )
      await tx(market, "grantRole", [id("PRICE_UPDATER_ROLE"), updater]);
    if (admin && !(await market.hasRole(id("ADMIN_ROLE"), admin)))
      await tx(market, "grantRole", [id("ADMIN_ROLE"), admin]);
    const block = await provider.getBlock(
      Math.max(0, (await provider.getBlockNumber()) - 2),
    );
    const entries = catalog.stocks
      .filter((s) => s.region === country.region)
      .map((s) => [s.stockId, parseUnits(s.demoNativePrice, 8)]);
    if (
      Number((await market.nativePrices(entries[0][0])).updatedAt) <
      block.timestamp
    )
      await tx(market, "publishPrices", [
        entries,
        parseUnits(catalog.fx[country.currency], 8),
        100000000n,
        block.timestamp,
        block.timestamp + 900,
      ]);
    await tx(market, "setMarket", [true, true, marketExpiry(block.timestamp)]);
  }
  for (const [c, role, account] of [
    [engine, "PAUSER_ROLE", owner],
    ...(!settings.vault ? [[vault, "PAUSER_ROLE", owner]] : []),
    ...(!settings.asset
      ? [
          [
            token,
            "MINTER_ROLE",
            getAddress(process.env.MINTER_ADDRESS || owner),
          ],
          [token, "PAUSER_ROLE", owner],
          [token, "TREASURY_ROLE", treasury],
        ]
      : []),
  ])
    if (!(await c.hasRole(id(role), account)))
      await tx(c, "grantRole", [id(role), account]);
  if (owner !== deployer) {
    for (const country of state.countries) {
      const market = new Contract(country.address, marketAbi, signer);
      if ((await market.pendingOwner()).toLowerCase() !== owner.toLowerCase())
        await tx(market, "transferOwnership", [owner]);
    }
    for (const c of [
      engine,
      ...(!settings.vault ? [vault] : []),
      ...(!settings.asset ? [token] : []),
    ]) {
      const pending = await c.pendingDefaultAdmin();
      if (pending[0].toLowerCase() !== owner.toLowerCase())
        await tx(c, "beginDefaultAdminTransfer", [owner]);
    }
    state.ownerTransfersPending = true;
  }
  state.completedAt = new Date().toISOString();
  await writeFile(final, JSON.stringify(state, null, 2) + "\n");
  await unlink(pending);
  console.log(
    `Deployment complete: deployments/${network}-v2.json. Five country market proxies; no per-stock contracts.`,
  );
  console.log(
    "Configure the backend with this v2 manifest. Demo prices expire after 15 minutes.",
  );
}
main().catch((e) => {
  console.error(`Country deployment stopped: ${deploymentError(e)}`);
  console.error(
    "Keep the v2 pending checkpoint and rerun the same command to resume.",
  );
  process.exitCode = 1;
});
