import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  custom,
  type Abi,
  type Address,
  type Hash,
  parseUnits,
  isAddress,
  zeroAddress,
} from "viem";
import { sepolia } from "viem/chains";
import abis from "./abis.json";
export { abis, isAddress, zeroAddress, parseUnits };
export const rpc =
  import.meta.env.VITE_SEPOLIA_RPC_URL || "https://sepolia.gateway.tenderly.co";
const rpcUrls = [
  ...new Set([
    rpc,
    "https://sepolia.gateway.tenderly.co",
    "https://ethereum-sepolia-rpc.publicnode.com",
  ]),
];
export const client = createPublicClient({
  chain: sepolia,
  transport: fallback(
    rpcUrls.map((url) => http(url, { timeout: 10000, retryCount: 0 })),
    { retryCount: 1, retryDelay: 1000 },
  ),
});
export const marketAbi = abis.AtlasCountryMarket as Abi;
export type Country = {
  region: string;
  label: string;
  currency: string;
  address: Address;
};
export type Config = {
  configured: boolean;
  message?: string;
  version: 2;
  chainId: 11155111;
  atlasUSDT: Address;
  atlasVault: Address;
  tradingEngine: Address;
  implementation: Address;
  settlementTokenIsDemo: boolean;
  countries: Country[];
};
export type Stock = {
  stockId: `0x${string}`;
  ticker: string;
  companyName: string;
  country: `0x${string}`;
  exchange: string;
  priceFeedId: `0x${string}`;
  active: boolean;
  native: bigint;
  price: bigint | null;
  usd: bigint | null;
  updatedAt: number;
  validUntil: number;
  supply: bigint;
};
export type Observation = readonly [bigint, bigint, bigint];
export const roles = [
  "ADMIN_ROLE",
  "STOCK_ADMIN_ROLE",
  "PRICE_UPDATER_ROLE",
  "MARKET_ADMIN_ROLE",
  "PAUSER_ROLE",
] as const;
export type Role = (typeof roles)[number];
export type State = {
  owner: Address;
  pendingOwner: Address;
  engine: Address;
  paused: boolean;
  enabled: boolean;
  open: boolean;
  marketUntil: number;
  maxAge: number;
  version: number;
  fx: Observation;
  usdt: Observation;
  roles: Record<string, boolean>;
  stocks: Stock[];
};
export const read = (
  address: Address,
  name: string,
  args: readonly unknown[] = [],
  abi: Abi = marketAbi,
) => client.readContract({ address, abi, functionName: name, args });
export async function readCountry(
  country: Country,
  account: Address,
): Promise<State> {
  const names = [
    "owner",
    "pendingOwner",
    "tradingEngine",
    "paused",
    "marketEnabled",
    "marketOpen",
    "marketValidUntil",
    "maxPriceAge",
    "version",
    "fxUsd",
    "usdtUsd",
    "stockCount",
  ];
  const result = await client.multicall({
    contracts: names.map((name) => ({
      address: country.address,
      abi: marketAbi,
      functionName: name,
    })),
    allowFailure: false,
  });
  const count = Number(result[11]);
  if (count > 1000)
    throw Error("This dashboard supports up to 1,000 stocks per market.");
  const ids = (
    await Promise.all(
      Array.from({ length: Math.ceil(count / 100) }, (_, i) =>
        read(country.address, "listStockIds", [BigInt(i * 100), 100n]),
      ),
    )
  ).flat() as string[];
  const requests = ids.flatMap((id) => [
    {
      address: country.address,
      abi: marketAbi,
      functionName: "getStock",
      args: [id],
    },
    {
      address: country.address,
      abi: marketAbi,
      functionName: "nativePrices",
      args: [id],
    },
    {
      address: country.address,
      abi: marketAbi,
      functionName: "totalSupply",
      args: [BigInt(id as string)],
    },
  ]);
  const [rows, prices, permissions] = await Promise.all([
    client.multicall({ contracts: requests, allowFailure: false }),
    client.multicall({
      contracts: ids.map((id) => ({
        address: country.address,
        abi: marketAbi,
        functionName: "getStockPriceUSDT",
        args: [id],
      })),
      allowFailure: true,
    }),
    Promise.all(
      roles.map(async (role) => {
        const { keccak256, stringToHex } = await import("viem");
        return [
          role,
          (await read(country.address, "hasRole", [
            keccak256(stringToHex(role)),
            account,
          ])) === true,
        ] as const;
      }),
    ),
  ]);
  const stocks = ids.map((id, i) => {
    const stock = rows[i * 3] as Omit<
      Stock,
      "native" | "price" | "usd" | "updatedAt" | "validUntil" | "supply"
    >;
    const observation = rows[i * 3 + 1] as Observation;
    const price =
      prices[i].status === "success"
        ? (prices[i].result as readonly bigint[])
        : null;
    return {
      ...stock,
      stockId: id as `0x${string}`,
      native: observation[0],
      price: price?.[0] ?? null,
      usd: price?.[3] ?? null,
      updatedAt: Number(price?.[1] ?? observation[1]),
      validUntil: Number(price?.[2] ?? observation[2]),
      supply: rows[i * 3 + 2] as bigint,
    };
  });
  return {
    owner: result[0] as Address,
    pendingOwner: result[1] as Address,
    engine: result[2] as Address,
    paused: result[3] as boolean,
    enabled: result[4] as boolean,
    open: result[5] as boolean,
    marketUntil: Number(result[6]),
    maxAge: Number(result[7]),
    version: Number(result[8]),
    fx: result[9] as Observation,
    usdt: result[10] as Observation,
    roles: Object.fromEntries(permissions),
    stocks,
  };
}
export type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (name: string, handler: (value: unknown) => void) => void;
  removeListener?: (name: string, handler: (value: unknown) => void) => void;
};
export const injected = () =>
  (window as unknown as { ethereum?: Provider }).ethereum;
