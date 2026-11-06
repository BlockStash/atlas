"use client";
import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { Loader2, RefreshCw, ExternalLink } from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { DashboardShell } from "@/components/dashboard/shell";
import {
  fetchConfig,
  overview,
  configuredAddresses,
  protocolError,
  type Overview,
  type ProtocolConfig,
  type TxState,
} from "@/lib/protocol/client";
import { readChainCache, writeChainCache } from "@/lib/chain-cache";
export const fmt = (value: bigint, decimals = 6, digits = 4) =>
  Number(formatUnits(value, decimals)).toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
export function useProtocol() {
  const { wallet } = useAtlas();
  const [config, setConfig] = useState<ProtocolConfig | null>(null),
    [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const account = wallet?.address as Address | undefined;
  // Restore the last protocol read for this wallet from the session before refreshing it.
  useEffect(() => {
    const cached = readChainCache<{
      config: ProtocolConfig;
      data: Overview | null;
    }>("protocol", account);
    if (cached) {
      setConfig(cached.value.config);
      setData(cached.value.data);
    }
  }, [account]);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await fetchConfig();
      setConfig(cfg);
      if (cfg.configured) {
        if (!configuredAddresses(cfg))
          throw new Error("Invalid protocol deployment addresses.");
        if (account) {
          const next = await overview(cfg, account);
          setData(next);
          writeChainCache("protocol", account, { config: cfg, data: next });
        }
      }
      setError("");
    } catch (e) {
      setError(protocolError(e));
    } finally {
      setLoading(false);
    }
  }, [account]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { wallet, account, config, data, error, loading, reload };
}
export function ProtocolFrame({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
export function SetupState({
  loading,
  config,
  error,
  retry,
}: {
  loading: boolean;
  config: ProtocolConfig | null;
  error: string;
  retry: () => void;
}) {
  if (loading && !config)
    return (
      <div className="protocol-empty">
        <Loader2 className="spin" />
        <h2>Reading the Atlas protocol…</h2>
      </div>
    );
  return (
    <div className="panel protocol-empty">
      <h2>
        {error ? "Could not read the protocol" : "Protocol deployment required"}
      </h2>
      <p>
        {error ||
          config?.message ||
          "Deploy Atlas to Sepolia and configure PROTOCOL_DEPLOYMENT_FILE on the backend."}
      </p>
      <p>
        Real contract balances appear here after deployment. All stock assets in
        this protocol are demo synthetic representations.
      </p>
      <button className="btn secondary" onClick={retry}>
        <RefreshCw size={15} />
        Retry
      </button>
    </div>
  );
}
export function TransactionStatus({
  tx,
  error,
}: {
  tx: TxState | null;
  error?: string;
}) {
  return (
    <>
      {tx && (
        <div className="protocol-tx" role="status">
          {(tx.state === "waiting" || tx.state === "submitted") && (
            <Loader2 className="spin" size={15} />
          )}
          <span>
            {tx.state === "waiting"
              ? "Approve the request in MetaMask."
              : tx.state === "submitted"
                ? "Submitted. Waiting for Sepolia confirmation…"
                : tx.state === "failed"
                  ? "Transaction failed or was not confirmed. Check its status before retrying."
                  : "Transaction confirmed."}
          </span>
          {tx.hash && (
            <a
              href={`https://sepolia.etherscan.io/tx/${tx.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="panel protocol-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
