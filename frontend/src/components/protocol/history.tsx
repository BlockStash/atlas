"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
type Tick = {
  timestamp: number;
  usd_price: string;
  usdt_price: string | null;
  source: string;
  demo: number;
};
export function StockPriceHistory({ stockId }: { stockId: string }) {
  const [ticks, setTicks] = useState<Tick[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setTicks([]);
    setError("");
    api<{ history: Tick[] }>(`/protocol/history/${stockId}`)
      .then((result) => {
        if (active) setTicks([...result.history].reverse());
      })
      .catch(() => {
        if (active) setError("Price history is temporarily unavailable.");
      });
    return () => {
      active = false;
    };
  }, [stockId]);
  const values = ticks.map((t) => Number(t.usdt_price ?? t.usd_price) / 1e8),
    lo = Math.min(...values),
    hi = Math.max(...values),
    range = hi - lo || 1;
  const points = values
    .map(
      (value, i) =>
        `${values.length === 1 ? 150 : (i * 290) / (values.length - 1) + 5},${85 - ((value - lo) / range) * 70}`,
    )
    .join(" ");
  return (
    <section className="protocol-history">
      <h3>Recorded price history</h3>
      {error ? (
        <p>{error}</p>
      ) : ticks.length === 0 ? (
        <p>
          Observations appear after the authorized backend price service
          publishes and records a snapshot.
        </p>
      ) : (
        <>
          <svg
            viewBox="0 0 300 100"
            role="img"
            aria-label="Recorded USDT price observations"
          >
            <polyline
              points={points}
              fill="none"
              stroke="#91b2ff"
              strokeWidth="2"
            />
            {values.length === 1 && (
              <circle cx="150" cy="85" r="3" fill="#91b2ff" />
            )}
          </svg>
          <p>
            {ticks.length} observations ·{" "}
            {ticks[ticks.length - 1].demo ? "Demo source" : "Provider source"} ·
            latest{" "}
            {new Date(
              ticks[ticks.length - 1].timestamp * 1000,
            ).toLocaleString()}
          </p>
        </>
      )}
    </section>
  );
}
