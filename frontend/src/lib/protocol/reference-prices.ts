import { useEffect, useState } from "react";
import { api } from "../api";
export type ReferencePrice = {
  stockId: string;
  priceUSDT: string;
  timestamp: number;
  usdtTimestamp: number;
  source: string;
  indicative: true;
};
export function useReferencePrices() {
  const [prices, setPrices] = useState<ReferencePrice[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<{ prices: ReferencePrice[] }>("/protocol/market-prices")
        .then((result) => {
          if (active) setPrices(result.prices);
        })
        .catch(() => {
          if (active) setPrices([]);
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return prices;
}
