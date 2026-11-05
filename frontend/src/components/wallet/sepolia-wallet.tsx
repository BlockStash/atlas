"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { formatEther, isHash, type Hash } from "viem";
import { ArrowUpRight, Check, Loader2, RefreshCw, Send } from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { sepoliaClient } from "@/lib/chain";
import { resolveRecipient } from "@/lib/ens";
import {
  prepareTransfer,
  sendTestTransfer,
  transactionMessage,
  type TransferPreview,
} from "@/lib/transactions";
import { api } from "@/lib/api";
import type { UserOnboardingState } from "@/lib/types";
import { WorldIDVerification } from "@/components/world-id/verification";
import { ENSName } from "./ens-name";
type SavedTransaction = {
  hash: Hash;
  status: "pending" | "confirmed" | "reverted" | "replaced";
  to: string;
  amount: string;
  name: string | null;
};
export function SepoliaWallet() {
  const { wallet, state } = useAtlas();
  const [balance, setBalance] = useState<string | null>(null),
    [balanceError, setBalanceError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState("0.001"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [preview, setPreview] = useState<
      (TransferPreview & { name: string | null; amount: string }) | null
    >(null),
    [transaction, setTransaction] = useState<SavedTransaction | null>(null),
    [poll, setPoll] = useState(0);
  const address = wallet?.address;
  const key = `atlas_sepolia_transaction_${address?.toLowerCase()}`;
  const eligible =
    wallet &&
    !wallet.demo &&
    state.worldIdVerified &&
    !state.worldIdVerifiedDemo;
  useEffect(() => {
    let active = true;
    if (!address || wallet?.demo) return;
    setBalanceError("");
    sepoliaClient
      .getBalance({ address: address as `0x${string}` })
      .then((value) => {
        if (active) setBalance(formatEther(value));
      })
      .catch(() => {
        if (active)
          setBalanceError(
            "Could not read Sepolia balance. Check the RPC connection and retry.",
          );
      });
    return () => {
      active = false;
    };
  }, [address, wallet?.demo, refresh]);
  useEffect(() => {
    setTransaction(null);
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const value = JSON.parse(raw);
        if (
          isHash(value.hash) &&
          ["pending", "confirmed", "reverted", "replaced"].includes(
            value.status,
          )
        )
          setTransaction(value);
      }
    } catch {
      /* A transfer remains visible in MetaMask if storage is unavailable. */
    }
  }, [key]);
  useEffect(() => {
    if (!transaction || transaction.status !== "pending") return;
    let active = true;
    setError("");
    sepoliaClient
      .waitForTransactionReceipt({
        hash: transaction.hash,
        confirmations: 1,
        timeout: 120000,
        onReplaced: (replacement) => {
          if (!active) return;
          const next = {
            ...transaction,
            hash: replacement.transaction.hash,
            status:
              replacement.reason === "repriced"
                ? ("pending" as const)
                : ("replaced" as const),
          };
          setTransaction(next);
          try {
            localStorage.setItem(key, JSON.stringify(next));
          } catch {}
        },
      })
      .then((receipt) => {
        if (!active) return;
        const next = {
          ...transaction,
          hash: receipt.transactionHash,
          status:
            receipt.status === "success"
              ? ("confirmed" as const)
              : ("reverted" as const),
        };
        setTransaction(next);
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {}
        setRefresh((v) => v + 1);
      })
      .catch(() => {
        if (active)
          setError(
            "Confirmation is taking longer than expected. Your transaction may still be pending. Check the explorer or retry the status check.",
          );
      });
    return () => {
      active = false;
    };
  }, [transaction, key, poll]);
  if (!wallet) return null;
  async function review() {
    setBusy(true);
    setError("");
    try {
      const resolved = await resolveRecipient(recipient);
      const transfer = await prepareTransfer(
        wallet!.address,
        resolved.address,
        amount,
      );
      setPreview({ ...transfer, name: resolved.name, amount });
    } catch (e) {
      setError(transactionMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const profile = await api<UserOnboardingState>("/profile");
      if (!profile.worldIdVerified || profile.worldIdVerifiedDemo)
        throw new Error(
          "Verify with World App before sending a test transaction.",
        );
      const hash = await sendTestTransfer(preview);
      const record: SavedTransaction = {
        hash,
        status: "pending",
        to: preview.to,
        amount: preview.amount,
        name: preview.name,
      };
      setTransaction(record);
      setPreview(null);
      try {
        localStorage.setItem(key, JSON.stringify(record));
      } catch {}
    } catch (e) {
      setError(transactionMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sepolia-wallet panel">
      <div className="section-heading">
        <div>
          <h2>Sepolia test wallet</h2>
          <p>Send test ETH to an address or a Sepolia ENS name.</p>
        </div>
        <span className="demo-badge">SEPOLIA · 11155111</span>
      </div>
      {wallet.demo ? (
        <div className="error-box">
          This is a simulated wallet. Disconnect and connect MetaMask to use
          Sepolia.
        </div>
      ) : (
        <>
          <div className="test-wallet-balance">
            <div>
              <span>ONCHAIN TEST BALANCE</span>
              <strong>
                {balance === null
                  ? "Loading…"
                  : `${Number(balance).toLocaleString("en-US", { maximumFractionDigits: 8 })} ETH`}
              </strong>
              <ENSName address={wallet.address} />
            </div>
            <button
              className="btn secondary small"
              aria-label="Refresh Sepolia balance"
              onClick={() => setRefresh((v) => v + 1)}
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
          {balanceError && (
            <p role="alert" className="error-box">
              {balanceError}
            </p>
          )}
          <p className="test-wallet-note">
            Sepolia ETH is for testing. Your USDT, ATLAS, and portfolio figures
            elsewhere remain illustrative. ENS lookups here use Sepolia records.
          </p>
          {!eligible ? (
            <div className="live-verification">
              <h3>Verify with World App to send</h3>
              <WorldIDVerification />
            </div>
          ) : (
            <>
              <span className="connected-pill">
                <Check size={12} />
                {state.worldIdEnvironment === "staging"
                  ? "World ID simulator proof verified"
                  : "World App verified"}
              </span>
              <form
                className="transfer-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void review();
                }}
              >
                <label>
                  Recipient address or ENS name
                  <input
                    required
                    value={recipient}
                    placeholder="0x… or your-name.eth"
                    autoComplete="off"
                    disabled={
                      busy || !!preview || transaction?.status === "pending"
                    }
                    onChange={(e) => {
                      setRecipient(e.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
                <label>
                  Amount in Sepolia ETH
                  <input
                    required
                    inputMode="decimal"
                    value={amount}
                    disabled={
                      busy || !!preview || transaction?.status === "pending"
                    }
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
                {!preview && (
                  <button
                    className="btn primary"
                    disabled={busy || transaction?.status === "pending"}
                    type="submit"
                  >
                    {busy ? (
                      <Loader2 className="spin" size={16} />
                    ) : (
                      <Send size={16} />
                    )}
                    Review test transfer
                  </button>
                )}
              </form>
              {preview && (
                <div className="transfer-review">
                  <h3>Review Sepolia transfer</h3>
                  <dl>
                    <dt>Network</dt>
                    <dd>Sepolia (11155111)</dd>
                    <dt>From</dt>
                    <dd>{preview.account}</dd>
                    {preview.name && (
                      <>
                        <dt>ENS name</dt>
                        <dd>{preview.name}</dd>
                      </>
                    )}
                    <dt>Recipient</dt>
                    <dd>{preview.to}</dd>
                    <dt>Amount</dt>
                    <dd>{preview.amount} test ETH</dd>
                    <dt>Estimated maximum gas fee</dt>
                    <dd>{formatEther(preview.fee)} test ETH</dd>
                  </dl>
                  <p>
                    Confirm the address and amount. MetaMask will show the final
                    network fee before approval.
                  </p>
                  <div>
                    <button
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => setPreview(null)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={send}
                    >
                      {busy ? (
                        <Loader2 className="spin" size={16} />
                      ) : (
                        <Send size={16} />
                      )}
                      Approve in MetaMask
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="error-box" role="alert">
              {error}
            </p>
          )}
          {transaction && (
            <div className="transaction-receipt" role="status">
              <h3>
                {transaction.status === "pending"
                  ? "Transaction submitted"
                  : transaction.status === "confirmed"
                    ? "Transfer confirmed"
                    : transaction.status === "replaced"
                      ? "Transaction cancelled or replaced in MetaMask"
                      : "Transaction reverted"}
              </h3>
              <p>
                {transaction.amount} test ETH ·{" "}
                {transaction.name || transaction.to}
              </p>
              <a
                href={`https://sepolia.etherscan.io/tx/${transaction.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                {transaction.hash}
                <ArrowUpRight size={14} />
              </a>
              {transaction.status === "pending" && (
                <button
                  className="text-button"
                  onClick={() => setPoll((v) => v + 1)}
                >
                  Check confirmation
                </button>
              )}
              {transaction.status !== "pending" && (
                <button
                  className="text-button"
                  onClick={() => {
                    setTransaction(null);
                    setError("");
                    try {
                      localStorage.removeItem(key);
                    } catch {}
                  }}
                >
                  New transfer
                </button>
              )}
            </div>
          )}
          <div className="test-wallet-links">
            <a
              href="https://ethereum.org/en/developers/docs/networks/#sepolia"
              target="_blank"
              rel="noreferrer"
            >
              Get Sepolia test ETH
              <ArrowUpRight size={13} />
            </a>
            <Link href="/onboarding">Review identity and preferences</Link>
          </div>
        </>
      )}
    </section>
  );
}
