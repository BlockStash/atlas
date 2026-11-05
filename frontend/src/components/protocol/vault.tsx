"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import {
  useProtocol,
  ProtocolFrame,
  SetupState,
  TransactionStatus,
  Metric,
  fmt,
} from "./shared";
import {
  read,
  write,
  approve,
  units,
  protocolError,
  type TxState,
} from "@/lib/protocol/client";
export function VaultPage() {
  const p = useProtocol();
  const [action, setAction] = useState<"deposit" | "withdraw" | "redeem">(
      "deposit",
    ),
    [amount, setAmount] = useState(""),
    [preview, setPreview] = useState<{ input: bigint; output: bigint } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tx, setTx] = useState<TxState | null>(null);
  async function quote() {
    setBusy(true);
    setError("");
    try {
      const input = units(amount, action === "redeem" ? 12 : 6);
      if (!p.config || !p.data) throw new Error("Load the protocol first.");
      if (action === "deposit" && input > p.data.walletAssets)
        throw new Error("The deposit exceeds your wallet USDT balance.");
      if (action === "redeem" && input > p.data.shares)
        throw new Error("The share amount exceeds your balance.");
      if (action === "withdraw" && input > p.data.underlying)
        throw new Error("The withdrawal exceeds your underlying claim.");
      const output = (await read(
        p.config,
        "atlasVault",
        action === "deposit"
          ? "previewDeposit"
          : action === "withdraw"
            ? "previewWithdraw"
            : "previewRedeem",
        [input],
      )) as bigint;
      if (output === 0n) throw new Error("This amount is too small.");
      setPreview({ input, output });
    } catch (e) {
      setError(protocolError(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!preview || !p.config || !p.account) return;
    setBusy(true);
    setError("");
    setTx(null);
    try {
      if (action === "deposit") {
        await approve(
          p.config,
          p.account,
          "atlasUSDT",
          p.config.atlasVault,
          preview.input,
          setTx,
        );
        await write(
          p.config,
          p.account,
          "atlasVault",
          "depositWithMinShares",
          [preview.input, p.account, (preview.output * 995n) / 1000n],
          setTx,
        );
      } else if (action === "redeem")
        await write(
          p.config,
          p.account,
          "atlasVault",
          "redeemWithMinAssets",
          [
            preview.input,
            p.account,
            p.account,
            (preview.output * 995n) / 1000n,
          ],
          setTx,
        );
      else
        await write(
          p.config,
          p.account,
          "atlasVault",
          "withdrawWithMaxShares",
          [
            preview.input,
            p.account,
            p.account,
            (preview.output * 1005n + 999n) / 1000n,
          ],
          setTx,
        );
      setPreview(null);
      setAmount("");
      await p.reload();
    } catch (e) {
      setTx((current) =>
        current && current.state !== "confirmed"
          ? { ...current, state: "failed" }
          : current,
      );
      setError(protocolError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ProtocolFrame>
      <main className="protocol-content">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ONCHAIN · SEPOLIA</span>
            <h1>Atlas Vault</h1>
            <p>
              Deposit USDT. Hold proportional shares. Trade from one balance.
            </p>
          </div>
          <button className="btn secondary small" onClick={p.reload}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        {!p.config?.configured || !p.data ? (
          <SetupState
            loading={p.loading}
            config={p.config}
            error={p.error}
            retry={p.reload}
          />
        ) : (
          <>
            <div className="protocol-metrics">
              <Metric
                label="WALLET USDT"
                value={fmt(p.data.walletAssets)}
                note={
                  p.config.settlementTokenIsDemo
                    ? "Atlas USDT · demo token"
                    : "Configured settlement token"
                }
              />
              <Metric
                label="VAULT CLAIM"
                value={`${fmt(p.data.underlying)} USDT`}
                note="Underlying value of shares you hold"
              />
              <Metric
                label="YOUR VAULT SHARES"
                value={`${fmt(p.data.shares, 12)} aUSDT`}
              />
              <Metric
                label="SHARE VALUE"
                value={`${fmt(p.data.sharePrice, 6, 6)} USDT`}
                note="Value of one aUSDT share"
              />
              <Metric
                label="AVAILABLE BUYING POWER"
                value={`${fmt(p.data.underlying)} USDT`}
                note="Excludes shares already spent into trading reserves"
              />
              <Metric
                label="TOTAL VAULT ASSETS"
                value={`${fmt(p.data.totalAssets)} USDT`}
                note={`${fmt(p.data.totalShares, 12)} shares outstanding`}
              />
            </div>
            <div className="protocol-two-column">
              <section className="panel protocol-form-panel">
                <h2>Manage your vault balance</h2>
                <div className="ens-tabs">
                  {(["deposit", "withdraw", "redeem"] as const).map((value) => (
                    <button
                      key={value}
                      className={action === value ? "active" : ""}
                      disabled={busy}
                      onClick={() => {
                        setAction(value);
                        setPreview(null);
                        setError("");
                        setTx(null);
                      }}
                    >
                      {value === "redeem"
                        ? "Redeem shares"
                        : value === "deposit"
                          ? "Deposit USDT"
                          : "Withdraw USDT"}
                    </button>
                  ))}
                </div>
                {p.wallet?.demo ? (
                  <p className="error-box">
                    Connect a real MetaMask wallet for protocol transactions.
                  </p>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void quote();
                    }}
                  >
                    <label>
                      {action === "redeem"
                        ? "Shares to redeem (aUSDT)"
                        : "USDT amount"}
                      <input
                        required
                        inputMode="decimal"
                        value={amount}
                        disabled={busy || !!preview}
                        onChange={(e) => {
                          setAmount(e.target.value);
                          setPreview(null);
                        }}
                        placeholder="0.00"
                      />
                    </label>
                    {action === "deposit" && p.data.vaultPaused && (
                      <p className="error-box">
                        New deposits are paused. Withdrawals remain available.
                      </p>
                    )}
                    {!preview && (
                      <button
                        className="btn primary full"
                        disabled={
                          busy || (action === "deposit" && p.data.vaultPaused)
                        }
                      >
                        Preview {action}
                      </button>
                    )}
                  </form>
                )}
                {preview && (
                  <div className="protocol-review">
                    <h3>Review {action}</h3>
                    <p>
                      {fmt(preview.input, action === "redeem" ? 12 : 6, 6)}{" "}
                      {action === "redeem" ? "aUSDT" : "USDT"} →{" "}
                      {fmt(
                        preview.output,
                        action === "withdraw" || action === "deposit" ? 12 : 6,
                        6,
                      )}{" "}
                      {action === "withdraw" || action === "deposit"
                        ? "aUSDT"
                        : "USDT"}
                    </p>
                    <small>
                      {action === "deposit"
                        ? "You may receive two wallet requests: exact USDT approval, then deposit. Existing nonzero approvals may require a reset."
                        : "You authorize only your own shares. No admin can withdraw them."}{" "}
                      Quote protection: 0.5%.
                    </small>
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
                        onClick={submit}
                      >
                        {action === "deposit" ? (
                          <ArrowDownLeft size={16} />
                        ) : (
                          <ArrowUpRight size={16} />
                        )}
                        Confirm in MetaMask
                      </button>
                    </div>
                  </div>
                )}
                <TransactionStatus tx={tx} error={error} />
              </section>
              <aside className="panel protocol-explainer">
                <h2>A share of the whole.</h2>
                <p>
                  Your aUSDT shares represent a proportional claim on assets
                  held by the vault. Their value changes with vault assets; it
                  is not permanently fixed at one USDT.
                </p>
                <p>
                  When you buy a demo synthetic stock, approved shares move into
                  that stock’s trading reserve. Sell proceeds return as vault
                  shares. You can withdraw the underlying USDT from shares you
                  hold.
                </p>
                <Link className="btn secondary" href="/trade">
                  Explore 50 synthetic stocks
                  <ArrowUpRight size={15} />
                </Link>
                <span className="demo-badge">
                  DEMO SYNTHETIC ASSETS · NO LEGAL EQUITY OWNERSHIP
                </span>
              </aside>
            </div>
          </>
        )}
      </main>
    </ProtocolFrame>
  );
}
