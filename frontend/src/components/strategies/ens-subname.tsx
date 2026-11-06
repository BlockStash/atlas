"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  AtSign,
  BadgeCheck,
  Copy,
  Link2,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { isEns, strategyHandle, type Strategy } from "@/lib/strategies";
import { transactionMessage } from "@/lib/transactions";
import type { Hash } from "viem";
import { useStrategyStore } from "./ui";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "wallet"; what: string }
  | { kind: "pending"; what: string; hash: Hash }
  | { kind: "verifying" };

type Status = import("@/lib/ens-subnames").ParentStatus;

const ensLib = () => import("@/lib/ens-subnames");
const txUrl = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
const ensAppHref = (name: string) =>
  `https://sepolia.app.ens.domains/${encodeURIComponent(name)}`;

/**
 * Publishes ENSv2 subnames for the creator's strategies: checks the root name's resolver, sets up
 * a Permissioned Resolver if it needs one, writes every record in one multicall, then has the
 * server confirm each subname resolves to this wallet.
 */
export function useSubnamePublisher() {
  const { wallet, state, toast } = useAtlas();
  const store = useStrategyStore();
  const root = isEns(state.ensName) ? state.ensName!.toLowerCase() : null;
  const [status, setStatus] = useState<Status | null>(null),
    [phase, setPhase] = useState<Phase>({ kind: "idle" }),
    [error, setError] = useState("");
  const canWrite = !!wallet && !wallet.demo && !!root;

  const check = useCallback(async () => {
    if (!canWrite) return null;
    setError("");
    setPhase({ kind: "checking" });
    try {
      const next = await (await ensLib()).inspectParent(root!, wallet!.address);
      setStatus(next);
      return next;
    } catch (e) {
      setError(transactionMessage(e));
      return null;
    } finally {
      setPhase({ kind: "idle" });
    }
  }, [canWrite, root, wallet]);

  useEffect(() => {
    setStatus(null);
    void check();
  }, [check]);

  const publish = async (strategies: Strategy[]) => {
    if (!canWrite || !strategies.length) return;
    setError("");
    try {
      const lib = await ensLib();
      let current = status ?? (await check());
      if (!current) return;
      if (current.kind === "unavailable") throw new Error(current.reason);
      let resolver = current.kind === "ready" ? current.resolver : undefined;
      if (current.kind === "needs-resolver") {
        resolver = await lib.setupParentResolver(
          current,
          wallet!.address,
          (step, hash) => {
            const what =
              step === "deploy"
                ? "Deploying your ENSv2 resolver (1 of 3)"
                : `Pointing ${current!.name} at it (2 of 3)`;
            setPhase(
              hash ? { kind: "pending", what, hash } : { kind: "wallet", what },
            );
          },
        );
        current = { kind: "ready", name: current.name, resolver };
        setStatus(current);
      }
      const ids = strategies.map((s) => s.id);
      const targets = await store.ensTargets(ids);
      const byId = new Map(strategies.map((s) => [s.id, s]));
      const what = `Writing ${targets.length} subname${targets.length === 1 ? "" : "s"}`;
      setPhase({ kind: "wallet", what });
      const hash = await lib.publishSubnames(
        resolver!,
        wallet!.address,
        targets.map((t) => ({
          name: t.name,
          url: `${window.location.origin}/strategies/${t.id}`,
          description: byId.get(t.id)?.tagline ?? "",
        })),
        (h) => setPhase({ kind: "pending", what, hash: h }),
      );
      setPhase({ kind: "verifying" });
      const saved = await store.confirmEns(ids, hash);
      toast(
        saved.length === 1
          ? `${saved[0]!.ens} now resolves to your wallet.`
          : `${saved.length} subnames now resolve to your wallet.`,
      );
    } catch (e) {
      setError(transactionMessage(e));
    } finally {
      setPhase({ kind: "idle" });
    }
  };

  return { root, wallet, status, phase, error, check, publish, canWrite };
}

function PhaseLine({ phase }: { phase: Phase }) {
  if (phase.kind === "idle") return null;
  const text =
    phase.kind === "checking"
      ? "Checking your ENS name…"
      : phase.kind === "verifying"
        ? "Confirming the subname resolves…"
        : phase.kind === "wallet"
          ? `${phase.what} — confirm in your wallet`
          : `${phase.what} — waiting for Sepolia`;
  return (
    <span className="ens-note phase">
      <Loader2 size={13} className="spin" /> {text}
      {phase.kind === "pending" && (
        <a href={txUrl(phase.hash)} target="_blank" rel="noreferrer">
          tx <ArrowUpRight size={11} />
        </a>
      )}
    </span>
  );
}

