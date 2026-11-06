import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, FetchRequest, JsonRpcProvider } from "ethers";
import { z } from "zod";
import abis from "./abis.json" with { type: "json" };
import { readCountryManifest } from "./country-catalog.js";
import { scaledPrice } from "./price-service.js";
import { readUsdtObservation } from "./market-feed.js";
import {
  historicalDevelopmentMode,
  readDevelopmentUsdt,
} from "./historical-development.js";

export type VaultPricing = {
  blockNumber: number;
  timestamp: number;
  vault: string;
  settlementToken: string;
  totalAssets: string;
  totalShares: string;
  assetsPerShare: string;
  shareDecimals: 12;
  assetDecimals: 6;
  markets: { region: string; open: boolean; validUntil: number }[];
};
let cached:
  { until: number; manifest: string; value: Promise<VaultPricing> } | undefined;
export async function readVaultPricing(): Promise<VaultPricing> {
  const manifest = await readCountryManifest();
  const key = `${manifest.atlasVault}:${manifest.countries.map((c) => c.address).join(":")}:${process.env.PROTOCOL_RPC_URL}`;
  if (cached && cached.until > Date.now() && cached.manifest === key)
    return cached.value;
  const value = (async () => {
    const request = new FetchRequest(
      process.env.PROTOCOL_RPC_URL ||
        "https://ethereum-sepolia-rpc.publicnode.com",
    );
    request.timeout = 8000;
    const rpc = new JsonRpcProvider(request, undefined, {
      cacheTimeout: -1,
      batchMaxCount: 1,
    });
    try {
      const [network, block] = await Promise.all([
        rpc.getNetwork(),
        rpc.getBlock("latest"),
      ]);
      if (!block || Number(network.chainId) !== manifest.chainId)
        throw Error("Vault pricing network mismatch.");
      const vault = new Contract(manifest.atlasVault, abis.AtlasVault, rpc);
      const call = (name: string, args: unknown[] = []) =>
        vault.getFunction(name)(...args, { blockTag: block.number });
      const [
        asset,
        decimals,
        assets,
        shares,
        assetsPerShare,
        tokenDecimals,
        markets,
      ] = await Promise.all([
        call("asset"),
        call("decimals"),
        call("totalAssets"),
        call("totalSupply"),
        call("convertToAssets", [10n ** 12n]),
        new Contract(manifest.atlasUSDT, abis.AtlasUSDT, rpc).getFunction(
          "decimals",
        )({ blockTag: block.number }),
        Promise.all(
          manifest.countries.map(async (c) => {
            const market = new Contract(
              c.address,
              abis.AtlasCountryMarket,
              rpc,
            );
            const [open, until] = await Promise.all([
              market.getFunction("isMarketOpen")({ blockTag: block.number }),
              market.getFunction("marketValidUntil")({
                blockTag: block.number,
              }),
            ]);
            return {
              region: c.region,
              open: Boolean(open),
              validUntil: Number(until),
            };
          }),
        ),
      ]);
      if (
        String(asset).toLowerCase() !== manifest.atlasUSDT.toLowerCase() ||
        Number(decimals) !== 12 ||
        Number(tokenDecimals) !== 6
      )
        throw Error("Unsupported vault or settlement configuration.");
      return {
        blockNumber: block.number,
        timestamp: block.timestamp,
        vault: manifest.atlasVault,
        settlementToken: manifest.atlasUSDT,
        totalAssets: String(assets),
        totalShares: String(shares),
        assetsPerShare: String(assetsPerShare),
        shareDecimals: 12 as const,
        assetDecimals: 6 as const,
        markets,
      };
    } finally {
      rpc.destroy();
    }
  })();
  cached = { until: Date.now() + 15000, manifest: key, value };
  try {
    return await value;
  } catch (error) {
    if (cached?.value === value) cached = undefined;
    throw error;
  }
}
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** Exact AtlasVault ERC-4626 previewWithdraw rounding for one stock, before fees.
 * USDT prices use 8 decimals; assets use 6; aUSDT uses 12 and virtual offset 6.
 */
export function sharesForStockPrice(
  priceUSDT8: bigint,
  vault: Pick<VaultPricing, "totalAssets" | "totalShares">,
) {
  if (priceUSDT8 <= 0n) throw Error("A stock price must be positive.");
  const assets = BigInt(vault.totalAssets),
    shares = BigInt(vault.totalShares);
  if (assets < 0n || shares < 0n) throw Error("Invalid vault totals.");
  return ceilDiv(ceilDiv(priceUSDT8, 100n) * (shares + 1000000n), assets + 1n);
}
const fxSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  base: z.literal("USD"),
  source: z.string(),
  sourceUrl: z.url(),
  nativePerUSD: z.object({
    USD: z.literal("1"),
    INR: z.string(),
    GBP: z.string(),
    SGD: z.string(),
    EUR: z.string(),
  }),
});
export function readHistoricalPricingInputs(
  now = Math.floor(Date.now() / 1000),
) {
  try {
    const fx = fxSchema.parse(
      JSON.parse(
        readFileSync(
          resolve(process.env.FX_REFERENCE_FILE || "config/fx-reference.json"),
          "utf8",
        ),
      ),
    );
    const usdt = historicalDevelopmentMode()
      ? readDevelopmentUsdt()
      : readUsdtObservation(
          resolve(
            process.env.MARKET_FEED_CACHE_FILE || "data/market-feed.json",
          ),
          now,
          7 * 86400,
        );
    return usdt ? { fx, usdt } : null;
  } catch {
    return null;
  }
}
export function historicalSharePrices(
  stock: {
    currency: keyof z.infer<typeof fxSchema>["nativePerUSD"];
    sessionDate: string;
    sessionClose: string;
    sessionOpen: string;
  },
  vault: VaultPricing,
  inputs = readHistoricalPricingInputs(),
) {
  if (!inputs) return null;
  const { fx, usdt } = inputs;
  if (!usdt || fx.date !== stock.sessionDate) return null;
  const rate = scaledPrice(fx.nativePerUSD[stock.currency]);
  const convert = (native: string) => {
    const usd =
      (scaledPrice(native) * (10000000000000000n / rate)) / 100000000n;
    const price = (usd * 100000000n) / scaledPrice(usdt.usdPrice);
    return {
      priceUSDT: price.toString(),
      priceAUSDT: sharesForStockPrice(price, vault).toString(),
    };
  };
  return {
    close: convert(stock.sessionClose),
    open: convert(stock.sessionOpen),
    fxDate: fx.date,
    fxSource: fx.source,
    fxSourceUrl: fx.sourceUrl,
    usdtTimestamp: usdt.timestamp,
    vaultBlock: vault.blockNumber,
    indicative: true as const,
  };
}
