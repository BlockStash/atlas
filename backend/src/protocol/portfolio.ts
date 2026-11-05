import {
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
  toUtf8String,
} from "ethers";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  readCountryManifest,
  type CountryManifest,
} from "./country-catalog.js";
import abis from "./abis.json" with { type: "json" };
export type PortfolioPosition = {
  stockId: string;
  countryContract: string;
  symbol: string;
  name: string;
  market: string;
  marketName: string;
  country: string;
  exchange: string;
  quantity: string;
  priceUSDT: string | null;
  valueUSDT: string | null;
  priceUpdatedAt: number | null;
  priceValidUntil: number | null;
  status: "fresh" | "stale" | "disabled";
};
export type PortfolioSnapshot = {
  source: "sepolia";
  address: string;
  chainId: number;
  blockNumber: number;
  timestamp: number;
  settlementToken: string;
  vault: string;
  tradingEngine: string;
  walletUSDT: string;
  vaultShares: string;
  vaultAssets: string;
  walletETH: string;
  cashValueUSDT: string;
  stockValueUSDT: string | null;
  totalValueUSDT: string | null;
  positions: PortfolioPosition[];
  history: { timestamp: number; blockNumber: number; valueUSDT: string }[];
};
export interface PortfolioChain {
  head(): Promise<{ chainId: bigint; number: number; timestamp: number }>;
  read(
    address: string,
    module: "AtlasUSDT" | "AtlasVault" | "AtlasCountryMarket",
    method: string,
    args: unknown[],
    block: number,
  ): Promise<unknown>;
  balance(address: string, block: number): Promise<bigint>;
}
export class PortfolioReadError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const marketInterface = new Interface(abis.AtlasCountryMarket);
export async function collectPortfolio(
  manifest: CountryManifest,
  address: string,
  chain: PortfolioChain,
): Promise<Omit<PortfolioSnapshot, "history">> {
  const wallet = getAddress(address),
    head = await chain.head();
  if (head.chainId !== BigInt(manifest.chainId))
    throw new PortfolioReadError(
      "CHAIN_MISMATCH",
      "The portfolio RPC is not connected to the configured Sepolia network.",
    );
  const read = (
    address: string,
    module: Parameters<PortfolioChain["read"]>[1],
    method: string,
    args: unknown[] = [],
  ) => chain.read(address, module, method, args, head.number);
  const [walletAssets, shares, eth, asset, decimals] = await Promise.all([
    read(manifest.atlasUSDT, "AtlasUSDT", "balanceOf", [wallet]),
    read(manifest.atlasVault, "AtlasVault", "balanceOf", [wallet]),
    chain.balance(wallet, head.number),
    read(manifest.atlasVault, "AtlasVault", "asset"),
    read(manifest.atlasUSDT, "AtlasUSDT", "decimals"),
  ]);
  if (
    String(asset).toLowerCase() !== manifest.atlasUSDT.toLowerCase() ||
    Number(decimals) !== 6
  )
    throw new PortfolioReadError(
      "INVALID_SETTLEMENT",
      "The configured settlement token does not match the vault.",
    );
  const underlying = BigInt(
    (await read(manifest.atlasVault, "AtlasVault", "convertToAssets", [
      shares,
    ])) as bigint,
  );
  const groups = await Promise.all(
    manifest.countries.map(async (country) => {
      const count = Number(
        await read(country.address, "AtlasCountryMarket", "stockCount"),
      );
      if (!Number.isSafeInteger(count) || count < 0 || count > 1000)
        throw new Error("Invalid portfolio stock count.");
      const ids = (
        await Promise.all(
          Array.from({ length: Math.ceil(count / 100) }, (_, i) =>
            read(country.address, "AtlasCountryMarket", "listStockIds", [
              i * 100,
              100,
            ]),
          ),
        )
      ).flat() as string[];
      if (!ids.length) return [];
      const balances = (await read(
        country.address,
        "AtlasCountryMarket",
        "balanceOfBatch",
        [ids.map(() => wallet), ids.map((id) => BigInt(id))],
      )) as bigint[];
      if (balances.length !== ids.length)
        throw new Error("Incomplete stock balance response.");
      return Promise.all(
        ids
          .flatMap((id, i) =>
            BigInt(balances[i]!) > 0n
              ? [{ id, quantity: BigInt(balances[i]!) }]
              : [],
          )
          .map(async ({ id, quantity }): Promise<PortfolioPosition> => {
            const metadata = (await read(
              country.address,
              "AtlasCountryMarket",
              "getStock",
              [id],
            )) as {
              ticker: string;
              companyName: string;
              country: string;
              exchange: string;
              active: boolean;
            };
            let price: bigint | null = null,
              updated: number | null = null,
              until: number | null = null,
              status: PortfolioPosition["status"] = "fresh";
            try {
              const quote = (await read(
                country.address,
                "AtlasCountryMarket",
                "getStockPriceUSDT",
                [id],
              )) as bigint[];
              price = BigInt(quote[0]!);
              updated = Number(quote[1]);
              until = Number(quote[2]);
            } catch (error) {
              let name;
              try {
                name = marketInterface.parseError(
                  (error as { data: string }).data,
                )?.name;
              } catch {}
              if (!["StalePrice", "DisabledStock"].includes(name ?? ""))
                throw error;
              status = metadata.active ? "stale" : "disabled";
            }
            return {
              stockId: id,
              countryContract: country.address,
              symbol: metadata.ticker,
              name: metadata.companyName,
              market: country.region,
              marketName: country.label,
              country: toUtf8String(metadata.country),
              exchange: metadata.exchange,
              quantity: quantity.toString(),
              priceUSDT: price?.toString() ?? null,
              valueUSDT:
                price === null
                  ? null
                  : ((quantity * price) / 10n ** 20n).toString(),
              priceUpdatedAt: updated,
              priceValidUntil: until,
              status,
            };
          }),
      );
    }),
  );
  const positions = groups.flat();
  const cash = BigInt(walletAssets as bigint) + underlying;
  const stockValue = positions.some((p) => p.valueUSDT === null)
    ? null
    : positions.reduce((sum, p) => sum + BigInt(p.valueUSDT!), 0n);
  return {
    source: "sepolia",
    address: wallet,
    chainId: manifest.chainId,
    blockNumber: head.number,
    timestamp: head.timestamp,
    settlementToken: manifest.atlasUSDT,
    vault: manifest.atlasVault,
    tradingEngine: manifest.tradingEngine,
    walletUSDT: String(walletAssets),
    vaultShares: String(shares),
    vaultAssets: String(underlying),
    walletETH: eth.toString(),
    cashValueUSDT: cash.toString(),
    stockValueUSDT: stockValue?.toString() ?? null,
    totalValueUSDT: stockValue === null ? null : (cash + stockValue).toString(),
    positions,
  };
}
export class PortfolioHistory {
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS portfolio_snapshots(scope TEXT NOT NULL,wallet TEXT NOT NULL,block_number INTEGER NOT NULL,timestamp INTEGER NOT NULL,value_usdt TEXT,PRIMARY KEY(scope,wallet,block_number));",
    );
  }
  record(snapshot: Omit<PortfolioSnapshot, "history">) {
    const scope =
      `${snapshot.chainId}:${snapshot.settlementToken}:${snapshot.vault}:${snapshot.tradingEngine}`.toLowerCase();
    this.db
      .prepare("INSERT OR REPLACE INTO portfolio_snapshots VALUES(?,?,?,?,?)")
      .run(
        scope,
        snapshot.address.toLowerCase(),
        snapshot.blockNumber,
        snapshot.timestamp,
        snapshot.totalValueUSDT,
      );
    return (
      this.db
        .prepare(
          "SELECT timestamp,block_number,value_usdt FROM portfolio_snapshots WHERE scope=? AND wallet=? AND value_usdt IS NOT NULL ORDER BY timestamp DESC,block_number DESC LIMIT 500",
        )
        .all(scope, snapshot.address.toLowerCase()) as {
        timestamp: number;
        block_number: number;
        value_usdt: string;
      }[]
    )
      .reverse()
      .map((p) => ({
        timestamp: p.timestamp,
        blockNumber: p.block_number,
        valueUSDT: p.value_usdt,
      }));
  }
  close() {
    this.db.close();
  }
}
export function createPortfolioReader(
  historyFile = resolve(
    process.env.PORTFOLIO_HISTORY_FILE || "data/portfolio-history.sqlite",
  ),
) {
  let history: PortfolioHistory | undefined;
  const cache = new Map<
    string,
    { until: number; result: Promise<PortfolioSnapshot> }
  >();
  return async (address: string): Promise<PortfolioSnapshot> => {
    let manifest;
    try {
      manifest = await readCountryManifest();
    } catch {
      throw new PortfolioReadError(
        "PROTOCOL_NOT_CONFIGURED",
        "Configure the v2 Sepolia deployment before viewing onchain balances.",
      );
    }
    const key =
        `${manifest.tradingEngine}:${getAddress(address)}`.toLowerCase(),
      existing = cache.get(key);
    if (existing && existing.until > Date.now()) return existing.result;
    for (const [key, entry] of cache)
      if (entry.until < Date.now()) cache.delete(key);
    const result = (async () => {
      const rpc = new JsonRpcProvider(
        process.env.PROTOCOL_RPC_URL ||
          "https://ethereum-sepolia-rpc.publicnode.com",
        undefined,
        { cacheTimeout: -1 },
      );
      try {
        const chain: PortfolioChain = {
          head: async () => {
            const [network, block] = await Promise.all([
              rpc.getNetwork(),
              rpc.getBlock("latest"),
            ]);
            if (!block) throw new Error("Missing block.");
            return {
              chainId: network.chainId,
              number: block.number,
              timestamp: block.timestamp,
            };
          },
          read: async (address, module, method, args, block) =>
            new Contract(address, abis[module], rpc).getFunction(method)(
              ...args,
              { blockTag: block },
            ),
          balance: (address, block) => rpc.getBalance(address, block),
        };
        const snapshot = await collectPortfolio(manifest, address, chain);
        history ??= new PortfolioHistory(historyFile);
        return { ...snapshot, history: history.record(snapshot) };
      } catch (error) {
        if (error instanceof PortfolioReadError) throw error;
        throw new PortfolioReadError(
          "PORTFOLIO_UNAVAILABLE",
          "Could not read your Sepolia holdings. Retry to refresh your portfolio.",
        );
      } finally {
        rpc.destroy();
      }
    })();
    cache.set(key, { until: Date.now() + 3000, result });
    try {
      return await result;
    } catch (e) {
      cache.delete(key);
      throw e;
    }
  };
}
