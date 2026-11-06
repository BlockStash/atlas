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
  iso ? new Date(iso).toLocaleString() : "—";
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
  // Share of the entity's lifetime already used, from creation to expiry.
  const used =
    e?.createdAt && e.expiresAt
      ? Math.min(
          100,
          Math.max(
            0,
            ((Date.now() - Date.parse(e.createdAt)) /
              (Date.parse(e.expiresAt) - Date.parse(e.createdAt))) *
              100,
          ),
        )
      : 0;

  return (
    <section className="panel arkiv-panel">
      <div className="ens-title">
        <Database size={22} />
        <div>
          <h3>Arkiv activity</h3>
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
          <ExternalLink size={14} /> View on Arkiv testnet
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
            <div>
              <span>Storage lifetime</span>
              <b>{e.daysLeft !== null ? `${e.daysLeft} days left` : "—"}</b>
            </div>
            <div
              className="arkiv-bar"
              role="progressbar"
              aria-valuenow={Math.round(used)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <i style={{ width: `${used}%` }} />
            </div>
            <small>
              Expires {when(e.expiresAt)} (estimated). Every profile update
              extends it.
            </small>
          </div>

          <div className="arkiv-entity">
            <div>
              <small>Entity key</small>
              <code>{short(e.key)}</code>
              <button
                className="text-button"
                aria-label="Copy entity key"
                onClick={() =>
                  navigator.clipboard
                    .writeText(e.key)
                    .then(() => toast("Entity key copied."))
                    .catch(() => toast("Could not copy."))
                }
              >
                <Copy size={12} />
              </button>
            </div>
            <div>
              <small>Schema</small>
              <code>{e.schema}</code>
            </div>
            <div>
              <small>Namespace</small>
              <code>{e.namespace}</code>
            </div>
            <div>
              <small>Written by</small>
              <a
                className="arkiv-link"
                href={`${EXPLORER}/address/${e.creator}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(e.creator)} <ExternalLink size={12} />
              </a>
            </div>
          </div>
          <p className="arkiv-note">
            <ExternalLink size={14} /> Your writes are sent by the Atlas signer.
            Open a block above, or the signer, in the explorer to see the
            transactions on the Arkiv chain.
          </p>
          <p className="arkiv-note">
            <Lock size={14} /> The record is AES-256 encrypted before it leaves
            Atlas. Only your wallet and Atlas can read it. The view below is
            decrypted for you, with secrets left out.
          </p>

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
