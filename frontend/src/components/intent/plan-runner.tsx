"use client";
/**
 * Atlas AI trade plans inside strategies.
 *
 * - `PlanPreview`: the plan as Atlas AI trading shows it (card, summary, issues, simulated fill,
 *   optional edit form). Used by the strategy studio while building.
 * - `PlanRunner`: backtest, paper trade or deploy a saved plan — the same engine calls, risk
 *   checks and wallet signature as Atlas AI trading. Used on the strategy page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  FlaskConical,
  Loader2,
  Play,
  Rocket,
  X,
} from "lucide-react";
import { useAtlas } from "@/components/atlas/provider";
import { StrategyChart } from "./chart";
import { BacktestPanel } from "./backtest";
import { ConvertDialog } from "./convert";
import { DemoBanner, EditForm, M, StrategyCard } from "./new";
import {
  bpsPct,
  describeEntry,
  describeExit,
  intentApi,
  num,
  paperBridge,
  requestAusdtPermission,
  signAuthorization,
  usd,
  type Backtest,
  type BacktestDays,
  type Evaluation,
  type Intent,
} from "@/lib/intent/client";
import { intentFromPlan } from "@/lib/intent/plan";
import type { ExecutablePlan } from "@/lib/strategies";

const DEFAULT_LABEL: Record<string, string> = {
  maxSlippageBps: "max slippage 1%",
  validUntil: "valid for 24 hours",
};

/** Re-evaluates (validates, risk-checks, simulates) a plan whenever it changes. */
export function usePlanEvaluation(intent: Intent | null) {
  const [ev, setEv] = useState<Evaluation | null>(null),
    [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!intent) {
      setEv(null);
      return;
    }
    const id = ++seq.current;
    setEv(null);
    setError(null);
    intentApi
      .evaluate(intent)
      .then((e) => id === seq.current && setEv(e))
      .catch(
        (e: Error) => id === seq.current && setError(e.message || "Failed."),
      );
  }, [intent]);
  return { ev, error, setEv };
}

export function PlanPreview({
  intent,
  ev,
  editing = false,
  onEdit,
}: {
  intent: Intent;
  ev: Evaluation | null;
  editing?: boolean;
  onEdit?: (fn: (i: Intent) => Intent) => void;
}) {
  const blocking = ev ? [...ev.issues, ...ev.blockingRisk] : [];
  return (
    <>
      <StrategyCard intent={intent} ev={ev} />
      {intent.metadata.defaultsApplied.length > 0 && (
        <p className="intent-note">
          Atlas applied defaults you didn’t specify:{" "}
          {intent.metadata.defaultsApplied
            .map((d) => DEFAULT_LABEL[d] ?? d)
            .join(", ")}
          .{onEdit ? " Edit them below." : ""}
        </p>
      )}
      {ev?.summary && (
        <div className="intent-summary">
          <span className="eyebrow">ATLAS AI SUMMARY</span>
          <p>{ev.summary}</p>
        </div>
      )}
      {blocking.length > 0 && (
        <ul className="intent-issues" role="alert">
          {blocking.map((b, i) => (
            <li key={i}>
              <AlertTriangle size={13} /> {b.message}
            </li>
          ))}
        </ul>
      )}
      {ev?.simulation && (
        <>
          <StrategyChart
            symbol={intent.asset.symbol}
            current={ev.price?.priceUSDT}
            entry={ev.simulation.estimatedEntryPrice}
            takeProfit={ev.simulation.estimatedTakeProfitPrice}
            stopLoss={ev.simulation.estimatedStopLossPrice}
          />
          <div className="intent-metrics">
            <M
              l="Estimated shares"
              v={num(ev.simulation.estimatedQuantity, 4)}
            />
            <M
              l="Estimated entry value"
              v={usd(ev.simulation.estimatedNotionalUSDT)}
            />
            <M l="Estimated fee" v={usd(ev.simulation.estimatedFeesUSDT, 4)} />
            <M
              l="Estimated slippage"
              v={`${usd(ev.simulation.estimatedSlippageUSDT, 4)} (${bpsPct(ev.simulation.estimatedSlippageBps)})`}
            />
            <M
              l="Potential profit at target"
              v={usd(ev.simulation.estimatedProfitAtTargetUSDT)}
            />
            <M
              l="Max configured loss"
              v={usd(
                ev.simulation.estimatedLossAtStopUSDT ??
                  ev.risk?.estimatedMaxLossUSDT,
              )}
            />
            <M
              l="Exposure after trade"
              v={`${ev.simulation.exposureAfterTradePercent}%`}
            />
            <M
              l="Market"
              v={
                ev.market?.open
                  ? "Open"
                  : ev.simulation.marketStatus.replace("_", " ").toLowerCase()
              }
            />
          </div>
          {ev.simulation.warnings.length > 0 && (
            <ul className="intent-warnings">
              {ev.simulation.warnings.map((w, i) => (
                <li key={i} className={`sev-${w.severity.toLowerCase()}`}>
                  <AlertTriangle size={13} /> <b>{w.severity}</b> {w.message}
                </li>
              ))}
            </ul>
          )}
          <p className="intent-disclaimer">{ev.simulation.disclaimer}</p>
        </>
      )}
      {editing && onEdit && <EditForm intent={intent} onChange={onEdit} />}
    </>
  );
}

