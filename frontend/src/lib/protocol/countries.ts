import { sepoliaClient } from "../chain";
import { type Abi, type Address, type Hex, hexToString } from "viem";
import abis from "./abis.json";
export const countryAbi = abis.AtlasCountryMarket as Abi;
export type CountryConfig = {
  region: string;
  label: string;
  currency: string;
  address: Address;
};
export type CountryStock = {
  stockId: string;
  ticker: string;
  companyName: string;
  country: string;
  region: string;
  exchange: string;
  nativeCurrency: string;
  priceFeedId: string;
  demoNativePrice: string;
  token: Address;
  active: boolean;
  price: bigint | null;
  usdPrice: bigint | null;
  updatedAt: number;
  validUntil: number;
  balance: bigint;
  supply: bigint;
  reserve: bigint;
  nativePrice: bigint;
  fxRate: bigint | null;
  usdtUsd: bigint;
};
export async function countryStocks(
  config: { countries: CountryConfig[]; tradingEngine: Address },
  account: Address,
): Promise<CountryStock[]> {
  const groups = await Promise.all(
    config.countries.map(async (country) => {
      const call = (name: string, args: readonly unknown[] = []) =>
        sepoliaClient.readContract({
          address: country.address,
          abi: countryAbi,
          functionName: name,
          args,
        });
      const count = Number(await call("stockCount"));
      if (count > 1000)
        throw Error("This POC supports up to 1,000 stocks per market.");
      const ids = (
        await Promise.all(
          Array.from({ length: Math.ceil(count / 100) }, (_, i) =>
            call("listStockIds", [BigInt(i * 100), 100n]),
          ),
        )
      ).flat() as string[];
      const [fx, usdt] = (await Promise.all([
        call("fxUsd"),
        call("usdtUsd"),
      ])) as [readonly bigint[], readonly bigint[]];
      const requests = ids.flatMap((id) => [
        {
          address: country.address,
          abi: countryAbi,
          functionName: "getStock",
          args: [id],
        },
        {
          address: country.address,
          abi: countryAbi,
          functionName: "balanceOf",
          args: [account, BigInt(id as string)],
        },
        {
          address: country.address,
          abi: countryAbi,
          functionName: "totalSupply",
          args: [BigInt(id as string)],
        },
        {
          address: country.address,
          abi: countryAbi,
          functionName: "nativePrices",
          args: [id],
        },
        {
          address: config.tradingEngine,
          abi: abis.AtlasCountryTradingEngine as Abi,
          functionName: "reservedShares",
          args: [country.address, id],
        },
      ]);
      const results = await sepoliaClient.multicall({
        contracts: requests,
        allowFailure: false,
      });
      const prices = await sepoliaClient.multicall({
        contracts: ids.map((id) => ({
          address: country.address,
          abi: countryAbi,
          functionName: "getStockPriceUSDT",
          args: [id],
        })),
        allowFailure: true,
      });
      return ids.map((id, index) => {
        const stock = results[index * 5] as {
          ticker: string;
          companyName: string;
          country: Hex;
          exchange: string;
          priceFeedId: string;
          active: boolean;
        };
        const price =
          prices[index].status === "success"
            ? (prices[index].result as readonly bigint[])
            : null;
        const native = results[index * 5 + 3] as readonly bigint[];
        return {
          stockId: String(id),
          ticker: stock.ticker,
          companyName: stock.companyName,
          country: hexToString(stock.country),
          region: country.region,
          exchange: stock.exchange,
          nativeCurrency: country.currency,
          priceFeedId: stock.priceFeedId,
          demoNativePrice: "",
          token: country.address,
          active: stock.active,
          price: price?.[0] ?? null,
          usdPrice: price?.[3] ?? null,
          updatedAt: Number(price?.[1] ?? native[1]),
          validUntil: Number(price?.[2] ?? native[2]),
          balance: results[index * 5 + 1] as bigint,
          supply: results[index * 5 + 2] as bigint,
          reserve: results[index * 5 + 4] as bigint,
          nativePrice: native[0],
          fxRate: fx[0],
          usdtUsd: usdt[0],
        };
      });
    }),
  );
  return groups.flat();
}