function SetupNote({ status }: { status: Status | null }) {
  if (!status || status.kind === "ready") return null;
  if (status.kind === "unavailable")
    return <span className="ens-note warn">{status.reason}</span>;
  return (
    <span className="ens-note warn">
      {status.name} isn&apos;t on an ENSv2 Permissioned Resolver yet. Publishing
      first deploys one for you and points {status.name} at it (keeping its ETH
      address). Other records on the old resolver, like an avatar, aren&apos;t
      copied.
    </span>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function CopyValue({ value, label }: { value: string; label: string }) {
  const { toast } = useAtlas();
  return (
    <button
      type="button"
      className="ens-copy"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={() =>
        navigator.clipboard.writeText(value).then(
          () => toast(`${label} copied.`),
          () => toast("Could not copy."),
        )
      }
    >
      <Copy size={12} />
    </button>
  );
}

/** Strategy detail: the subname's onchain status, with publish / link actions for the creator. */
export function StrategyEnsPanel({
  s,
  owner,
}: {
  s: Strategy;
  owner: boolean;
}) {
  const pub = useSubnamePublisher();
  const live = !!s.ens && s.ensRecord?.name === s.ens;
  if (!owner && !live) return null;
  const busy = pub.phase.kind !== "idle";
  // A strategy saved before ENS was linked gets its handle when it's published.
  const handle = s.ens ?? strategyHandle(s.name, pub.root);
  const linked = !!pub.root || live;
  const record = s.ensRecord;

  return (
    <section
      className={`panel protocol-explainer strategy-ens-panel ${live ? "live" : ""}`}
    >
      <header className="strategy-ens-head">
        <span className="eyebrow">
          <AtSign size={13} /> ENS subname
        </span>
        {live ? (
          <span className="ens-status live">
            <i /> Live
          </span>
        ) : linked ? (
          <span className="ens-status">
            <i /> Not published
          </span>
        ) : null}
      </header>

      {!linked ? (
        // No ENS linked: leave the slot visibly empty and offer to link one.
        <>
          <div className="ens-sub-card empty">
            <span className="ens-sub-name">
              {strategyHandle(s.name, "your-name.eth") ??
                "strategy.your-name.eth"}
            </span>
            <span className="ens-sub-meta">No ENS name linked</span>
          </div>
          <p className="strategy-ens-copy">
            Link an ENS name and each strategy gets its own subname that
            resolves to your wallet.
          </p>
          <Link className="btn secondary small ens-wide" href="/wallet">
            <Link2 size={14} /> Link ENS name
          </Link>
        </>
      ) : (
        <>
          <div className="ens-sub-card">
            {live && <BadgeCheck size={18} className="ens-sub-icon" />}
            <div>
              <span className="ens-sub-name" title={handle ?? ""}>
                {handle}
              </span>
              <span className="ens-sub-meta">
                {live
                  ? `Resolves to ${pub.root ?? s.creator.name}`
                  : `Will resolve to ${pub.root ?? "your name"}`}
              </span>
            </div>
          </div>

          {live && record ? (
            <>
              <dl className="ens-rows">
                <div>
                  <dt>Address</dt>
                  <dd>
                    <code title={record.address}>{short(record.address)}</code>
                    <CopyValue value={record.address} label="Address" />
                  </dd>
                </div>
                <div>
                  <dt>Resolver</dt>
                  <dd>
                    <a
                      href={`https://sepolia.etherscan.io/address/${record.resolver}`}
                      target="_blank"
                      rel="noreferrer"
                      title={record.resolver}
                    >
                      <code>{short(record.resolver)}</code>
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>Network</dt>
                  <dd>Sepolia · ENSv2</dd>
                </div>
                <div>
                  <dt>Published</dt>
                  <dd>
                    {new Date(record.verifiedAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </dd>
                </div>
              </dl>
              <div className="ens-actions">
                <a
                  className="btn secondary small"
                  href={ensAppHref(s.ens!)}
                  target="_blank"
                  rel="noreferrer"
                >
                  ENS app <ArrowUpRight size={13} />
                </a>
                <a
                  className="btn secondary small"
                  href={txUrl(record.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Transaction <ArrowUpRight size={13} />
                </a>
              </div>
            </>
          ) : (
            <>
              <p className="strategy-ens-copy">
                Publishing writes this subname to your ENSv2 resolver in one
                transaction. It resolves to your wallet address.
              </p>
              {pub.wallet?.demo ? (
                <span className="ens-note warn">
                  Connect MetaMask to publish onchain.
                </span>
              ) : (
                <SetupNote status={pub.status} />
              )}
              <div className="ens-actions">
                <button
                  className="btn primary small ens-wide"
                  disabled={
                    busy || !pub.canWrite || pub.status?.kind === "unavailable"
                  }
                  onClick={() => pub.publish([s])}
                >
                  {busy ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Upload size={14} />
                  )}
                  Publish subname
                </button>
                {pub.status?.kind === "unavailable" && (
                  <button
                    className="btn secondary small"
                    disabled={busy}
                    onClick={() => void pub.check()}
                  >
                    <RefreshCw size={14} /> Check again
                  </button>
                )}
              </div>
            </>
          )}
          <PhaseLine phase={pub.phase} />
          {pub.error && <span className="ens-note error">{pub.error}</span>}
        </>
      )}
    </section>
  );
}

/** My strategies: publish every unpublished strategy subname in a single transaction. */
export function EnsBatchPublish({ strategies }: { strategies: Strategy[] }) {
  const pub = useSubnamePublisher();
  const pending = strategies.filter(
    (s) => !(s.ens && s.ensRecord?.name === s.ens),
  );
  if (!pub.root) return null;
  const busy = pub.phase.kind !== "idle";
  const batch = pending.slice(0, 25);
  return (
    <div className="ens-batch">
      {pending.length ? (
        <button
          className="btn primary small"
          disabled={busy || !pub.canWrite || pub.status?.kind === "unavailable"}
          title={
            pub.wallet?.demo
              ? "Connect MetaMask to publish onchain"
              : pub.status?.kind === "unavailable"
                ? pub.status.reason
                : undefined
          }
          onClick={() => pub.publish(batch)}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          Publish {batch.length} subname{batch.length === 1 ? "" : "s"}
        </button>
      ) : (
        strategies.length > 0 && (
          <span className="ens-status live">
            <i /> All subnames live
          </span>
        )
      )}
      <PhaseLine phase={pub.phase} />
      {pending.length > 0 && <SetupNote status={pub.status} />}
      {pub.error && <span className="ens-note error">{pub.error}</span>}
    </div>
  );
}
