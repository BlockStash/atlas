"use client";
import {
  sessionAmount,
  type StockSession,
} from "@/lib/protocol/stock-sessions";
import { formatUnits } from "viem";
export const sharesAmount = (value: string | bigint) =>
  `${Number(formatUnits(BigInt(value), 12)).toLocaleString("en-US", { maximumFractionDigits: 6 })} aUSDT`;
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
        <strong>
          {session.valuation
            ? sharesAmount(session.valuation.close.priceAUSDT)
            : sessionAmount(session.sessionClose, session.currency)}
        </strong>
        {session.valuation && (
          <small>{sessionAmount(session.sessionClose, session.currency)}</small>
        )}
        <small>{session.sessionDate}</small>
      </div>
      <div>
        <span>Opening price</span>
        <strong>
          {session.valuation
            ? sharesAmount(session.valuation.open.priceAUSDT)
            : sessionAmount(session.sessionOpen, session.currency)}
        </strong>
        {session.valuation && (
          <small>{sessionAmount(session.sessionOpen, session.currency)}</small>
        )}
        <small>{session.sessionDate}</small>
      </div>
      <a href={session.sourceUrl} target="_blank" rel="noreferrer">
        {session.source} ↗
      </a>
      <small>
        Historical reference
        {session.sourceUnit === "GBX" ? " · pence converted to GBP" : ""}
      </small>
      {session.valuation && (
        <small>
          aUSDT conversion: vault block {session.valuation.vaultBlock} ·{" "}
          <a
            href={session.valuation.fxSourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            FX {session.valuation.fxDate}
          </a>{" "}
          · before fees
        </small>
      )}
    </div>
  );
}