export type Tx = {
  status: "signature" | "submitted" | "confirmed" | "failed";
  hash?: Hash;
  label: string;
};
export async function write(
  address: Address,
  name: string,
  args: readonly unknown[],
  account: Address,
  update: (tx: Tx) => void,
  abi: Abi = marketAbi,
) {
  const provider = injected();
  if (!provider) throw Error("Install an Ethereum wallet such as MetaMask.");
  const chain = await provider.request({ method: "eth_chainId" }),
    accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  if (
    chain !== "0xaa36a7" ||
    accounts[0]?.toLowerCase() !== account.toLowerCase()
  )
    throw Error("Reconnect the selected wallet on Sepolia before continuing.");
  update({ status: "signature", label: name });
  const simulation = await client.simulateContract({
    address,
    abi,
    functionName: name,
    args,
    account,
  });
  const wallet = createWalletClient({
    chain: sepolia,
    account,
    transport: custom(provider),
  });
  const hash = await wallet.writeContract({
    ...simulation.request,
    chain: sepolia,
  });
  update({ status: "submitted", hash, label: name });
  let cancelled = false;
  const receipt = await client.waitForTransactionReceipt({
    hash,
    timeout: 180000,
    onReplaced: (r) => {
      if (r.reason !== "repriced") cancelled = true;
      update({ status: "submitted", hash: r.transaction.hash, label: name });
    },
  });
  if (cancelled || receipt.status !== "success")
    throw Error(
      "Transaction was replaced, cancelled or reverted. Check the explorer before retrying.",
    );
  update({ status: "confirmed", hash: receipt.transactionHash, label: name });
  return receipt;
}
export function amount(value: string, decimals = 8) {
  if (!new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${decimals}})?$`).test(value))
    throw Error(
      `Use a positive decimal with up to ${decimals} decimal places.`,
    );
  const n = parseUnits(value, decimals);
  if (n <= 0n) throw Error("Amount must be greater than zero.");
  return n;
}
export function message(error: unknown) {
  const e = error as { shortMessage?: string; message?: string };
  if (
    /request exceeds defined limit|rate limit|too many requests/i.test(
      `${e.shortMessage || ""} ${e.message || ""}`,
    )
  )
    return "The Sepolia RPC provider is limiting requests. Wait a moment and refresh state, or configure another VITE_SEPOLIA_RPC_URL in admin/.env.local.";
  return e.shortMessage || e.message || "The request failed.";
}
