"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  AtSign,
  BadgeCheck,
  Link2,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { isEns, strategyHandle, type Strategy } from "@/lib/strategies";
import { transactionMessage } from "@/lib/transactions";
import type { Hash } from "viem";
import { EnsHandle, useStrategyStore } from "./ui";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "wallet"; what: string }
  | { kind: "pending"; what: string; hash: Hash }
  | { kind: "verifying" };

type Status = import("@/lib/ens-subnames").ParentStatus;

const ensLib = () => import("@/lib/ens-subnames");
const txUrl = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

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
    <span className="ens-subname-phase">
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
    return <span className="ens-subname-warn">{status.reason}</span>;
  return (
    <span className="ens-subname-warn">
      {status.name} isn&apos;t on an ENSv2 Permissioned Resolver yet. Publishing
      first deploys one for you and points {status.name} at it (keeping its ETH
      address). Other records on the old resolver, like an avatar, aren&apos;t
      copied.
    </span>
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

  return (
    <section className={`panel strategy-ens-panel ${live ? "live" : ""}`}>
      <div className="strategy-ens-panel-head">
        <span className="eyebrow">
          <AtSign size={13} /> ENS SUBNAME
        </span>
        {live && (
          <span className="ens-subname-ok">
            <BadgeCheck size={13} /> Live on Sepolia
          </span>
        )}
      </div>

      {!pub.root && owner && !live ? (
        // No ENS linked: leave the slot visibly empty and offer to link one.
        <div className="strategy-ens-empty">
          <span className="ens-subname-slot">
            <code>strategy-name</code>.<em>your-name</em>.eth
          </span>
          <p className="muted">
            Link an ENS name and every strategy gets its own subname that
            resolves to your wallet.
          </p>
          <Link className="btn secondary small" href="/wallet">
            <Link2 size={14} /> Link ENS
          </Link>
        </div>
      ) : (
        <>
          <div className="strategy-ens-name">
            {s.ens ? (
              <EnsHandle ens={s.ens} record={s.ensRecord} />
            ) : (
              handle && <code>{handle}</code>
            )}
          </div>
          {live ? (
            <dl className="strategy-ens-facts">
              <div>
                <dt>Resolves to</dt>
                <dd>
                  <code>{s.ensRecord!.address}</code>
                </dd>
              </div>
              <div>
                <dt>Resolver</dt>
                <dd>
                  <code>
                    {s.ensRecord!.resolver.slice(0, 8)}…
                    {s.ensRecord!.resolver.slice(-6)}
                  </code>{" "}
                  <span className="muted">Permissioned Resolver</span>
                </dd>
              </div>
              <div>
                <dt>Links</dt>
                <dd className="strategy-ens-links">
                  <a
                    href={`https://sepolia.app.ens.domains/${encodeURIComponent(s.ens!)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    ENS app <ArrowUpRight size={11} />
                  </a>
                  <a
                    href={txUrl(s.ensRecord!.txHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Transaction <ArrowUpRight size={11} />
                  </a>
                </dd>
              </div>
            </dl>
          ) : (
            <p className="muted">
              Not onchain yet. Publishing writes a record on your ENSv2 resolver
              so <strong>{s.ens ?? "this subname"}</strong> resolves to{" "}
              {pub.root ?? "your name"}&apos;s address.
            </p>
          )}
          {owner && !live && (
            <>
              {pub.wallet?.demo ? (
                <span className="ens-subname-warn">
                  Connect MetaMask to publish onchain.
                </span>
              ) : (
                <SetupNote status={pub.status} />
              )}
              <div className="strategy-ens-actions">
                <button
                  className="btn primary small"
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
          {pub.error && <span className="ens-subname-error">{pub.error}</span>}
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
          <span className="ens-subname-ok">
            <BadgeCheck size={13} /> All subnames live
          </span>
        )
      )}
      <PhaseLine phase={pub.phase} />
      {pending.length > 0 && <SetupNote status={pub.status} />}
      {pub.error && <span className="ens-subname-error">{pub.error}</span>}
    </div>
  );
}
