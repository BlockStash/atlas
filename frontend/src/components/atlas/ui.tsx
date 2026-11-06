"use client";
import Link from "next/link";
import { ArrowUpRight, Globe2, Pin, PinOff, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { markets } from "@/lib/data";
import type { MarketPreference } from "@/lib/types";
import {
  useStockSessions,
  regionMarketState,
  regionAtlasOpen,
} from "@/lib/protocol/stock-sessions";
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
  const { stocks, developmentMarkets, vault } = useStockSessions();
  const regions = ["india", "usa", "uk", "singapore", "europe"];
  const known = regions.filter(
    (r) => regionMarketState(stocks, r) !== "unknown",
  );
  const open = regions.filter((r) =>
    ["open", "partial"].includes(regionMarketState(stocks, r)),
  ).length;
  return (
    <div className="global-clock">
      <Globe2 size={15} />
      <span>Global market clock</span>
      <span className="status-dot" />
      <span>
        {developmentMarkets && !vault
          ? "Atlas market status unavailable"
          : developmentMarkets && stocks.length
            ? `${regions.filter((r) => regionAtlasOpen(stocks, r)).length} / 5 Atlas open · dev`
            : known.length === 5
              ? `${open} / 5 exchanges open`
              : "Checking exchange status…"}
      </span>
    </div>
  );
}
/** Pin / unpin toggle for a card. Stops the click so the card itself doesn't open. */
export function CardPin({
  pinned,
  label,
  onToggle,
}: {
  pinned: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`card-pin ${pinned ? "pinned" : ""}`}
      aria-pressed={pinned}
      aria-label={`${pinned ? "Unpin" : "Pin"} ${label}`}
      title={pinned ? "Unpin" : "Pin to top"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {pinned ? <PinOff size={13} /> : <Pin size={13} />}
    </button>
  );
}
export function MarketCard({
  market,
  onClick,
  selected = false,
  marketState,
  developmentOpen = false,
  developmentMode = false,
  pinned,
  onPin,
}: {
  market: MarketPreference;
  onClick?: () => void;
  selected?: boolean;
  marketState?: "open" | "closed" | "partial" | "unknown";
  developmentOpen?: boolean;
  developmentMode?: boolean;
  /** Shows a pin toggle when provided. */
  pinned?: boolean;
  onPin?: () => void;
}) {
  // A div with button semantics, so the pin toggle can be a real nested button.
  return (
    <div
      role="button"
      tabIndex={0}
      className={`market-card ${selected ? "selected" : ""} ${pinned ? "pinned" : ""}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      <div className="market-card-top">
        <span className="flag">{market.flag}</span>
        {onPin && (
          <CardPin pinned={!!pinned} label={market.name} onToggle={onPin} />
        )}
        <span
          className={`market-status ${(developmentMode ? developmentOpen : marketState === "open" || market.id === "crypto") ? "" : "closed"}`}
        >
          {developmentMode
            ? developmentOpen
              ? "● ATLAS OPEN · DEV"
              : "ATLAS NOT OPEN · DEV"
            : market.id === "crypto"
              ? "● 24/7"
              : marketState === "open"
                ? "● OPEN"
                : marketState === "closed"
                  ? "○ CLOSED"
                  : marketState === "partial"
                    ? "◐ PARTLY OPEN"
                    : "STATUS UNAVAILABLE"}
        </span>
      </div>
      <h3>
        {market.name}
        <ArrowUpRight size={16} />
      </h3>
      <p>{market.exchange}</p>
      {developmentMode && (
        <small className="exchange-state">
          {marketState === "closed"
            ? "Exchange closed"
            : marketState === "open"
              ? "Exchange open"
              : marketState === "partial"
                ? "Exchanges partly open"
                : "Exchange status unavailable"}
        </small>
      )}
      <div className="market-card-bottom">
        <MarketClock market={market} />
        <span>{market.currency}</span>
      </div>
    </div>
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
