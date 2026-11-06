"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, ExternalLink, Landmark, X } from "lucide-react";
import {
  approve,
  fetchConfig,
  protocolError,
  read,
  units,
  write,
  type TxState,
} from "@/lib/protocol/client";
import type { Funding } from "@/lib/intent/client";

const fmt = (v: string | number) =>
  Number(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
/** Shortfall rounded up to the cent, so the deposit always covers the trade. */
const roundUp = (v: string) => (Math.ceil(Number(v) * 100) / 100).toFixed(2);

/**
 * The strategy spends aUSDT (Atlas Vault shares). When the vault holds too little, convert wallet
 * USDT into aUSDT first: an exact USDT approval, then a vault deposit, both signed in MetaMask.
 */
export function ConvertDialog({
  open,
  funding,
  account,
  onClose,
  onConverted,
}: {
  open: boolean;
  funding: Funding | undefined;
  account: string | undefined;
  onClose: () => void;
  onConverted: () => void;
}) {
  const shortfall = funding ? roundUp(funding.shortfallUSDT) : "0";
  const [amount, setAmount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<TxState | null>(null);
  const value = amount ?? shortfall;

  async function convert() {
    if (!account || !funding) return;
    setBusy(true);
    setError(null);
    setTx(null);
    try {
      const config = await fetchConfig();
      const input = units(value, 6);
      if (Number(value) > Number(funding.walletUSDT))
        throw new Error("That is more USDT than your wallet holds.");
      const shares = (await read(config, "atlasVault", "previewDeposit", [
        input,
      ])) as bigint;
      const who = account as `0x${string}`;
      await approve(config, who, "atlasUSDT", config.atlasVault, input, setTx);
      await write(
        config,
        who,
        "atlasVault",
        "depositWithMinShares",
        [input, who, (shares * 995n) / 1000n],
        setTx,
      );
      setAmount(null);
      onConverted();
    } catch (e) {
      setError(protocolError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog intent-dialog convert-dialog">
          <Dialog.Close
            className="dialog-close"
            aria-label="Close"
            disabled={busy}
          >
            <X size={20} />
          </Dialog.Close>
          <span className="eyebrow">NOT ENOUGH aUSDT</span>
          <Dialog.Title>Convert USDT to aUSDT</Dialog.Title>
          <Dialog.Description>
            Atlas AI trades with aUSDT from your Atlas Vault. Convert wallet
            USDT into aUSDT, then deploy the strategy.
          </Dialog.Description>
          {funding && (
            <dl className="intent-confirm">
              <dt>This strategy needs</dt>
              <dd>{fmt(funding.requiredUSDT)} aUSDT</dd>
              <dt>Your vault (aUSDT)</dt>
              <dd>{fmt(funding.vaultUSDT)} aUSDT</dd>
              <dt>Your wallet USDT</dt>
              <dd>{fmt(funding.walletUSDT)} USDT</dd>
              <dt>Missing</dt>
              <dd className="negative">{fmt(funding.shortfallUSDT)} aUSDT</dd>
            </dl>
          )}
          <label className="portfolio-amount">
            <span>Convert (USDT)</span>
            <input
              inputMode="decimal"
              value={value}
              disabled={busy}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <small className="muted">
              MetaMask asks twice: approve the exact USDT amount, then deposit.
            </small>
          </label>
          {tx?.hash && (
            <a
              className="text-button"
              href={`https://sepolia.etherscan.io/tx/${tx.hash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {tx.state === "confirmed" ? "Confirmed" : "Pending"} on Sepolia{" "}
              <ExternalLink size={12} />
            </a>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          <button
            className="btn primary full"
            disabled={busy || !(Number(value) > 0) || !account}
            onClick={() => void convert()}
          >
            <Landmark size={15} />{" "}
            {busy
              ? tx?.state === "waiting"
                ? "Check your wallet…"
                : "Converting…"
              : `Convert ${fmt(value || 0)} USDT`}{" "}
            {!busy && <ArrowRight size={15} />}
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
