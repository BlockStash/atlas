"use client";
import {
  sessionAmount,
  type StockSession,
} from "@/lib/protocol/stock-sessions";
export function ExchangeStatus({
  market,
}: {
  market?: StockSession["market"];
}) {
  return (
    <span
      className={`exchange-state ${market?.state === "open" ? "positive" : ""}`}
      title={
        market?.observedAt
          ? `${market.source} · checked ${new Date(market.observedAt * 1000).toLocaleString()}`
          : "Exchange status unavailable"
      }
    >
      {market?.state === "open"
        ? "● Exchange open"
        : market?.state === "closed"
          ? "○ Exchange closed"
          : "Exchange status unavailable"}
    </span>
  );
}
export function SessionReference({ session }: { session?: StockSession }) {
  if (!session) return null;
  return (
    <div className="stock-session-reference">
      <div>
        <span>Recorded close</span>
        <strong>{sessionAmount(session.sessionClose, session.currency)}</strong>
        <small>{session.sessionDate}</small>
      </div>
      <div>
        <span>Opening price</span>
        <strong>{sessionAmount(session.sessionOpen, session.currency)}</strong>
        <small>{session.sessionDate}</small>
      </div>
      <a href={session.sourceUrl} target="_blank" rel="noreferrer">
        {session.source} ↗
      </a>
      <small>
        Historical reference
        {session.sourceUnit === "GBX" ? " · pence converted to GBP" : ""}
      </small>
    </div>
  );
}
