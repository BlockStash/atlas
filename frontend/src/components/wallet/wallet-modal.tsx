"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  AtSign,
  Link2,
  Plus,
  Check,
  ChevronRight,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { FoxIcon, SecurityNote } from "@/components/atlas/ui";
import { ENSIdentity } from "./ens-identity";
import { api } from "@/lib/api";
import { ENSName } from "./ens-name";
import type { UserOnboardingState, WalletState } from "@/lib/types";
type Session = { wallet: WalletState; profile: UserOnboardingState };
export function WalletModal() {
  const { modal, setModal, wallet, acceptSession, state } = useAtlas();
  const router = useRouter();
  const [status, setStatus] = useState<
      "idle" | "connecting" | "approval" | "connected" | "error"
    >("idle"),
    [error, setError] = useState("");
  const [intent, setIntent] = useState<"wallet" | "ens" | "link" | "create">(
      "wallet",
    ),
    [ensInput, setEnsInput] = useState("");
  useEffect(() => {
    if (modal) setStatus(wallet ? "connected" : "idle");
  }, [modal, wallet]);
  async function connect(demo = false, ensName?: string) {
    setStatus("connecting");
    setError("");
    try {
      let session: Session;
      if (demo) session = await api<Session>("/auth/demo", {});
      else {
        const { signInWallet } = await import("@/lib/auth");
        session = await signInWallet(() => setStatus("approval"), ensName);
      }
      acceptSession(session);
      setStatus("connected");
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setError(
        /reject|denied|4001/i.test(message)
          ? "Connection request was rejected. You can try again when you’re ready."
          : /not installed|metamask.*(?:not available|unavailable)|provider.*not found/i.test(
                message,
              )
            ? "MetaMask isn't available on this device. Install the extension or connect with MetaMask Mobile."
            : message || "We couldn’t connect your wallet. Please try again.",
      );
      setStatus("error");
    }
  }
  const pending = status === "connecting" || status === "approval";
  return (
    <Dialog.Root open={modal} onOpenChange={setModal}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog wallet-dialog">
          <Dialog.Close
            className="dialog-close"
            aria-label="Close wallet connection"
          >
            <X size={20} />
          </Dialog.Close>
          <div className="modal-icon">
            {status === "connected" ? <Check /> : <Wallet />}
          </div>
          <span className="eyebrow">YOUR GATEWAY TO GLOBAL MARKETS</span>
          <Dialog.Title>
            {status === "connected" ? "Wallet connected." : "Connect to Atlas"}
          </Dialog.Title>
          <Dialog.Description>
            {status === "connected"
              ? "One wallet. A world of possibilities."
              : "Connect your wallet to access your Atlas portfolio and crypto balances."}
          </Dialog.Description>
          {status === "connected" && wallet ? (
            <>
              <div className="connected-card">
                <FoxIcon />
                <div>
                  <strong>
                    <ENSName address={wallet.address} />
                  </strong>
                  <span>
                    {wallet.demo ? "Investor demo wallet" : wallet.network}
                  </span>
                </div>
                <span className="connected-pill">
                  <Check size={12} />
                  Connected
                </span>
              </div>
              {(intent === "link" || intent === "create") && (
                <ENSIdentity initialMode={intent} key={intent} />
              )}
              <button
                className="btn primary full"
                onClick={() => {
                  setModal(false);
                  router.push(
                    state.onboardingComplete ? "/home" : "/onboarding",
                  );
                }}
              >
                Continue
                <ArrowRight size={17} />
              </button>
            </>
          ) : (
            <>
              <button
                className="wallet-option"
                disabled={pending}
                onClick={() => {
                  setIntent("wallet");
                  void connect();
                }}
              >
                <span className="fox-box">
                  <FoxIcon />
                </span>
                <span>
                  <strong>MetaMask</strong>
                  <small>Connect your existing wallet</small>
                </span>
                <span className="recommended">Recommended</span>
                <ChevronRight size={17} />
              </button>
              <div
                className="ens-login-options"
                role="group"
                aria-label="ENS login options"
              >
                <button
                  className={intent === "ens" ? "active" : ""}
                  disabled={pending}
                  onClick={() => {
                    setIntent("ens");
                    setError("");
                  }}
                >
                  <AtSign size={17} />
                  <span>
                    Login with ENS<small>Use your Sepolia ENS name</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
                <div>
                  <button
                    disabled={pending}
                    onClick={() => {
                      setIntent("link");
                      void connect();
                    }}
                  >
                    <Link2 size={14} />
                    Link existing ENS
                  </button>
                  <button
                    disabled={pending}
                    onClick={() => {
                      setIntent("create");
                      void connect();
                    }}
                  >
                    <Plus size={14} />
                    Create new ENS
                  </button>
                </div>
              </div>
              {intent === "ens" && (
                <form
                  className="ens-form ens-login-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connect(false, ensInput);
                  }}
                >
                  <label>
                    Your ENS name
                    <input
                      required
                      autoComplete="off"
                      value={ensInput}
                      placeholder="your-name.eth"
                      disabled={pending}
                      onChange={(e) => setEnsInput(e.target.value)}
                    />
                  </label>
                  <p>
                    Atlas resolves the name on Sepolia, then asks its wallet to
                    sign in with MetaMask.
                  </p>
                  <button className="btn primary full" disabled={pending}>
                    Continue with ENS
                    <ArrowRight size={15} />
                  </button>
                </form>
              )}
              {pending && (
                <div className="pending" role="status">
                  <Loader2 className="spin" size={20} />
                  <span>
                    {status === "approval"
                      ? "Approve the connection and sign in MetaMask."
                      : "Waiting for MetaMask…"}
                  </span>
                </div>
              )}
              {error && (
                <div role="alert" className="error-box">
                  {error}
                  <button
                    className="text-button"
                    onClick={() =>
                      connect(false, intent === "ens" ? ensInput : undefined)
                    }
                  >
                    Try again <ArrowRight size={14} />
                  </button>
                </div>
              )}
              {!pending && (
                <>
                  <div className="wallet-links">
                    <a
                      href="https://metamask.io/download/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Install MetaMask <ExternalLink size={12} />
                    </a>
                    <button onClick={() => connect()}>
                      Use MetaMask Mobile
                      <ExternalLink size={12} />
                    </button>
                  </div>
                  {process.env.NEXT_PUBLIC_DEMO_WALLET === "true" && (
                    <div className="demo-option">
                      <span>Just taking a look?</span>
                      <button onClick={() => connect(true)}>
                        Try the investor demo <ArrowRight size={14} />
                      </button>
                      <small>
                        Simulated wallet · No funds or signatures required
                      </small>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <div className="modal-footer">
            <SecurityNote />
            <p>By connecting your wallet, you agree to the Atlas demo terms.</p>
            <span>
              <ShieldCheck size={12} /> Secure connection · No custody
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
