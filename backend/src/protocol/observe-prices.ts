import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import abis from "./abis.json" with { type: "json" };
import type { CountryManifest, CatalogStock } from "./country-catalog.js";
import {
  normalizeSnapshot,
  type Currency,
  type PriceHistoryStore,
} from "./price-service.js";
// Read-only chain observation also captures prices published through the standalone wallet UI.
export async function observePrice(
  manifest: CountryManifest,
  stockId: string,
  history: PriceHistoryStore,
) {
  const rpc = new JsonRpcProvider(
    process.env.PROTOCOL_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com",
  );
  try {
    for (const country of manifest.countries) {
      const market = new Contract(
        country.address,
        abis.AtlasCountryMarket,
        rpc,
      );
      let stock;
      try {
        stock = await market.getFunction("getStock")(stockId);
      } catch (e) {
        let reason;
        try {
          reason = market.interface.parseError(
            (e as { data: string }).data,
          )?.name;
        } catch {}
        if (reason === "UnknownStock") continue;
        throw e;
      }
      let quote;
      try {
        quote = await market.getFunction("getStockPriceUSDT")(stockId);
      } catch (e) {
        let reason;
        try {
          reason = market.interface.parseError(
            (e as { data: string }).data,
          )?.name;
        } catch {}
        if (reason === "StalePrice" || reason === "DisabledStock") return;
        throw e;
      }
      const [native, fx, usdt, maxAge, block] = await Promise.all([
        market.getFunction("nativePrices")(stockId),
        market.getFunction("fxUsd")(),
        market.getFunction("usdtUsd")(),
        market.getFunction("maxPriceAge")(),
        rpc.getBlock("latest"),
      ]);
      const registered: CatalogStock = {
        stockId,
        ticker: stock.ticker,
        companyName: stock.companyName,
        country: "",
        region: country.region,
        exchange: stock.exchange,
        nativeCurrency: country.currency,
        priceFeedId: stock.priceFeedId,
        demoNativePrice: "0",
      };
      const normalized = normalizeSnapshot(
        {
          source: "onchain-observation",
          demo: true,
          stocks: [
            {
              stockId,
              ticker: stock.ticker,
              nativePrice: formatUnits(native.value, 8),
              currency: country.currency as Currency,
              timestamp: Number(quote[1]),
            },
          ],
          fx: [
            {
              currency: country.currency as Currency,
              usdPerNative: formatUnits(fx.value, 8),
              timestamp: Number(fx.updatedAt),
            },
          ],
          usdt: {
            usdPrice: formatUnits(usdt.value, 8),
            timestamp: Number(usdt.updatedAt),
          },
        },
        block!.timestamp,
        Number(maxAge),
        [registered],
      );
      history.record(normalized);
      return;
    }
  } finally {
    rpc.destroy();
  }
}
