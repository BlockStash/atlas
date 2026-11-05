"use client";
import { useEffect, useState } from "react";
import { api } from "../api";
export type StockSession = {
  stockId: string;
  ticker: string;
  region: string;
  exchange: string;
  currency: "INR" | "USD" | "GBP" | "SGD" | "EUR";
  sourceUnit: string;
  sessionDate: string;
  sessionOpen: string;
  sessionClose: string;
  previousSessionDate: string;
  previousClose: string;
  source: string;
  sourceUrl: string;
  sourceAsOf: string;
  market: {
    state: "open" | "closed" | "unknown";
    observedAt: number | null;
    validUntil: number;
    source: string;
    sourceUrl: string;
  };
};
export function useStockSessions() {
  const [stocks, setStocks] = useState<StockSession[]>([]);
  const [retrievedAt, setRetrievedAt] = useState("");
  const [error, setError] = useState("");
  const [clock, setClock] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () =>
      api<{ stocks: StockSession[]; retrievedAt: string }>(
        "/protocol/stock-sessions",
      )
        .then((data) => {
          if (active) {
            setStocks(data.stocks);
            setRetrievedAt(data.retrievedAt);
            setError("");
            setClock(Math.floor(Date.now() / 1000));
          }
        })
        .catch(() => {
          if (active) setError("Historical price references are unavailable.");
        });
    void load();
    const poll = setInterval(() => void load(), 60000);
    const tick = setInterval(
      () => setClock(Math.floor(Date.now() / 1000)),
      15000,
    );
    return () => {
      active = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);
  return {
    retrievedAt,
    error,
    stocks: stocks.map((s) =>
      s.market.validUntil <= clock
        ? { ...s, market: { ...s.market, state: "unknown" as const } }
        : s,
    ),
  };
}
export const sessionAmount = (value: string, currency: string) =>
  `${Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${currency}`;
export function regionMarketState(
  stocks: StockSession[],
  region: string,
): "open" | "closed" | "partial" | "unknown" {
  const rows = stocks.filter((s) => s.region === region);
  if (!rows.length || rows.some((s) => s.market.state === "unknown"))
    return "unknown";
  const open = rows.filter((s) => s.market.state === "open").length;
  return open === rows.length ? "open" : open ? "partial" : "closed";
}
