"use client";
import Link from "next/link";
import { ArrowUpRight, Globe2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { markets } from "@/lib/data";
import type { MarketPreference } from "@/lib/types";
export function AtlasLogo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand" aria-label="Atlas home">
      <span className="brand-mark">
        <svg width="29" height="29" viewBox="0 0 32 32" fill="none">
          <path
            d="M4 26 15 5h3l11 21h-6L16.5 13 10 26H4Z"
            fill="currentColor"
          />
          <path d="m13 22 3.5-6 3.5 6h-7Z" fill="#7095f4" />
        </svg>
      </span>
      {!compact && (
        <span>
          ATLAS<span className="brand-period">.</span>
        </span>
      )}
    </Link>
  );
}
export function FoxIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
      <path fill="#e87932" d="m3 3 11 8h4L29 3l-3 18-10 8L6 21Z" />
      <path fill="#f5ac67" d="m3 3 9 14-6 4Zm26 0-9 14 6 4ZM12 17h8l-4 12Z" />
      <path fill="#59392a" d="m8 15 6 2-2 3Zm16 0-6 2 2 3Zm-10 9h4l-2 3Z" />
    </svg>
  );
}
export function SecurityNote() {
  return (
    <p className="security-note">
      <ShieldCheck size={14} />
      Atlas never has access to your wallet private keys.
    </p>
  );
}
export function MarketClock({ market }: { market: MarketPreference }) {
  const [time, setTime] = useState("--:--");
  useEffect(() => {
    const tick = () =>
      setTime(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: market.zone,
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date()),
      );
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [market.zone]);
  return <span className="mono">{time}</span>;
}
export function GlobalMarketClock() {
  return (
    <div className="global-clock">
      <Globe2 size={15} />
      <span>Global market clock</span>
      <span className="status-dot" />
      <span>3 / 5 open</span>
    </div>
  );
}
export function MarketCard({
  market,
  onClick,
  selected = false,
}: {
  market: MarketPreference;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <button
      className={`market-card ${selected ? "selected" : ""}`}
      onClick={onClick}
    >
      <div className="market-card-top">
        <span className="flag">{market.flag}</span>
        <span className={`market-status ${market.open ? "" : "closed"}`}>
          {market.open ? "● OPEN" : "○ CLOSED"}
        </span>
      </div>
      <h3>
        {market.name}
        <ArrowUpRight size={16} />
      </h3>
      <p>{market.exchange}</p>
      <div className="market-card-bottom">
        <MarketClock market={market} />
        <span>{market.currency}</span>
      </div>
    </button>
  );
}
export function Ticker() {
  return (
    <div className="ticker">
      {markets.map((m) => (
        <div key={m.id}>
          <span>{m.flag}</span>
          <b>{m.index}</b>
          <span className="mono">{m.value}</span>
          <span className={m.change.startsWith("−") ? "negative" : "positive"}>
            {m.change}
          </span>
          <svg width="55" height="20" viewBox="0 0 55 20">
            <path
              d={
                m.id === "singapore"
                  ? "M0 4 8 9 14 6 21 12 29 8 38 14 47 12 55 18"
                  : "M0 18 8 11 14 14 21 6 29 10 38 3 47 6 55 1"
              }
              fill="none"
              stroke={m.id === "singapore" ? "#d57d82" : "#58c7a5"}
              strokeWidth="1.5"
            />
          </svg>
        </div>
      ))}
    </div>
  );
}
export function LoadingScreen() {
  return (
    <div className="loading-screen">
      <AtlasLogo />
      <div className="loading-bar" />
      <p>Preparing your Atlas experience</p>
    </div>
  );
}
