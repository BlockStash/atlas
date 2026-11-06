"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  Copy,
  ExternalLink,
  Landmark,
  LogOut,
  Settings2,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { fmt, useProtocol } from "@/components/protocol/shared";
import { ENSName } from "@/components/wallet/ens-name";

const money = (v: bigint) => fmt(v, 6, 2);

/**
 * Top-bar wallet and vault: balances at a glance, with the account menu holding everything else
 * (address, identity, explorer, preferences, disconnect). Replaces the sidebar Wallet/Vault links.
 */
type Overview = ReturnType<typeof useProtocol>["data"];

/** Wallet and vault balances, shown on the left of the top bar. */
export function BalancePills({ data: d }: { data: Overview }) {
  return (
    <div className="wallet-bar balances">
      <Link className="balance-pill" href="/wallet" title="Wallet balance">
        <Wallet size={15} />
        <span>
          <small>Wallet</small>
          <b>{d ? `${money(d.walletAssets)} USDT` : "—"}</b>
        </span>
      </Link>
      <Link
        className="balance-pill vault"
        href="/vault"
        title="Atlas Vault buying power"
      >
        <Landmark size={15} />
        <span>
          <small>Vault</small>
          <b>{d ? `${money(d.underlying)} USDT` : "—"}</b>
        </span>
      </Link>
    </div>
  );
}

/** Account menu on the right of the top bar: address, balances, identity, links, disconnect. */
export function WalletBar({ data: d }: { data: Overview }) {
  const { wallet, state, logout, toast } = useAtlas();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!wallet) return null;
  const short = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
  const worldId = state.worldIdVerifiedDemo
    ? "World ID verified · Demo"
    : state.worldIdEnvironment === "staging"
      ? "World ID verified · Simulator"
      : "World ID verified";

  return (
    <div className="wallet-bar">
      <div className="account-dropdown" ref={ref}>
        <button
          className="account-button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <span className="avatar">A</span>
          <ENSName address={wallet.address} />
          <ChevronDown size={13} />
        </button>
        {open && (
          <div className="account-menu" role="menu">
            <div className="account-menu-head">
              <span className="avatar">A</span>
              <div>
                <strong>
                  <ENSName address={wallet.address} />
                </strong>
                <button
                  className="account-copy"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(wallet.address)
                      .then(() => toast("Wallet address copied."))
                      .catch(() => toast("Could not copy the address."))
                  }
                >
                  {short} <Copy size={11} />
                </button>
              </div>
            </div>
            <div className="account-menu-balances">
              <div>
                <small>Wallet</small>
                <b>{d ? money(d.walletAssets) : "—"}</b>
                <small>USDT</small>
              </div>
              <div>
                <small>Vault</small>
                <b>{d ? money(d.underlying) : "—"}</b>
                <small>USDT</small>
              </div>
            </div>
            <span className="account-menu-verified">
              <ShieldCheck size={14} />
              {worldId} · {wallet.network}
            </span>
            <nav onClick={() => setOpen(false)}>
              <Link href="/wallet" role="menuitem">
                <Wallet size={15} /> Wallet & ENS identity
              </Link>
              <Link href="/vault" role="menuitem">
                <Landmark size={15} /> Atlas Vault
              </Link>
              <a
                href={`https://sepolia.etherscan.io/address/${wallet.address}`}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
              >
                <ExternalLink size={15} /> View on Etherscan
              </a>
              <Link href="/onboarding" role="menuitem">
                <Settings2 size={15} /> Preferences
              </Link>
            </nav>
            <button
              className="account-menu-logout"
              role="menuitem"
              onClick={() =>
                logout().catch(() => toast("Could not disconnect."))
              }
            >
              <LogOut size={15} /> Disconnect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
