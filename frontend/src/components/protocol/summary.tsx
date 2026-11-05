"use client";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useProtocol, fmt } from "./shared";
export function ProtocolSummary() {
  const p = useProtocol();
  return (
    <section className="protocol-summary">
      <div>
        <h3>Atlas onchain workspace</h3>
        <p>
          {p.config?.configured
            ? "Sepolia contract balances · demo synthetic protocol"
            : "Vault deposits and synthetic trading are available after Sepolia protocol deployment."}
        </p>
      </div>
      {p.data && (
        <>
          <div className="protocol-summary-stat">
            <span>WALLET USDT</span>
            <strong>{fmt(p.data.walletAssets)}</strong>
          </div>
          <div className="protocol-summary-stat">
            <span>VAULT BUYING POWER</span>
            <strong>{fmt(p.data.underlying)} USDT</strong>
          </div>
        </>
      )}
      <Link href="/vault">
        Atlas Vault
        <ArrowUpRight size={13} />
      </Link>
      <Link href="/trade">
        Trade stocks
        <ArrowUpRight size={13} />
      </Link>
    </section>
  );
}
