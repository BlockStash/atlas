"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Pencil,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard/shell";
import { useAtlas } from "@/components/atlas/provider";
import { StrategyChart } from "./chart";
import {
  DEMO_UI,
  bpsPct,
  describeAllocation,
  describeEntry,
  describeExit,
  intentApi,
  num,
  signAuthorization,
  usd,
  type CreateResult,
  type Evaluation,
  type Intent,
  type ParseResult,
} from "@/lib/intent/client";

const EXAMPLES = [
  "Buy Apple with 1,000 USDT when NASDAQ opens. Max slippage 0.5%. Sell at +8% or -3%.",
  "Buy 500 USDT of Nvidia if price falls below $180.",
  "Invest 10% of my portfolio in TCS when the Indian market opens.",
  "Sell my Apple position if profit reaches 12%.",
];
const DISCLAIMER =
  "Atlas AI converts your instructions into trading rules. It does not guarantee returns.";

export function DemoBanner({ simulated }: { simulated: boolean }) {
  if (!DEMO_UI && !simulated) return null;
  return (
    <div className="intent-demo-banner" role="note">
      <strong>Investor Demo</strong> — fixture prices and a simulated execution
      ledger. Nothing here moves real funds.
    </div>
  );
}

export function NewIntentPage() {
  const { wallet, toast } = useAtlas();
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [draft, setDraft] = useState<Intent | null>(null);
  const [ev, setEv] = useState<Evaluation | null>(null);
  const [parseHash, setParseHash] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [ack, setAck] = useState(false);
  const [signing, setSigning] = useState<
    "idle" | "creating" | "signing" | "activating"
  >("idle");
  const [sim, setSim] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    intentApi
      .config()
      .then((c) => setSim(c.executionMode === "SIMULATED"))
      .catch(() => undefined);
  }, []);

  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : "Something went wrong.");
  };
  const build = async (text = prompt) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setDraft(null);
    setEv(null);
    setEditing(false);
    try {
      const r = await intentApi.parse(text);
      setResult(r);
      if (r.status === "OK") {
        setDraft(r.intent);
        setEv(r.evaluation);
        setParseHash(r.parseHash);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  // Manual edits change the structured intent directly, then Atlas re-validates and re-simulates it.
  const revalidate = useCallback(async (next: Intent) => {
    const id = ++seq.current;
    try {
      const e = await intentApi.evaluate(next);
      if (id === seq.current) setEv(e);
    } catch (e) {
      if (id === seq.current) fail(e);
    }
  }, []);
  const update = (fn: (i: Intent) => Intent) => {
    if (!draft) return;
    const next = fn(structuredClone(draft));
    next.metadata.parser = "manual";
    setDraft(next);
    setEv(null);
    void revalidate(next);
  };

  const sign = async () => {
    if (!draft || !wallet) return;
    setError(null);
    try {
      setSigning("creating");
      const created: CreateResult = await intentApi.create(draft, parseHash);
      setSigning("signing");
      const signature =
        wallet.demo && created.demoSignatureAllowed
          ? "DEMO"
          : await signAuthorization(wallet.address, created.typedData);
      setSigning("activating");
      await intentApi.activate(created.id, signature);
      toast("Strategy activated. Atlas is now watching the conditions.");
      router.push("/intent");
    } catch (e) {
      fail(e);
      setSigning("idle");
    }
  };

  const stage = !result ? 1 : result.status === "OK" ? 3 : 2;
  const blocking = ev ? [...ev.issues, ...ev.blockingRisk] : [];
  const canConfirm = !!ev && ev.valid && !!ev.simulation && signing === "idle";

  return (
    <DashboardShell>
      <main className="protocol-content intent-page">
        <Link className="text-button" href="/intent">
          <ArrowLeft size={14} /> My intent strategies
        </Link>
        <div className="section-heading">
          <div>
            <span className="eyebrow">AI INTENT TRADING</span>
            <h1>
              <Bot size={22} /> New strategy
            </h1>
          </div>
        </div>
        <DemoBanner simulated={sim} />
        <ol className="intent-stages" aria-label="Progress">
          {["Your prompt", "Atlas understood", "Preview & confirm"].map(
            (s, i) => (
              <li
                key={s}
                className={
                  stage === i + 1 ? "active" : stage > i + 1 ? "done" : ""
                }
              >
                {i + 1}. {s}
              </li>
            ),
          )}
        </ol>
        <div className="intent-grid">
          <section className="panel intent-panel">
            <h2>Describe Your Trade</h2>
            <textarea
              className="intent-prompt"
              value={prompt}
              maxLength={600}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Buy Apple with 1,000 USDT after NASDAQ opens. Max slippage 0.5%. Sell at 8% profit or 3% loss."
              aria-label="Describe your trade"
            />
            <button
              className="btn primary full"
              disabled={busy || prompt.trim().length < 5}
              onClick={() => build()}
            >
              <Sparkles size={15} />{" "}
              {busy ? "Reading your instruction…" : "Build Strategy"}
            </button>
            <div className="intent-chips">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  className="intent-chip"
                  onClick={() => {
                    setPrompt(e);
                    void build(e);
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
            <p className="intent-disclaimer">
              <ShieldCheck size={13} /> {DISCLAIMER}
            </p>
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            {result?.status === "CLARIFICATION_NEEDED" && (
              <div className="intent-clarify" role="status">
                <strong>{result.question}</strong>
                <ClarifyOptions
                  result={result}
                  onPick={(text) => {
                    const p = `${prompt.trim().replace(/\.$/, "")} ${text}`;
                    setPrompt(p);
                    void build(p);
                  }}
                />
              </div>
            )}
            {result?.status === "UNSUPPORTED_INTENT" && (
              <div className="error-box" role="alert">
                Atlas can’t do that yet: {result.reason}
              </div>
            )}
          </section>

          <section
            className="panel intent-panel intent-preview"
            aria-live="polite"
          >
            {!draft && (
              <div className="intent-empty">
                <Bot size={30} />
                <p>
                  Your structured strategy and preview appear here. Nothing is
                  active until you review, confirm and sign.
                </p>
              </div>
            )}
            {draft && (
              <>
                <StrategyCard intent={draft} ev={ev} />
                {draft.metadata.defaultsApplied.length > 0 && (
                  <p className="intent-note">
                    Atlas applied defaults you didn’t specify:{" "}
                    {draft.metadata.defaultsApplied
                      .map((d) =>
                        d === "maxSlippageBps"
                          ? "max slippage 1%"
                          : d === "validUntil"
                            ? "valid for 24 hours"
                            : d,
                      )
                      .join(", ")}
                    . Edit them below.
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
                      symbol={draft.asset.symbol}
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
                      <M
                        l="Estimated fee"
                        v={usd(ev.simulation.estimatedFeesUSDT, 4)}
                      />
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
                            : ev.simulation.marketStatus
                                .replace("_", " ")
                                .toLowerCase()
                        }
                      />
                    </div>
                    {ev.simulation.warnings.length > 0 && (
                      <ul className="intent-warnings">
                        {ev.simulation.warnings.map((w, i) => (
                          <li
                            key={i}
                            className={`sev-${w.severity.toLowerCase()}`}
                          >
                            <AlertTriangle size={13} /> <b>{w.severity}</b>{" "}
                            {w.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="intent-disclaimer">
                      {ev.simulation.disclaimer}
                    </p>
                  </>
                )}
                {editing && <EditForm intent={draft} onChange={update} />}
                <div className="intent-actions">
                  <button
                    className="btn secondary"
                    onClick={() => setEditing((v) => !v)}
                  >
                    <Pencil size={14} />{" "}
                    {editing ? "Done editing" : "Edit Strategy"}
                  </button>
                  <button
                    className="btn primary"
                    disabled={!canConfirm}
                    onClick={() => {
                      setAck(false);
                      setConfirm(true);
                    }}
                  >
                    Confirm &amp; Continue
                  </button>
                </div>
              </>
            )}
          </section>
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
              {draft && ev && (
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
              {sim && (
                <p className="intent-note">
                  Execution is simulated in this environment.
                </p>
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
                      : "Activating…"}
              </button>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </main>
    </DashboardShell>
  );
}

function M({ l, v }: { l: string; v: string }) {
  return (
    <div className="intent-metric">
      <span>{l}</span>
      <strong>{v}</strong>
    </div>
  );
}

function ClarifyOptions({
  result,
  onPick,
}: {
  result: Extract<ParseResult, { status: "CLARIFICATION_NEEDED" }>;
  onPick: (append: string) => void;
}) {
  const [input, setInput] = useState<Record<string, string>>({});
  return (
    <div className="intent-options">
      {result.options.map((o) => (
        <div key={o.label} className="intent-option">
          {o.needsInput ? (
            <>
              <input
                aria-label={o.label}
                placeholder={
                  o.needsInput === "price"
                    ? "Price in USDT, e.g. 180"
                    : "UTC time, e.g. 2026-11-09T14:30Z"
                }
                value={input[o.label] ?? ""}
                onChange={(e) =>
                  setInput({ ...input, [o.label]: e.target.value })
                }
              />
              <button
                className="btn secondary small"
                disabled={!input[o.label]}
                onClick={() =>
                  onPick(
                    `${o.append} ${o.needsInput === "price" ? "$" : ""}${input[o.label]}`,
                  )
                }
              >
                {o.label}
              </button>
            </>
          ) : (
            <button
              className="btn secondary small"
              onClick={() => onPick(o.append)}
            >
              {o.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function StrategyCard({
  intent,
  ev,
}: {
  intent: Intent;
  ev: Evaluation | null;
}) {
  const sl = intent.exitConditions.find((e) => e.type === "STOP_LOSS_BPS");
  return (
    <div className="intent-card">
      <div className="intent-card-head">
        <div>
          <h3>{intent.asset.companyName.toUpperCase()}</h3>
          <span>
            {intent.asset.symbol} · {intent.asset.market}
          </span>
        </div>
        <span className={`intent-side ${intent.side.toLowerCase()}`}>
          {intent.side}
        </span>
      </div>
      <div className="intent-rows">
        <Row
          k="Allocation"
          v={describeAllocation(intent.allocation, intent.side)}
        />
        <Row
          k="Entry"
          v={
            intent.entryConditions
              .map((c) => describeEntry(c, intent.asset.market))
              .join(" and ") || "Immediately when valid"
          }
        />
        <Row
          k="Maximum slippage"
          v={
            intent.constraints.maxSlippageBps !== undefined
              ? bpsPct(intent.constraints.maxSlippageBps)
              : "—"
          }
        />
        <Row
          k="Exit"
          v={
            intent.exitConditions.length
              ? intent.exitConditions.map(describeExit).join(" · ")
              : "None"
          }
        />
        {!sl && intent.side === "BUY" && (
          <Row k="Stop loss" v="None set" warn />
        )}
        <Row
          k="Validity"
          v={
            intent.constraints.validUntil
              ? `Until ${new Date(intent.constraints.validUntil * 1000).toLocaleString()}`
              : "—"
          }
        />
        {ev?.price && (
          <Row
            k="Current price"
            v={`${usd(ev.price.priceUSDT)}${ev.price.source === "demo" ? " (demo price)" : ""}`}
          />
        )}
      </div>
    </div>
  );
}
function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className={`intent-row ${warn ? "warn" : ""}`}>
      <span>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

/** Direct edits of the structured intent: allocation, slippage, entry price, take profit, stop loss, expiry. */
function EditForm({
  intent,
  onChange,
}: {
  intent: Intent;
  onChange: (fn: (i: Intent) => Intent) => void;
}) {
  const tp = intent.exitConditions.find((e) => e.type === "TAKE_PROFIT_BPS");
  const sl = intent.exitConditions.find((e) => e.type === "STOP_LOSS_BPS");
  const entryPrice = intent.entryConditions.find(
    (e) => e.type === "PRICE_BELOW" || e.type === "PRICE_ABOVE",
  );
  const setExit = (
    type: "TAKE_PROFIT_BPS" | "STOP_LOSS_BPS",
    pctText: string,
  ) =>
    onChange((i) => {
      i.exitConditions = i.exitConditions.filter((e) => e.type !== type);
      const v = Math.round(Number(pctText) * 100);
      if (pctText !== "" && Number.isFinite(v) && v > 0)
        i.exitConditions.push({ type, value: v });
      return i;
    });
  const [hours, setHours] = useState(() =>
    intent.constraints.validUntil
      ? String(
          Math.max(
            1,
            Math.round(
              (intent.constraints.validUntil - Date.now() / 1000) / 3600,
            ),
          ),
        )
      : "24",
  );
  return (
    <fieldset className="intent-edit">
      <legend>Edit strategy</legend>
      <label>
        Allocation type
        <select
          value={intent.allocation.type}
          onChange={(e) =>
            onChange((i) => {
              i.allocation.type = e.target
                .value as Intent["allocation"]["type"];
              return i;
            })
          }
        >
          <option value="FIXED_USDT">Fixed USDT</option>
          <option value="PORTFOLIO_PERCENT">
            {intent.side === "SELL" ? "% of position" : "% of portfolio"}
          </option>
          {intent.side === "BUY" && (
            <option value="VAULT_PERCENT">% of vault</option>
          )}
        </select>
      </label>
      <label>
        Allocation value
        <input
          inputMode="decimal"
          value={intent.allocation.value}
          onChange={(e) =>
            onChange((i) => {
              i.allocation.value = e.target.value;
              return i;
            })
          }
        />
      </label>
      <label>
        Max slippage (%)
        <input
          inputMode="decimal"
          value={
            intent.constraints.maxSlippageBps !== undefined
              ? String(intent.constraints.maxSlippageBps / 100)
              : ""
          }
          onChange={(e) =>
            onChange((i) => {
              const v = Math.round(Number(e.target.value) * 100);
              if (v > 0) i.constraints.maxSlippageBps = v;
              else delete i.constraints.maxSlippageBps;
              return i;
            })
          }
        />
      </label>
      {entryPrice && "priceUSDT" in entryPrice && (
        <label>
          Entry price (USDT)
          <input
            inputMode="decimal"
            value={entryPrice.priceUSDT}
            onChange={(e) =>
              onChange((i) => {
                const c = i.entryConditions.find(
                  (x) => x.type === entryPrice.type,
                );
                if (c && "priceUSDT" in c) c.priceUSDT = e.target.value;
                return i;
              })
            }
          />
        </label>
      )}
      <label>
        Take profit (%)
        <input
          inputMode="decimal"
          value={tp && "value" in tp ? String(tp.value / 100) : ""}
          placeholder="none"
          onChange={(e) => setExit("TAKE_PROFIT_BPS", e.target.value)}
        />
      </label>
      <label>
        Stop loss (%)
        <input
          inputMode="decimal"
          value={sl && "value" in sl ? String(sl.value / 100) : ""}
          placeholder="none"
          onChange={(e) => setExit("STOP_LOSS_BPS", e.target.value)}
        />
      </label>
      <label>
        Valid for (hours)
        <input
          inputMode="numeric"
          value={hours}
          onChange={(e) => {
            setHours(e.target.value);
            onChange((i) => {
              const h = Number(e.target.value);
              if (h > 0)
                i.constraints.validUntil = Math.floor(
                  Date.now() / 1000 + h * 3600,
                );
              return i;
            });
          }}
        />
      </label>
    </fieldset>
  );
}