type RunTab = "backtest" | "paper" | "deploy";
const RUN_TABS = [
  ["backtest", FlaskConical, "Backtest"],
  ["paper", Play, "Paper trade"],
  ["deploy", Rocket, "Deploy"],
] as const;

/** Backtest, paper trade or deploy a strategy's saved Atlas AI trade plan. */
export function PlanRunner({ plan }: { plan: ExecutablePlan }) {
  const { wallet, toast } = useAtlas();
  const router = useRouter();
  // Times are rebased once per visit, so "valid for 24h" counts from now.
  const [draft] = useState<Intent>(() => intentFromPlan(plan));
  const { ev, error: evError, setEv } = usePlanEvaluation(draft);
  const [sim, setSim] = useState(false);
  const [runTab, setRunTab] = useState<RunTab>("backtest");
  const [btDays, setBtDays] = useState<BacktestDays>(90);
  const [bt, setBt] = useState<Backtest | null>(null);
  const [btLoading, setBtLoading] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [paperAck, setPaperAck] = useState(false);
  const [paperBusy, setPaperBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [ack, setAck] = useState(false);
  const [converting, setConverting] = useState(false);
  const [signing, setSigning] = useState<
    "idle" | "creating" | "signing" | "permission" | "activating"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const btSeq = useRef(0);

  useEffect(() => {
    intentApi
      .config()
      .then((c) => setSim(c.executionMode === "SIMULATED"))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!ev?.valid || !ev.simulation) {
      setBt(null);
      setBtError(
        ev && !ev.valid ? "Fix the issues above to backtest this plan." : null,
      );
      return;
    }
    const id = ++btSeq.current;
    setBtLoading(true);
    setBtError(null);
    intentApi
      .backtest(draft, btDays)
      .then((r) => id === btSeq.current && setBt(r.backtest))
      .catch(
        (e: Error) =>
          id === btSeq.current && (setBt(null), setBtError(e.message)),
      )
      .finally(() => id === btSeq.current && setBtLoading(false));
  }, [ev, btDays, draft]);

  const revalidate = useCallback(async () => {
    setEv(await intentApi.evaluate(draft));
  }, [draft, setEv]);

  const exitBps = (type: "TAKE_PROFIT_BPS" | "STOP_LOSS_BPS") => {
    const c = draft.exitConditions.find((e) => e.type === type);
    return c && "value" in c ? c.value : undefined;
  };
  const canConfirm = !!ev?.valid && !!ev.simulation && signing === "idle";

  const startPaper = async () => {
    if (!ev?.simulation) return;
    setPaperBusy(true);
    setError(null);
    try {
      const p = await paperBridge.preview({
        symbol: draft.asset.symbol,
        notionalUSDT: Number(ev.simulation.estimatedNotionalUSDT),
        maxSlippageBps: draft.constraints.maxSlippageBps,
        takeProfitBps: exitBps("TAKE_PROFIT_BPS"),
        stopLossBps: exitBps("STOP_LOSS_BPS"),
      });
      await paperBridge.confirm(p.order.id, p.confirmationToken);
      toast(
        `Paper trade started: ${num(p.order.quantity, 4)} ${p.order.draft.symbol} with paper USDT${p.defaults.length ? ` (defaults: ${p.defaults.join(", ")})` : ""}.`,
      );
      router.push("/paper");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start.");
    } finally {
      setPaperBusy(false);
    }
  };

  const sign = async () => {
    if (!wallet) return;
    setError(null);
    const funding = ev?.funding;
    // Live mode spends aUSDT: top up the vault first when it is short.
    if (funding && Number(funding.shortfallUSDT) > 0) {
      setConfirm(false);
      setConverting(true);
      return;
    }
    try {
      setSigning("creating");
      const created = await intentApi.create(draft);
      setSigning("signing");
      const signature =
        wallet.demo && created.demoSignatureAllowed
          ? "DEMO"
          : await signAuthorization(wallet.address, created.typedData);
      let permission;
      if (funding) {
        setSigning("permission");
        permission = await requestAusdtPermission(
          wallet.address,
          funding,
          draft.constraints.validUntil ??
            Math.floor(Date.now() / 1000) + 86_400,
          draft.asset.symbol,
        );
      }
      setSigning("activating");
      await intentApi.activate(created.id, signature, permission);
      toast(
        funding
          ? "Strategy deployed. Atlas will execute it on Sepolia with your aUSDT."
          : "Strategy deployed. Atlas is now watching the conditions.",
      );
      router.push("/intent");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not deploy.");
      setSigning("idle");
    }
  };

  return (
    <section className="panel plan-runner intent-body">
      <div className="strategy-perf-head">
        <h2>Run this strategy</h2>
        <span className="demo-badge">ATLAS AI TRADE PLAN</span>
      </div>
      <DemoBanner simulated={sim} />
      {(evError || error) && (
        <div className="error-box" role="alert">
          {error ?? evError}
        </div>
      )}
      {!ev && !evError ? (
        <div className="protocol-empty">
          <Loader2 className="spin" />
          <p>Checking the plan against live prices and your risk limits…</p>
        </div>
      ) : (
        <PlanPreview intent={draft} ev={ev} />
      )}

      <section className="run-trade">
        <div className="ens-tabs run-tabs" role="tablist">
          {RUN_TABS.map(([t, Icon, label]) => (
            <button
              key={t}
              role="tab"
              aria-selected={runTab === t}
              className={runTab === t ? "active" : ""}
              onClick={() => setRunTab(t)}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        {runTab === "backtest" && (
          <BacktestPanel
            bt={bt}
            days={btDays}
            loading={btLoading}
            error={btError}
            onDays={setBtDays}
          />
        )}
        {runTab === "paper" && (
          <div className="run-card">
            <p>
              Run this exact plan on the Paper Trading simulator with paper
              USDT. It buys at the next simulated minute with your spend,
              slippage cap and exits.
            </p>
            <dl className="run-facts">
              <dt>Spend</dt>
              <dd>{usd(ev?.simulation?.estimatedNotionalUSDT)} paper USDT</dd>
              <dt>Take profit</dt>
              <dd>
                {exitBps("TAKE_PROFIT_BPS") !== undefined
                  ? `+${bpsPct(exitBps("TAKE_PROFIT_BPS")!)}`
                  : "+10% (default)"}
              </dd>
              <dt>Stop loss</dt>
              <dd>
                {exitBps("STOP_LOSS_BPS") !== undefined
                  ? `−${bpsPct(exitBps("STOP_LOSS_BPS")!)}`
                  : "−5% (default)"}
              </dd>
              <dt>Max slippage</dt>
              <dd>
                {draft.constraints.maxSlippageBps !== undefined
                  ? bpsPct(draft.constraints.maxSlippageBps)
                  : "1% (default)"}
              </dd>
            </dl>
            {draft.side !== "BUY" ? (
              <p className="bt-empty">
                Paper Trading runs buy plans. Backtest this sell plan instead.
              </p>
            ) : (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={paperAck}
                  onChange={(e) => setPaperAck(e.target.checked)}
                />
                I understand this uses paper USDT on a simulated clock, not live
                prices or funds.
              </label>
            )}
          </div>
        )}
        {runTab === "deploy" && (
          <div className="run-card">
            <p>
              Deploying activates this plan for you: review the exact rules,
              then sign an authorization with your wallet. Atlas watches the
              conditions and executes within your limits. Its times count from
              now.
            </p>
            {bt && (
              <p className="muted">
                Backtest ({bt.days} days): target hit{" "}
                {bt.stats.takeProfitPct.toFixed(0)}%, stop hit{" "}
                {bt.stats.stopLossPct.toFixed(0)}%, median P&amp;L{" "}
                {usd(String(bt.stats.medianPnlUSDT))}.
              </p>
            )}
          </div>
        )}
      </section>

      <div className="intent-actions">
        {runTab === "backtest" && (
          <>
            <button
              className="btn secondary"
              disabled={!bt || draft.side !== "BUY"}
              onClick={() => setRunTab("paper")}
            >
              <Play size={14} /> Paper trade
            </button>
            <button
              className="btn primary"
              disabled={!canConfirm}
              onClick={() => setRunTab("deploy")}
            >
              <Rocket size={14} /> Deploy
            </button>
          </>
        )}
        {runTab === "paper" && (
          <button
            className="btn primary"
            disabled={
              !canConfirm || !paperAck || paperBusy || draft.side !== "BUY"
            }
            onClick={() => void startPaper()}
          >
            <Play size={14} /> {paperBusy ? "Starting…" : "Start paper trade"}
          </button>
        )}
        {runTab === "deploy" && (
          <button
            className="btn primary"
            disabled={!canConfirm || !wallet}
            onClick={() => {
              setAck(false);
              setConfirm(true);
            }}
          >
            <Rocket size={14} /> Confirm &amp; sign
          </button>
        )}
      </div>

      <Dialog.Root
        open={confirm}
        onOpenChange={(o) => signing === "idle" && setConfirm(o)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog intent-dialog">
            <Dialog.Close className="dialog-close" aria-label="Close">
              <X size={20} />
            </Dialog.Close>
            <span className="eyebrow">FINAL CONFIRMATION</span>
            <Dialog.Title>Review before you sign</Dialog.Title>
            <Dialog.Description>
              Signing authorizes exactly these rules, within these limits, and
              nothing more.
            </Dialog.Description>
            {ev && (
              <dl className="intent-confirm">
                <dt>Asset</dt>
                <dd>
                  {draft.asset.companyName} ({draft.asset.symbol}) ·{" "}
                  {draft.asset.market}
                </dd>
                <dt>Action</dt>
                <dd>{draft.side}</dd>
                <dt>Maximum spend</dt>
                <dd>{usd(ev.maxSpendUSDT)} USDT</dd>
                <dt>Max slippage</dt>
                <dd>
                  {draft.constraints.maxSlippageBps !== undefined
                    ? bpsPct(draft.constraints.maxSlippageBps)
                    : "—"}
                </dd>
                <dt>Entry rules</dt>
                <dd>
                  {draft.entryConditions
                    .map((c) => describeEntry(c, draft.asset.market))
                    .join(" and ") || "—"}
                </dd>
                <dt>Exit rules</dt>
                <dd>
                  {draft.exitConditions.map(describeExit).join(" · ") || "—"}
                </dd>
                <dt>Expires</dt>
                <dd>
                  {draft.constraints.validUntil
                    ? new Date(
                        draft.constraints.validUntil * 1000,
                      ).toLocaleString()
                    : "—"}
                </dd>
                <dt>Warnings</dt>
                <dd>
                  {ev.simulation?.warnings.length
                    ? ev.simulation.warnings.map((w) => w.message).join(" ")
                    : "None"}
                </dd>
              </dl>
            )}
            <label className="intent-ack">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I understand this strategy may result in losses.
            </label>
            {sim ? (
              <p className="intent-note">
                Execution is simulated in this environment.
              </p>
            ) : (
              ev?.funding && (
                <p className="intent-note">
                  Executes on Sepolia. After you sign, MetaMask asks you to let
                  the Atlas executor use up to {usd(ev.funding.requiredUSDT)} of
                  your aUSDT for this strategy until it expires.
                </p>
              )
            )}
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            <button
              className="btn primary full"
              disabled={!ack || signing !== "idle"}
              onClick={sign}
            >
              {signing === "idle"
                ? "Sign Strategy"
                : signing === "creating"
                  ? "Preparing…"
                  : signing === "signing"
                    ? "Check your wallet…"
                    : signing === "permission"
                      ? "Approve aUSDT permission in MetaMask…"
                      : "Activating…"}
            </button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ConvertDialog
        open={converting}
        funding={ev?.funding}
        account={wallet?.address}
        onClose={() => setConverting(false)}
        onConverted={() => {
          setConverting(false);
          toast("USDT converted to aUSDT. Review and sign your strategy.");
          void revalidate().then(() => {
            setAck(false);
            setConfirm(true);
          });
        }}
      />
    </section>
  );
}
