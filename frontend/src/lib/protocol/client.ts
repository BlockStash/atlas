import {
  createWalletClient,
  custom,
  isAddress,
  parseUnits,
  parseAbiItem,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { sepoliaClient, sepolia } from "../chain";
import { walletClient } from "../wallet";
import { assertSepoliaWallet } from "../transaction-validation";
import { api } from "../api";
import abis from "./abis.json";
import catalog from "./catalog.json";
export { catalog };
import {
  countryStocks,
  countryAbi,
  type CountryConfig,
  type CountryStock,
} from "./countries";
export type Module = "atlasUSDT" | "atlasVault" | "tradingEngine";
export type ProtocolConfig = {
  configured: boolean;
  version: 2;
  chainId: 11155111;
  message?: string;
  deploymentBlock: number;
  demo: boolean;
  settlementTokenIsDemo: boolean;
  countries: CountryConfig[];
} & Record<Module, Address>;
const abiNames = {
  atlasUSDT: "AtlasUSDT",
  atlasVault: "AtlasVault",
  tradingEngine: "AtlasCountryTradingEngine",
} as const;
export const abiFor = (module: Module) => abis[abiNames[module]] as Abi;
export const stockAbi = countryAbi;
export const fetchConfig = () => api<ProtocolConfig>("/protocol/config");
export function units(value: string, decimals: number) {
  if (!new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${decimals}})?$`).test(value))
    throw new Error(
      `Enter a positive decimal with at most ${decimals} fractional digits.`,
    );
  const result = parseUnits(value, decimals);
  if (result <= 0n) throw new Error("Enter an amount greater than zero.");
  return result;
}
export async function read(
  config: ProtocolConfig,
  module: Module,
  name: string,
  args: readonly unknown[] = [],
) {
  return sepoliaClient.readContract({
    address: config[module],
    abi: abiFor(module),
    functionName: name,
    args,
  });
}
export type Overview = {
  walletAssets: bigint;
  shares: bigint;
  underlying: bigint;
  totalAssets: bigint;
  totalShares: bigint;
  sharePrice: bigint;
  feeBps: bigint;
  reservedShares: bigint;
  treasury: Address;
  treasuryAssets: bigint;
  uniqueDepositors: bigint;
  stockCount: bigint;
  buyAssets: bigint;
  sellAssets: bigint;
  vaultPaused: boolean;
  enginePaused: boolean;
};
export async function overview(
  config: ProtocolConfig,
  account: Address,
): Promise<Overview> {
  const calls: [Module, string, readonly unknown[]][] = [
    ["atlasUSDT", "decimals", []],
    ["atlasVault", "asset", []],
    ["atlasUSDT", "balanceOf", [account]],
    ["atlasVault", "balanceOf", [account]],
    ["atlasVault", "totalAssets", []],
    ["atlasVault", "totalSupply", []],
    ["atlasVault", "convertToAssets", [1000000000000n]],
    ["tradingEngine", "tradingFeeBps", []],
    ["tradingEngine", "totalReservedShares", []],
    ["tradingEngine", "treasury", []],
    ["atlasVault", "uniqueDepositors", []],
    ["tradingEngine", "cumulativeBuyAssets", [account]],
    ["tradingEngine", "cumulativeSellAssets", [account]],
    ["atlasVault", "paused", []],
    ["tradingEngine", "paused", []],
  ];
  const result = await sepoliaClient.multicall({
    contracts: calls.map(([module, name, args]) => ({
      address: config[module],
      abi: abiFor(module),
      functionName: name,
      args,
    })),
    allowFailure: false,
  });
  if (
    Number(result[0]) !== 6 ||
    (result[1] as string).toLowerCase() !== config.atlasUSDT.toLowerCase()
  )
    throw new Error(
      "Settlement token configuration does not match the deployed vault.",
    );
  const underlying = (await read(config, "atlasVault", "convertToAssets", [
      result[3] as bigint,
    ])) as bigint,
    treasury = result[9] as Address;
  return {
    walletAssets: result[2] as bigint,
    shares: result[3] as bigint,
    totalAssets: result[4] as bigint,
    totalShares: result[5] as bigint,
    sharePrice: result[6] as bigint,
    feeBps: result[7] as bigint,
    reservedShares: result[8] as bigint,
    treasury,
    treasuryAssets: (await read(config, "atlasUSDT", "balanceOf", [
      treasury,
    ])) as bigint,
    uniqueDepositors: result[10] as bigint,
    stockCount: (
      await Promise.all(
        config.countries.map((c) =>
          sepoliaClient.readContract({
            address: c.address,
            abi: countryAbi,
            functionName: "stockCount",
          }),
        ),
      )
    ).reduce<bigint>((sum, n) => sum + BigInt(n as bigint), 0n),
    buyAssets: result[11] as bigint,
    sellAssets: result[12] as bigint,
    vaultPaused: result[13] as boolean,
    enginePaused: result[14] as boolean,
    underlying,
  };
}
export type StockView = CountryStock;
export const stocks = countryStocks;
export async function approveCountry(
  config: ProtocolConfig,
  account: Address,
  country: Address,
  onState: (state: TxState) => void,
) {
  const approved = await sepoliaClient.readContract({
    address: country,
    abi: countryAbi,
    functionName: "isApprovedForAll",
    args: [account, config.tradingEngine],
  });
  if (!approved)
    await write(
      config,
      account,
      "tradingEngine",
      "setApprovalForAll",
      [config.tradingEngine, true],
      onState,
      country,
    );
}
export type TxState = {
  state: "waiting" | "submitted" | "confirmed" | "failed";
  hash?: Hash;
};
export async function write(
  config: ProtocolConfig,
  account: Address,
  module: Module,
  name: string,
  args: readonly unknown[],
  onState: (state: TxState) => void,
  token?: Address,
) {
  if (!config.configured || config.chainId !== 11155111)
    throw new Error("Configure the Sepolia protocol deployment first.");
  const provider = (await walletClient()).getProvider();
  assertSepoliaWallet(
    await provider.request({ method: "eth_chainId" }),
    (await provider.request({ method: "eth_accounts" })) as string[],
    account,
  );
  const address = token || config[module],
    abi = token ? stockAbi : abiFor(module);
  onState({ state: "waiting" });
  const simulated = await sepoliaClient.simulateContract({
    account,
    address,
    abi,
    functionName: name,
    args,
  });
  const client = createWalletClient({
      chain: sepolia,
      account,
      transport: custom(provider),
    }),
    hash = await client.writeContract({ ...simulated.request, chain: sepolia });
  onState({ state: "submitted", hash });
  let cancelled = false;
  const receipt = await sepoliaClient.waitForTransactionReceipt({
    hash,
    timeout: 180000,
    onReplaced: (r) => {
      onState({ state: "submitted", hash: r.transaction.hash });
      if (r.reason !== "repriced") cancelled = true;
    },
  });
  if (cancelled)
    throw new Error(
      "The transaction was cancelled or replaced in MetaMask. Review its explorer status before trying again.",
    );
  if (receipt.status !== "success")
    throw new Error("The transaction reverted.");
  onState({ state: "confirmed", hash: receipt.transactionHash });
  window.dispatchEvent(new Event("atlas-protocol-updated"));
  return receipt;
}
export async function approve(
  config: ProtocolConfig,
  account: Address,
  module: "atlasUSDT" | "atlasVault",
  spender: Address,
  amount: bigint,
  onState: (state: TxState) => void,
  token?: Address,
) {
  const allowance = (await sepoliaClient.readContract({
    address: token || config[module],
    abi: token ? stockAbi : abiFor(module),
    functionName: "allowance",
    args: [account, spender],
  })) as bigint;
  if (allowance >= amount) return;
  if (allowance !== 0n)
    await write(
      config,
      account,
      module,
      "approve",
      [spender, 0n],
      onState,
      token,
    );
  await write(
    config,
    account,
    module,
    "approve",
    [spender, amount],
    onState,
    token,
  );
}
export function protocolError(error: unknown) {
  const e = error as { shortMessage?: string; message?: string };
  const text = e.shortMessage || e.message || "The protocol request failed.";
  const map: Record<string, string> = {
    StalePrice:
      "The stock or FX observation has expired. An authorized updater must refresh it.",
    InvalidFeed:
      "This stock needs a new price observation for its configured feed.",
    MarketClosed: "This market is closed or its status expired.",
    InsufficientLiquidity:
      "This asset has insufficient trading-reserve liquidity for the sell. No tokens were burned.",
    Slippage: "The quote changed beyond your limit. Review a new quote.",
    ERC20InsufficientBalance: "Your token or share balance is too low.",
    ERC20InsufficientAllowance: "Approve the required token amount first.",
    AccessControlUnauthorizedAccount:
      "This wallet does not have the required onchain role.",
    InvalidTimestamp:
      "Wait for a new block and use a fresh observation timestamp.",
  };
  for (const [key, value] of Object.entries(map))
    if (text.includes(key) || (e.message || "").includes(key)) return value;
  if (/reject|denied/i.test(text))
    return "You rejected the request in MetaMask. No action was confirmed.";
  return text;
}
export async function recentTransfers(config: ProtocolConfig) {
  const latest = await sepoliaClient.getBlockNumber(),
    from =
      BigInt(config.deploymentBlock) > latest - (latest > 999n ? 999n : latest)
        ? BigInt(config.deploymentBlock)
        : latest - (latest > 999n ? 999n : latest);
  const events = await sepoliaClient.getLogs({
    address: config.atlasUSDT,
    event: parseAbiItem(
      "event Transfer(address indexed from,address indexed to,uint256 value)",
    ),
    fromBlock: from,
    toBlock: latest,
  });
  return { fromBlock: from, events: events.slice(-100).reverse() };
}
export function configuredAddresses(config: ProtocolConfig) {
  return (
    config.version === 2 &&
    config.countries?.length === 5 &&
    Object.keys(abiNames).every((key) => isAddress(config[key as Module])) &&
    config.countries.every((c) => isAddress(c.address))
  );
}
export const currencyBytes = (currency: string) =>
  `0x${Array.from(new TextEncoder().encode(currency))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
