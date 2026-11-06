"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Database,
  ExternalLink,
  Lock,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAtlas } from "@/components/atlas/provider";

interface Activity {
  driver: string;
  ready: boolean;
  message?: string;
  network?: { name: string; chainId: number; currentBlock: string };
  signerAddress?: string;
  entity?: {
    key: string;
    schema: string;
    namespace: string;
    owner: string;
    creator: string;
    payloadBytes: number;
    createdBlock: string;
    updatedBlock: string;
    expiresBlock: string;
    createdAt: string | null;
    updatedAt: string | null;
    expiresAt: string | null;
    daysLeft: number | null;
  };
  stored?: { label: string; value: string }[];
  events?: {
    at: string | null;
    block: string;
    title: string;
    detail: string;
  }[];
}

/** Arkiv Rabdi block explorer (testnet). */
const EXPLORER = (
  process.env.NEXT_PUBLIC_ARKIV_EXPLORER_URL ||
  "https://rabdi.explorer.arkiv.network"
).replace(/\/$/, "");

const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
const day = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-6)}`;

/** Everything Atlas stores for this wallet in the Arkiv database, pulled live from the network. */
export function ArkivActivity() {
  const { wallet, toast } = useAtlas();
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const address = wallet?.address;

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setData(await api<Activity>("/storage/arkiv"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load Arkiv data.");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (address) void load();
  }, [address, load]);
  if (!wallet) return null;

  const e = data?.entity;
  // Share of the entity's lifetime still left, from the server's days-left count.
  const span =
    e?.createdAt && e.expiresAt
      ? (Date.parse(e.expiresAt) - Date.parse(e.createdAt)) / 86_400_000
      : 0;
  const left =
    e && e.daysLeft !== null && span > 0
      ? Math.min(100, Math.max(0, (e.daysLeft / span) * 100))
      : 0;

  return (
    <section className="panel arkiv-panel">
      <div className="ens-title">
        <Database size={22} />
        <div>
          <h3>
            Arkiv activity
            {data && (
              <span className={`arkiv-status ${e ? "ok" : ""}`}>
                <i /> {e ? "Synced" : data.ready ? "Empty" : "Unavailable"}
              </span>
            )}
          </h3>
          <p>Everything Atlas stores for you on the Arkiv database.</p>
        </div>
        <a
          className="btn secondary small"
          href={
            data?.signerAddress
              ? `${EXPLORER}/address/${data.signerAddress}`
              : EXPLORER
          }
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={14} /> Explorer
        </a>
        <button
          className="btn secondary small"
          onClick={() => void load()}
          disabled={busy}
          aria-label="Refresh Arkiv data"
        >
          <RefreshCw size={14} className={busy ? "spin" : ""} /> Refresh
        </button>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {!data && !error && <p className="intent-note">Reading from Arkiv…</p>}
      {data && !e && (
        <p className="intent-note">
          {data.message ?? "Nothing is stored in Arkiv for this wallet yet."}
        </p>
      )}

      {data && e && (
        <>
          <div className="arkiv-stats">
            <div>
              <small>Network</small>
              <strong>{data.network?.name}</strong>
              <span>
                Chain {data.network?.chainId} · block{" "}
                {Number(data.network?.currentBlock).toLocaleString()}
              </span>
            </div>
            <div>
              <small>Entities</small>
              <strong>1 profile</strong>
              <span>{e.payloadBytes} bytes, encrypted</span>
            </div>
            <div>
              <small>Created</small>
              <strong>{when(e.createdAt)}</strong>
              <a
                href={`${EXPLORER}/block/${e.createdBlock}`}
                target="_blank"
                rel="noreferrer"
              >
                block {Number(e.createdBlock).toLocaleString()}{" "}
                <ExternalLink size={11} />
              </a>
            </div>
            <div>
              <small>Last updated</small>
              <strong>{when(e.updatedAt)}</strong>
              <a
                href={`${EXPLORER}/block/${e.updatedBlock}`}
                target="_blank"
                rel="noreferrer"
              >
                block {Number(e.updatedBlock).toLocaleString()}{" "}
                <ExternalLink size={11} />
              </a>
            </div>
          </div>

          <div className="arkiv-life">
            <div className="arkiv-life-head">
              <span>Storage lifetime</span>
              <b>{e.daysLeft !== null ? `${e.daysLeft} days left` : "—"}</b>
            </div>
            <div
              className="arkiv-bar"
              role="progressbar"
              aria-label="Storage lifetime remaining"
              aria-valuenow={Math.round(left)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <i style={{ width: `${left}%` }} />
            </div>
            <div className="arkiv-life-foot">
              <span>Created {day(e.createdAt)}</span>
              <span>Expires {day(e.expiresAt)} · extended on every update</span>
            </div>
          </div>

          <dl className="arkiv-entity">
            <div>
              <dt>Entity key</dt>
              <dd>
                <code title={e.key}>{short(e.key)}</code>
                <button
                  className="arkiv-copy"
                  aria-label="Copy entity key"
                  title="Copy entity key"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(e.key)
                      .then(() => toast("Entity key copied."))
                      .catch(() => toast("Could not copy."))
                  }
                >
                  <Copy size={13} />
                </button>
              </dd>
            </div>
            <div>
              <dt>Schema</dt>
              <dd>
                <code>{e.schema}</code>
              </dd>
            </div>
            <div>
              <dt>Namespace</dt>
              <dd>
                <code>{e.namespace}</code>
              </dd>
            </div>
            <div>
              <dt>Written by</dt>
              <dd>
                <a
                  className="arkiv-link"
                  href={`${EXPLORER}/address/${e.creator}`}
                  target="_blank"
                  rel="noreferrer"
                  title={e.creator}
                >
                  <code>{short(e.creator)}</code> <ExternalLink size={12} />
                </a>
              </dd>
            </div>
          </dl>

          <div className="arkiv-notes">
            <p>
              <Lock size={14} />
              <span>
                <strong>AES-256 encrypted</strong> before it leaves Atlas. Only
                your wallet and Atlas can read it; the view below is decrypted
                for you, with secrets left out.
              </span>
            </p>
            <p>
              <ExternalLink size={14} />
              <span>
                <strong>Written by the Atlas signer.</strong> Open a block or
                the signer in the explorer to see the transactions on Arkiv.
              </span>
            </p>
          </div>

          <details className="activity-drop">
            <summary>
              <span>Data stored in Arkiv</span>
              <small>{data.stored?.length ?? 0} fields</small>
              <ChevronDown size={16} />
            </summary>
            <dl className="arkiv-fields">
              {data.stored?.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>
                    {f.value === "Yes" ? (
                      <span className="arkiv-yes">
                        <Check size={13} /> Yes
                      </span>
                    ) : (
                      f.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </details>

          <details className="activity-drop" open>
            <summary>
              <span>Activity</span>
              <small>{data.events?.length ?? 0} events</small>
              <ChevronDown size={16} />
            </summary>
            <ol className="strategy-feed">
              {data.events?.map((ev, i) => (
                <li
                  key={i}
                  className="ok"
                  style={{ ["--d" as string]: `${i * 80}ms` }}
                >
                  <span className="feed-dot">
                    {i === (data.events?.length ?? 0) - 1 ? (
                      <ShieldCheck size={13} />
                    ) : (
                      <Check size={13} />
                    )}
                  </span>
                  <div>
                    <strong>{ev.title}</strong>
                    <span>
                      {ev.detail} ·{" "}
                      <a
                        className="arkiv-link"
                        href={`${EXPLORER}/block/${ev.block}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        block {Number(ev.block).toLocaleString()}
                      </a>
                    </span>
                  </div>
                  <time>{when(ev.at)}</time>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}
