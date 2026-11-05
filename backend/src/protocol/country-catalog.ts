import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Contract, JsonRpcProvider, toUtf8String, formatUnits } from "ethers";
import abis from "./abis.json" with { type: "json" };
import fixture from "./catalog.json" with { type: "json" };
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((a) => !/^0x0{40}$/i.test(a));
const country = z.object({
  region: z.enum(["india", "usa", "uk", "singapore", "europe"]),
  label: z.string(),
  currency: z.enum(["INR", "USD", "GBP", "SGD", "EUR"]),
  address,
});
export const countryManifest = z
  .object({
    version: z.literal(2),
    chainId: z.literal(11155111),
    atlasUSDT: address,
    atlasVault: address,
    tradingEngine: address,
    implementation: address,
    deploymentBlock: z.number().int().nonnegative(),
    demo: z.boolean(),
    settlementTokenIsDemo: z.boolean(),
    countries: z.array(country).length(5),
  })
  .refine(
    (c) =>
      new Set(c.countries.map((x) => x.region)).size === 5 &&
      new Set(c.countries.map((x) => x.address.toLowerCase())).size === 5,
    "Five distinct market proxies are required.",
  );
export type CountryManifest = z.infer<typeof countryManifest>;
export type CatalogStock = {
  stockId: string;
  ticker: string;
  companyName: string;
  country: string;
  region: string;
  exchange: string;
  nativeCurrency: string;
  priceFeedId: string;
  demoNativePrice: string;
  token?: string;
  active?: boolean;
};
export async function readCountryManifest() {
  return countryManifest.parse(
    JSON.parse(
      await readFile(
        resolve(
          process.env.PROTOCOL_DEPLOYMENT_FILE ||
            "../contracts/deployments/sepolia-v2.json",
        ),
        "utf8",
      ),
    ),
  );
}
export async function loadCountryCatalog(
  manifest: Pick<CountryManifest, "countries">,
  provider?: JsonRpcProvider,
) {
  const rpc =
    provider ??
    new JsonRpcProvider(
      process.env.PROTOCOL_RPC_URL ||
        "https://ethereum-sepolia-rpc.publicnode.com",
    );
  try {
    const groups = await Promise.all(
      manifest.countries.map(async (country) => {
        const market = new Contract(
          country.address,
          abis.AtlasCountryMarket,
          rpc,
        );
        const count = Number(await market.getFunction("stockCount")());
        if (count > 1000)
          throw Error(
            "This POC supports reading up to 1,000 stocks per market.",
          );
        const ids = (
          await Promise.all(
            Array.from({ length: Math.ceil(count / 100) }, (_, i) =>
              market.getFunction("listStockIds")(i * 100, 100),
            ),
          )
        ).flat() as string[];
        return Promise.all(
          ids.map(async (id): Promise<CatalogStock> => {
            const stock = await market.getFunction("getStock")(id),
              price = await market.getFunction("nativePrices")(id);
            return {
              stockId: id,
              ticker: stock.ticker,
              companyName: stock.companyName,
              country: toUtf8String(stock.country),
              region: country.region,
              exchange: stock.exchange,
              nativeCurrency: country.currency,
              priceFeedId: stock.priceFeedId,
              token: country.address,
              active: stock.active,
              demoNativePrice:
                fixture.stocks.find((s) => s.stockId === id)?.demoNativePrice ??
                formatUnits(price.value, 8),
            };
          }),
        );
      }),
    );
    return { stocks: groups.flat(), fx: fixture.fx };
  } finally {
    if (!provider) rpc.destroy();
  }
}
