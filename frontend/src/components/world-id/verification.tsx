"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { orbLegacy, type RpContext } from "@worldcoin/idkit";
import {
  Check,
  Fingerprint,
  KeyRound,
  Loader2,
  LockKeyhole,
  QrCode,
  Smartphone,
  ScanFace,
  ShieldCheck,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { api } from "@/lib/api";
const IDKitRequestWidget = dynamic(
  () => import("@worldcoin/idkit").then((m) => m.IDKitRequestWidget),
  { ssr: false },
);
let demoFlag: Promise<boolean> | null = null;
/** Whether the backend accepts simulated World ID proofs (DEMO_WORLD_ID=true, non-production). */
export function useDemoWorldId() {
  const [enabled, setEnabled] = useState(
    process.env.NEXT_PUBLIC_DEMO_WORLD_ID === "true",
  );
  useEffect(() => {
    demoFlag ??= api<{ demo?: { worldId?: boolean } }>("/health")
      .then((r) => Boolean(r.demo?.worldId))
      .catch(() => false);
    let live = true;
    demoFlag.then((v) => live && setEnabled(v));
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}
const ipHost = () =>
  typeof window !== "undefined" &&
  /^(\d+\.){3}\d+$|^\[/.test(window.location.hostname);
type WorldRequest = {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging";
  signal: string;
  rp_context: RpContext;
};
export function WorldIDVerification() {
  const { state, wallet, verifyHuman, registerPasskey } = useAtlas();
  const [request, setRequest] = useState<WorldRequest | null>(null),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [verifying, setVerifying] = useState(false),
    [cancelled, setCancelled] = useState(false),
    [diagnostic, setDiagnostic] = useState<{
      code: string;
      requestId?: string;
    } | null>(null);
  const demo = useDemoWorldId();
  const [simulating, setSimulating] = useState(false),
    [passkeyBusy, setPasskeyBusy] = useState(false);
  async function simulate() {
    setError("");
    setSimulating(true);
    try {
      await verifyHuman();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Simulated verification failed.",
      );
    } finally {
      setSimulating(false);
    }
  }
  async function addPasskey() {
    setError("");
    if (ipHost()) {
      setError(
        `Passkeys need a domain name. Open Atlas at http://localhost:${window.location.port || "3000"} and try again.`,
      );
      return;
    }
    setPasskeyBusy(true);
    try {
      await registerPasskey();
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      setError(
        name === "NotAllowedError" || name === "AbortError"
          ? "Passkey request was cancelled or timed out."
          : name === "InvalidStateError"
            ? "A passkey for this wallet already exists on this device."
            : e instanceof Error
              ? e.message
              : "Could not create a passkey. Please try again.",
      );
    } finally {
      setPasskeyBusy(false);
    }
  }
  async function start() {
    setError("");
    setCancelled(false);
    setDiagnostic(null);
    setBusy(true);
    try {
      const context = await api<WorldRequest>("/world-id/request", {});
      setRequest(context);
      setOpen(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start verification. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const liveVerified = state.worldIdVerified && !state.worldIdVerifiedDemo;
  const worldDone = state.worldIdVerified && (demo || liveVerified);
  if (worldDone || state.passkeyVerified)
    return (
      <div className="verification-success">
        <span className="success-emblem">
          <Check size={35} />
        </span>
        <h3>Identity verified.</h3>
        <p>
          {!worldDone
            ? "Your device passkey confirmed a human is present."
            : state.worldIdVerifiedDemo
              ? "Simulated World ID proof accepted for testing."
              : state.worldIdEnvironment === "staging"
                ? "Simulator proof verified for testing."
                : "Your World ID proof has been verified."}
        </p>
        {worldDone && (
          <div className="verification-receipt">
            <span>
              <Fingerprint size={18} />
              World ID
            </span>
            <span className="positive">
              <Check size={14} />
              {state.worldIdVerifiedDemo
                ? "Simulated"
                : state.worldIdEnvironment === "staging"
                  ? "Simulator verified"
                  : "Verified with World App"}
            </span>
          </div>
        )}
        {state.passkeyVerified ? (
          <div className="verification-receipt">
            <span>
              <KeyRound size={18} />
              Passkey
            </span>
            <span className="positive">
              <Check size={14} />
              Added to this wallet
            </span>
          </div>
        ) : (
          <button
            className="btn secondary full"
            disabled={passkeyBusy}
            onClick={addPasskey}
          >
            {passkeyBusy ? (
              <Loader2 className="spin" size={18} />
            ) : (
              <KeyRound size={18} />
            )}
            {passkeyBusy ? "Waiting for your device…" : "Also add a passkey"}
          </button>
        )}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <small>No names or identity documents are stored by Atlas.</small>
      </div>
    );
  return (
    <div>
      <div className="identity-art">
        <div className="identity-ring ring-outer" />
        <div className="identity-ring ring-inner" />
        <div className="identity-icon">
          <Fingerprint size={54} strokeWidth={1.2} />
        </div>
        <span className="identity-badge">
          <ShieldCheck size={13} />
          PRIVACY FIRST
        </span>
      </div>
      <div className="trust-grid">
        {[
          { Icon: ShieldCheck, title: "Private & secure" },
          { Icon: ScanFace, title: "Unique human" },
          { Icon: LockKeyhole, title: "Minimal data sharing" },
        ].map(({ Icon, title }) => (
          <div key={title}>
            <Icon size={19} />
            <span>{title}</span>
          </div>
        ))}
      </div>
      <section
        className="world-app-instructions"
        aria-label="Verify using World App"
      >
        <div className="world-app-instructions-heading">
          <QrCode size={22} />
          <div>
            <h3>Scan on desktop. Verify on your phone.</h3>
            <p>Keep Atlas open while you approve the request in World App.</p>
          </div>
        </div>
        <ol>
          <li>
            <span>1</span>
            <div>
              <strong>Display your verification QR code</strong>
              <p>Select Continue with World ID below.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Scan with World App</strong>
              <p>
                Open World App on your phone and scan the code shown on your
                desktop.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Approve in the app</strong>
              <p>
                Atlas checks your proof and updates this screen automatically.
              </p>
            </div>
          </li>
        </ol>
        <p className="world-app-mobile-note">
          <Smartphone size={14} />
          On mobile, use the link in the verification window to open World App.
        </p>
      </section>
      {cancelled && !error && (
        <p className="inline-message" role="status">
          Verification window closed. Continue with World ID to start a fresh
          request.
        </p>
      )}
      {state.worldIdVerifiedDemo && !demo && !state.passkeyVerified && (
        <p className="inline-message">
          Your previous verification was simulated. Verify with World App to
          enable Sepolia transfers.
        </p>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {diagnostic && (
        <p className="verification-caption">
          Support reference: {diagnostic.code}
          {diagnostic.requestId ? ` · ${diagnostic.requestId}` : ""}
        </p>
      )}
      <button
        className="btn primary full"
        disabled={busy || open || simulating || wallet?.demo}
        onClick={start}
      >
        {busy ? (
          <Loader2 className="spin" size={18} />
        ) : (
          <Fingerprint size={20} />
        )}{" "}
        {busy ? "Preparing verification…" : "Continue with World ID"}
      </button>
      {wallet?.demo && (
        <p className="inline-message">
          Disconnect the demo wallet and connect MetaMask to verify with World
          App.
        </p>
      )}
      <div className="verification-alternatives">
        <button
          className="btn secondary"
          disabled={!demo || simulating || busy || open}
          onClick={simulate}
          title={
            demo
              ? "Mark this wallet as verified without World App"
              : "Set DEMO_WORLD_ID=true on the Atlas backend to enable"
          }
        >
          {simulating ? (
            <Loader2 className="spin" size={17} />
          ) : (
            <ScanFace size={17} />
          )}
          {simulating ? "Simulating…" : "Simulate World ID"}
        </button>
        <button
          className="btn secondary"
          disabled={passkeyBusy || busy || open}
          onClick={addPasskey}
        >
          {passkeyBusy ? (
            <Loader2 className="spin" size={17} />
          ) : (
            <KeyRound size={17} />
          )}
          {passkeyBusy ? "Waiting for device…" : "Verify with a passkey"}
        </button>
      </div>
      <p className="verification-caption">
        {demo
          ? "Simulation skips World App and is for testing only. Passkeys use Face ID, Touch ID, Windows Hello or a security key."
          : "Simulation is off: set DEMO_WORLD_ID=true on the backend to enable it. Passkeys use Face ID, Touch ID, Windows Hello or a security key."}
      </p>
      <p className="identity-footnote" role="status" aria-live="polite">
        {verifying
          ? "Proof received. Verifying securely with World ID…"
          : open
            ? "Waiting for World App. Scan the QR code and approve on your phone."
            : "Proof of humanity, privately linked to your connected wallet."}
      </p>
      {request && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={(value) => {
            setOpen(value);
            if (!value) {
              setRequest(null);
              setCancelled(true);
              setVerifying(false);
            }
          }}
          app_id={request.app_id}
          action={request.action}
          rp_context={request.rp_context}
          environment={request.environment}
          allow_legacy_proofs={true}
          preset={orbLegacy({ signal: request.signal })}
          handleVerify={async (result) => {
            setVerifying(true);
            try {
              await verifyHuman(result);
            } catch (e) {
              setError(
                e instanceof Error
                  ? e.message
                  : "The proof could not be verified.",
              );
              throw e;
            } finally {
              setVerifying(false);
            }
          }}
          onSuccess={() => {
            setOpen(false);
            setRequest(null);
          }}
          onError={(code, report) => {
            setDiagnostic({ code, requestId: report?.request_id });
            setError(
              code === "failed_by_host_app"
                ? "Atlas could not accept the proof. Close this window and restart verification."
                : "World ID verification did not complete. Close this window and try again.",
            );
          }}
        />
      )}
    </div>
  );
}
