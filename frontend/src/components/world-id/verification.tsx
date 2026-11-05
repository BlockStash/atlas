"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { orbLegacy, type RpContext } from "@worldcoin/idkit";
import {
  Check,
  Fingerprint,
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
type WorldRequest = {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging";
  signal: string;
  rp_context: RpContext;
};
export function WorldIDVerification() {
  const { state, wallet, verifyHuman } = useAtlas();
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
  const demo = process.env.NEXT_PUBLIC_DEMO_WORLD_ID === "true";
  async function start() {
    setError("");
    setCancelled(false);
    setDiagnostic(null);
    setBusy(true);
    try {
      if (demo) await verifyHuman();
      else {
        const context = await api<WorldRequest>("/world-id/request", {});
        setRequest(context);
        setOpen(true);
      }
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
  if (state.worldIdVerified && (demo || liveVerified))
    return (
      <div className="verification-success">
        <span className="success-emblem">
          <Check size={35} />
        </span>
        <h3>Identity verified.</h3>
        <p>
          {state.worldIdEnvironment === "staging"
            ? "Simulator proof verified for testing."
            : "Your World ID proof has been verified."}
        </p>
        <div className="verification-receipt">
          <span>
            <Fingerprint size={18} />
            World ID
          </span>
          <span className="positive">
            <Check size={14} />
            {state.worldIdVerifiedDemo
              ? "Demo verified"
              : state.worldIdEnvironment === "staging"
                ? "Simulator verified"
                : "Verified with World App"}
          </span>
        </div>
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
      {!demo && (
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
            On mobile, use the link in the verification window to open World
            App.
          </p>
        </section>
      )}
      {cancelled && !error && (
        <p className="inline-message" role="status">
          Verification window closed. Continue with World ID to start a fresh
          request.
        </p>
      )}
      {state.worldIdVerifiedDemo && !demo && (
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
        disabled={busy || open || (!demo && wallet?.demo)}
        onClick={start}
      >
        {busy ? (
          <Loader2 className="spin" size={18} />
        ) : (
          <Fingerprint size={20} />
        )}{" "}
        {busy
          ? "Preparing verification…"
          : demo
            ? "Simulate successful verification"
            : "Continue with World ID"}
      </button>
      {!demo && wallet?.demo && (
        <p className="inline-message">
          Disconnect the demo wallet and connect MetaMask to verify with World
          App.
        </p>
      )}
      {demo && (
        <p className="verification-caption">
          Demo verification · No World App connection
        </p>
      )}
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
