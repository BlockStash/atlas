import "dotenv/config";
import { readFile, writeFile, mkdir, access, unlink } from "node:fs/promises";
import {
  estimateDeployment,
  deploymentError,
  sendSetupTransaction,
  marketExpiry,
} from "./deployment-utils.mjs";
import {
  ContractFactory,
  Contract,
  JsonRpcProvider,
  Wallet,
  NonceManager,
  encodeBytes32String,
  parseUnits,
  ZeroAddress,
  id,
  getAddress,
} from "ethers";
async function main() {
  const root = new URL("../", import.meta.url),
    network = process.argv[2] || "sepolia";
  if (!["local", "sepolia"].includes(network))
    throw new Error("Only local Anvil and Sepolia deployments are supported.");
  const provider = new JsonRpcProvider(
    process.env.RPC_URL || (network === "local" ? "http://127.0.0.1:8545" : ""),
    undefined,
    { cacheTimeout: -1 },
  );
  if (network === "local") provider.pollingInterval = 100;
  const chain = await provider.getNetwork(),
    expected = network === "local" ? 31337n : 11155111n;
  if (chain.chainId !== expected)
    throw new Error(`RPC chain ${chain.chainId} does not match ${network}.`);
  if (network === "sepolia" && !process.env.DEPLOYER_PRIVATE_KEY)
    throw new Error(
      "Set a dedicated funded DEPLOYER_PRIVATE_KEY in contracts/.env.",
    );
  const signer = new NonceManager(
    network === "local"
      ? await provider.getSigner(0)
      : new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider),
  );
  const deployer = await signer.getAddress(),
    admin = getAddress(process.env.ADMIN_ADDRESS || deployer),
    treasury = getAddress(process.env.TREASURY_ADDRESS || admin),
    updater = getAddress(process.env.PRICE_UPDATER_ADDRESS || deployer),
    marketAdmin = getAddress(process.env.MARKET_ADMIN_ADDRESS || admin),
    pauser = getAddress(process.env.PAUSER_ADDRESS || admin),
    minter = getAddress(process.env.MINTER_ADDRESS || admin);
  if (
    [admin, treasury, updater, marketAdmin, pauser, minter].includes(
      ZeroAddress,
    )
  )
    throw new Error("Role addresses must be nonzero.");
  const roles = {
      deployer,
      admin,
      treasury,
      updater,
      marketAdmin,
      pauser,
      minter,
    },
    catalog = JSON.parse(
      await readFile(new URL("config/stocks.json", root), "utf8"),
    );
  await mkdir(new URL("deployments/", root), { recursive: true });
  const pending = new URL(`deployments/${network}.pending.json`, root),
    final = new URL(`deployments/${network}.json`, root);
  try {
    await access(final);
    throw new Error(
      `A ${network} deployment manifest already exists. Move it aside explicitly before deploying a new protocol.`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let state;
  try {
    state = JSON.parse(await readFile(pending, "utf8"));
    if (
      state.chainId !== Number(expected) ||
      JSON.stringify(state.roles) !== JSON.stringify(roles)
    )
      throw new Error(
        "Pending deployment network or roles differ from this configuration.",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = {
      chainId: Number(expected),
      demo: true,
      settlementTokenIsDemo: !process.env.SETTLEMENT_TOKEN_ADDRESS,
      roles,
      stocks: [],
      deploymentBlock: await provider.getBlockNumber(),
    };
  }
  const save = () => writeFile(pending, JSON.stringify(state, null, 2) + "\n");
  await save();
  const artifact = async (name) =>
    JSON.parse(
      await readFile(new URL(`out/${name}.sol/${name}.json`, root), "utf8"),
    );
  async function deploy(key, name, args) {
    const a = await artifact(name);
    if (state[key]) {
      if ((await provider.getCode(state[key])) === "0x")
        throw new Error(
          `Missing code for saved ${key}; start again on a clean local chain.`,
        );
      return new Contract(state[key], a.abi, signer);
    }
    const factory = new ContractFactory(a.abi, a.bytecode.object, signer);
    const request = await factory.getDeployTransaction(...args);
    // Estimate before NonceManager reserves a nonce. RPC lag can temporarily make
    // a freshly mined dependency invisible to the estimation backend.
    const gasLimit = await estimateDeployment(
      provider,
      { ...request, from: deployer },
      {
        onRetry: (attempt) =>
          console.log(
            `${name}: RPC estimation reverted; retrying (${attempt}/3) before submission…`,
          ),
      },
    );
    const c = await factory.deploy(...args, { gasLimit });
    await c.waitForDeployment();
    state[key] = await c.getAddress();
    await save();
    console.log(`${name}: ${state[key]}`);
    return c;
  }
  async function tx(contract, method, args = []) {
    const label = `${await contract.getAddress()}.${method}`;
    try {
      return await sendSetupTransaction(
        provider,
        contract,
        deployer,
        method,
        args,
        {
          onSubmitted: (hash) =>
            console.log(
              `${method} submitted: ${hash}. Waiting for confirmation…`,
            ),
          onConfirmed: (receipt) =>
            console.log(`${method} confirmed in block ${receipt.blockNumber}.`),
          onRetry: (attempt) =>
            console.log(
              `${method}: RPC estimation reverted; retrying (${attempt}/3) before submission…`,
            ),
        },
      );
    } catch (error) {
      let decoded;
      try {
        decoded = contract.interface.parseError(error.data)?.name;
      } catch {}
      throw new Error(`${label}: ${decoded || deploymentError(error)}`);
    }
  }
  async function grant(contract, role, address) {
    if (!(await contract.hasRole(role, address)))
      await tx(contract, "grantRole", [role, address]);
  }
  const R = (name) => id(name);
  let usdt;
  if (state.settlementTokenIsDemo !== !process.env.SETTLEMENT_TOKEN_ADDRESS)
    throw new Error(
      "Settlement token configuration differs from the pending deployment.",
    );
  if (process.env.SETTLEMENT_TOKEN_ADDRESS) {
    const configuredToken = getAddress(process.env.SETTLEMENT_TOKEN_ADDRESS);
    if (state.atlasUSDT && state.atlasUSDT !== configuredToken)
      throw new Error("Settlement token address changed during deployment.");
    state.atlasUSDT = configuredToken;
    usdt = new Contract(
      state.atlasUSDT,
      ["function decimals() view returns(uint8)"],
      signer,
    );
    if ((await usdt.decimals()) !== 6n)
      throw new Error("Settlement token must have six decimals.");
    await save();
  } else usdt = await deploy("atlasUSDT", "AtlasUSDT", [deployer]);
  if ((await usdt.decimals()) !== 6n)
    throw new Error(
      "The saved settlement token must have six decimals. Keep the checkpoint and check its address and RPC.",
    );
  const vault = await deploy("atlasVault", "AtlasVault", [
    state.atlasUSDT,
    deployer,
  ]);
  const prices = await deploy("priceEngine", "AtlasPriceEngine", [deployer]);
  const registry = await deploy("marketRegistry", "AtlasMarketRegistry", [
    deployer,
  ]);
  if ((await prices.registry()) === ZeroAddress)
    await tx(prices, "bindRegistry", [state.marketRegistry]);
  const factory = await deploy("stockFactory", "AtlasStockFactory", [
    deployer,
    state.marketRegistry,
    deployer,
  ]);
  await grant(registry, R("MARKET_ADMIN_ROLE"), deployer);
  await grant(registry, R("FACTORY_ROLE"), state.stockFactory);
  await grant(factory, R("MARKET_ADMIN_ROLE"), deployer);
  const regions = [...new Set(catalog.stocks.map((s) => s.region))];
  for (const region of regions) {
    const now = (await provider.getBlock("latest")).timestamp;
    await tx(registry, "setMarket", [
      encodeBytes32String(region),
      true,
      true,
      marketExpiry(now),
    ]);
  }
  async function registeredStock(stockId, waitForVisibility = false) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await registry.getStock(stockId);
      } catch (error) {
        let decoded;
        try {
          decoded = registry.interface.parseError(error.data)?.name;
        } catch {}
        if (decoded !== "UnknownStock") throw error;
        if (!waitForVisibility) return null;
        if (attempt >= 3)
          throw new Error(
            `Stock ${stockId} was submitted but is not yet visible on the RPC. Keep the checkpoint and resume later.`,
          );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  for (const s of catalog.stocks) {
    if (state.stocks.some((x) => x.stockId === s.stockId)) continue;
    let row = await registeredStock(s.stockId);
    if (!row) {
      await tx(factory, "createStock", [
        [
          s.stockId,
          ZeroAddress,
          s.ticker,
          s.companyName,
          s.country ? `0x${Buffer.from(s.country).toString("hex")}` : "0x0000",
          encodeBytes32String(s.region),
          s.exchange,
          `0x${Buffer.from(s.nativeCurrency).toString("hex")}`,
          s.priceFeedId,
          true,
        ],
      ]);
      row = await registeredStock(s.stockId, true);
    }
    state.stocks.push({ ...s, token: row.token });
    await save();
    console.log(`Stock ${state.stocks.length}/50: ${s.ticker}`);
  }
  const engine = await deploy("tradingEngine", "AtlasTradingEngine", [
    deployer,
    state.atlasVault,
    state.marketRegistry,
    state.priceEngine,
    treasury,
  ]);
  console.log(
    "Configuring trading-engine permissions for 50 stocks (up to 100 transactions)…",
  );
  for (const [index, s] of state.stocks.entries()) {
    console.log(`Permissions ${index + 1}/${state.stocks.length}: ${s.ticker}`);
    const token = new Contract(
      s.token,
      (await artifact("AtlasStockToken")).abi,
      signer,
    );
    await grant(token, R("MINTER_ROLE"), state.tradingEngine);
    await grant(token, R("BURNER_ROLE"), state.tradingEngine);
    console.log(
      `Permissions ${index + 1}/${state.stocks.length} ready: ${s.ticker}`,
    );
  }
  console.log(
    "Stock permissions complete. Configuring protocol roles and initial prices…",
  );
  if (state.settlementTokenIsDemo) {
    await grant(usdt, R("MINTER_ROLE"), minter);
    await grant(usdt, R("PAUSER_ROLE"), pauser);
    await grant(usdt, R("TREASURY_ROLE"), treasury);
  }
  await grant(vault, R("PAUSER_ROLE"), pauser);
  await grant(engine, R("PAUSER_ROLE"), pauser);
  await grant(prices, R("PRICE_UPDATER_ROLE"), deployer);
  await grant(prices, R("PRICE_UPDATER_ROLE"), updater);
  await grant(registry, R("MARKET_ADMIN_ROLE"), marketAdmin);
  await grant(factory, R("MARKET_ADMIN_ROLE"), marketAdmin);
  // Use an observed block behind the head so an estimation backend that lags
  // slightly does not reject the observation as future-dated.
  const head = await provider.getBlockNumber();
  const now = (await provider.getBlock(Math.max(0, head - 2))).timestamp;
  await tx(prices, "updateFxRatesBatch", [
    Object.entries(catalog.fx).map(([currency, rate]) => [
      `0x${Buffer.from(currency).toString("hex")}`,
      parseUnits(rate, 8),
      now,
      now + 900,
    ]),
  ]);
  await tx(prices, "updateStockPricesBatch", [
    catalog.stocks.map((s) => [
      s.stockId,
      parseUnits(s.demoNativePrice, 8),
      now,
      now + 900,
    ]),
  ]);
  for (const region of regions)
    await tx(registry, "setMarket", [
      encodeBytes32String(region),
      true,
      true,
      marketExpiry(now),
    ]);
  if (marketAdmin !== deployer) {
    await tx(registry, "revokeRole", [R("MARKET_ADMIN_ROLE"), deployer]);
    await tx(factory, "revokeRole", [R("MARKET_ADMIN_ROLE"), deployer]);
  }
  if (updater !== deployer)
    await tx(prices, "revokeRole", [R("PRICE_UPDATER_ROLE"), deployer]);
  if ((await factory.stockAdmin()) !== admin)
    await tx(factory, "setStockAdmin", [admin]);
  if (admin !== deployer) {
    for (const c of [
      vault,
      prices,
      registry,
      factory,
      engine,
      ...(state.settlementTokenIsDemo ? [usdt] : []),
      ...(await Promise.all(
        state.stocks.map(
          async (s) =>
            new Contract(
              s.token,
              (await artifact("AtlasStockToken")).abi,
              signer,
            ),
        ),
      )),
    ])
      await tx(c, "beginDefaultAdminTransfer", [admin]);
    state.adminTransferPending = true;
  }
  state.completedAt = new Date().toISOString();
  await writeFile(final, JSON.stringify(state, null, 2) + "\n");
  await unlink(pending);
  console.log(`Deployment complete: deployments/${network}.json`);
  console.log(
    "Prices expire in 15 minutes; run the authorized price service to refresh them.",
  );
}
main().catch((error) => {
  console.error(`Deployment stopped: ${deploymentError(error)}`);
  console.error(
    "Confirmed progress is kept in deployments/<network>.pending.json. Rerun with the same configuration to resume.",
  );
  process.exitCode = 1;
});
