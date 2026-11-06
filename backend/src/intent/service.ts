import { randomUUID } from "node:crypto";
import { getAddress } from "ethers";
import {
  IntentError,
  type AtlasTradeIntent,
  type IntentSimulation,
  type PortfolioView,
  type RiskMetrics,
  type ValidationIssue,
  type AtlasIntentStatus,
} from "./types.js";
import type { IntentRepository, IntentRow } from "./repository.js";
import { parseIntent, type ModelClient, type ParseOutcome } from "./parser.js";
import { validateIntent } from "./validator.js";
import { simulateIntent } from "./simulation.js";
import type { RiskLimits } from "./risk.js";
import {
  buildAuthorization,
  recoverSigner,
  strategyBody,
  strategyHash,
  typedData,
  normalizeStrategy,
  newIntentId,
  type IntentDomainConfig,
} from "./canonical.js";
import { summarizeIntent } from "./summary.js";
import { formatDecimal, parseDecimal, parsePrice, pnlBps } from "./math.js";
import type {
  ExecutionAdapter,
  MarketSource,
  PriceSource,
} from "./adapters.js";
import { DemoPriceSource, CalendarMarketSource } from "./adapters.js";

/** Optional on-chain mirror (AtlasIntentManager). Failures never block the off-chain lifecycle. */
export interface IntentRegistry {
  activate(auth: unknown, signature: string): Promise<string | null>;
  cancel(intentId: string): Promise<void>;
  markExecuted(intentId: string): Promise<void>;
  markCompleted(intentId: string): Promise<void>;
}

export interface EngineContext {
  repo: IntentRepository;
  now: () => number;
  prices: PriceSource;
  markets: MarketSource;
  portfolio: (user: string) => Promise<PortfolioView>;
  limits: RiskLimits;
  domain: IntentDomainConfig;
  adapter: ExecutionAdapter;
  demoMode: boolean;
  model?: ModelClient;
  registry?: IntentRegistry;
  /** Demo-only controls; undefined outside demo mode. */
  demoPrices?: DemoPriceSource;
  demoMarkets?: CalendarMarketSource;
}

export interface Evaluation {
  intent: AtlasTradeIntent;
  valid: boolean;
  issues: ValidationIssue[];
  strategyHash: string;
  summary: string;
  simulation: IntentSimulation | null;
  risk: RiskMetrics | null;
  blockingRisk: ValidationIssue[];
  price: {
    priceUSDT: string;
    updatedAt: number;
    isStale: boolean;
    source?: string;
  } | null;
  market: {
    open: boolean;
    exchange: string;
    reason: string;
    nextOpen: number | null;
    nextClose: number | null;
  } | null;
  maxSpendUSDT: string | null;
}

const EDITABLE_STATUSES: AtlasIntentStatus[] = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "ACTIVE",
  "WAITING_FOR_ENTRY",
  "PAUSED",
];

export class IntentService {
  constructor(readonly ctx: EngineContext) {}

  private log(id: string, type: string, payload: unknown = {}) {
    this.ctx.repo.addEvent(id, type, payload, this.ctx.now());
  }

  async parse(
    prompt: string,
    user: string,
  ): Promise<ParseOutcome & { evaluation?: Evaluation }> {
    const outcome = await parseIntent(prompt, getAddress(user), {
      now: this.ctx.now,
      model: this.ctx.model,
    });
    if (outcome.status !== "OK") return outcome;
    return { ...outcome, evaluation: await this.evaluate(outcome.intent) };
  }

  /** Validation + risk + simulation, all deterministic. Safe to call repeatedly. */
  async evaluate(input: AtlasTradeIntent): Promise<Evaluation> {
    const now = this.ctx.now();
    const body = normalizeStrategy(strategyBody(input));
    const intent: AtlasTradeIntent = { ...input, ...body };
    const hash = strategyHash(body);
    const [price, portfolio] = await Promise.all([
      this.ctx.prices.quote(intent.asset.stockId, now),
      this.ctx.portfolio(intent.userAddress),
    ]);
    const market = this.ctx.markets.state(intent.asset.market, now);
    const v = validateIntent(intent, { now, price, market });
    const base = {
      intent,
      strategyHash: hash,
      summary: v.valid ? summarizeIntent(intent) : "",
      price: price
        ? {
            priceUSDT: price.priceUSDT,
            updatedAt: price.updatedAt,
            isStale: price.isStale,
            source: price.source,
          }
        : null,
      market: {
        open: market.open,
        exchange: market.exchange,
        reason: market.reason,
        nextOpen: market.nextOpen,
        nextClose: market.nextClose,
      },
    };
    if (!v.valid || !price)
      return {
        ...base,
        valid: false,
        issues: v.issues,
        simulation: null,
        risk: null,
        blockingRisk: [],
        maxSpendUSDT: null,
      };
    const { simulation, risk } = simulateIntent({
      intent,
      now,
      price,
      market,
      portfolio,
      limits: this.ctx.limits,
    });
    const blocking = [...risk.violations];
    if (portfolio.activeIntents >= this.ctx.limits.maxActiveIntents)
      blocking.push({
        code: "MAX_ACTIVE_INTENTS",
        message: `You can have at most ${this.ctx.limits.maxActiveIntents} active strategies.`,
      });
    if (price.isStale)
      blocking.push({
        code: "PRICE_STALE",
        message: "The latest price is stale; try again shortly.",
      });
    return {
      ...base,
      valid: blocking.length === 0,
      issues: v.issues,
      simulation,
      risk: risk.metrics,
      blockingRisk: blocking,
      maxSpendUSDT: formatDecimal(risk.notional, 6),
    };
  }

  /** Persist an AWAITING_APPROVAL strategy and return the EIP-712 payload. Nothing is active yet. */
  async create(
    raw: AtlasTradeIntent,
    user: string,
    opts: { parseHash?: string } = {},
  ) {
    const now = this.ctx.now();
    const userAddress = getAddress(user);
    if (!this.ctx.demoMode && this.ctx.adapter.kind !== "ONCHAIN")
      throw new IntentError(
        "UNSUPPORTED_INTENT",
        "Live execution is not available yet. Enable INTENT_DEMO_MODE to run simulated strategies.",
        501,
      );
    // The server, not the client, owns identity, time and id.
    const intent: AtlasTradeIntent = {
      ...raw,
      ...normalizeStrategy(strategyBody(raw)),
      id: newIntentId(),
      userAddress,
      metadata: { ...raw.metadata, createdAt: now },
    };
    const ev = await this.evaluate(intent);
    if (ev.issues.length)
      throw new IntentError(
        "INVALID_INTENT",
        "This strategy is not valid.",
        422,
        ev.issues,
      );
    if (ev.blockingRisk.length) {
      const code = ev.blockingRisk.some(
        (b) => b.code === "INSUFFICIENT_BALANCE",
      )
        ? "INSUFFICIENT_BALANCE"
        : ev.blockingRisk.some((b) => b.code === "PRICE_STALE")
          ? "PRICE_STALE"
          : "RISK_REJECTED";
      throw new IntentError(
        code,
        "This strategy was rejected by Atlas risk controls.",
        422,
        ev.blockingRisk,
      );
    }
    const maxSpend = parseDecimal(ev.maxSpendUSDT!, 6);
    const nonce = this.ctx.repo.nextNonce(userAddress);
    const message = buildAuthorization(intent, {
      maxSpendUSDT: maxSpend,
      nonce,
      now,
    });
    this.ctx.repo.tx(() => {
      this.ctx.repo.insertIntent({
        intent,
        hash: ev.strategyHash,
        status: "AWAITING_APPROVAL",
        nonce,
        maxSpend: maxSpend.toString(),
        now,
        demo: this.ctx.demoMode,
      });
      this.log(intent.id, "PROMPT_RECEIVED", {
        prompt: intent.metadata.originalPrompt,
        parser: intent.metadata.parser,
      });
      this.log(intent.id, "INTENT_PARSED", {
        strategyHash: ev.strategyHash,
        defaultsApplied: intent.metadata.defaultsApplied,
      });
      if (opts.parseHash && opts.parseHash !== ev.strategyHash)
        this.log(intent.id, "MANUAL_EDIT", {
          parsedHash: opts.parseHash,
          editedHash: ev.strategyHash,
        });
      this.log(intent.id, "VALIDATION_RESULT", { valid: true });
      this.log(intent.id, "RISK_CHECKED", {
        metrics: ev.risk,
        warnings: ev.simulation?.warnings,
      });
      this.log(intent.id, "SIMULATION_COMPLETE", { simulation: ev.simulation });
    });
    return {
      id: intent.id,
      status: "AWAITING_APPROVAL" as const,
      evaluation: ev,
      authorization: message,
      typedData: typedData(message, this.ctx.domain),
      demoSignatureAllowed: this.ctx.demoMode,
    };
  }

  private owned(id: string, user: string): IntentRow {
    const row = this.ctx.repo.get(id);
    if (!row || row.user_address !== user.toLowerCase())
      throw new IntentError("NOT_FOUND", "Strategy not found.", 404);
    return row;
  }

  /** Verify the EIP-712 signature against the stored, server-built message and activate. */
  async activate(
    id: string,
    user: string,
    signature: string,
    walletIsDemo: boolean,
  ) {
    const row = this.owned(id, user);
    const now = this.ctx.now();
    if (row.status !== "AWAITING_APPROVAL")
      throw new IntentError(
        "CONFLICT",
        `Strategy is ${row.status}; it cannot be activated.`,
        409,
      );
    const intent = JSON.parse(row.normalized_intent_json) as AtlasTradeIntent;
    if (row.valid_until && now > row.valid_until) {
      this.ctx.repo.transition(id, ["AWAITING_APPROVAL"], "EXPIRED", now);
      this.log(id, "EXPIRED", {});
      throw new IntentError(
        "INTENT_EXPIRED",
        "This strategy expired before it was signed.",
        410,
      );
    }
    const message = buildAuthorization(intent, {
      maxSpendUSDT: BigInt(row.max_spend_usdt),
      nonce: row.nonce,
      now: row.created_at,
    });
    if (message.strategyHash !== row.strategy_hash)
      throw new IntentError(
        "INVALID_INTENT",
        "Stored strategy no longer matches its hash.",
        500,
      );
    let signatureType = "EIP712";
    if (signature === "DEMO") {
      if (
        !this.ctx.demoMode ||
        !walletIsDemo ||
        process.env.NODE_ENV === "production"
      )
        throw new IntentError(
          "USER_REJECTED_SIGNATURE",
          "Demo signatures are not accepted here.",
          403,
        );
      signatureType = "DEMO";
    } else {
      let signer: string;
      try {
        signer = recoverSigner(message, signature, this.ctx.domain);
      } catch {
        throw new IntentError(
          "USER_REJECTED_SIGNATURE",
          "The signature could not be verified.",
          401,
        );
      }
      if (signer.toLowerCase() !== row.user_address)
        throw new IntentError(
          "USER_REJECTED_SIGNATURE",
          "The signature was not made by your wallet.",
          401,
        );
    }
    // Re-run deterministic checks: prices, balances and limits may have changed since the preview.
    const ev = await this.evaluate({ ...intent });
    if (ev.issues.length || ev.blockingRisk.length) {
      this.log(id, "ACTIVATION_REJECTED", {
        issues: ev.issues,
        risk: ev.blockingRisk,
      });
      throw new IntentError(
        "RISK_REJECTED",
        "Conditions changed; this strategy no longer passes Atlas checks.",
        422,
        [...ev.issues, ...ev.blockingRisk],
      );
    }
    const ok = this.ctx.repo.tx(() => {
      const moved = this.ctx.repo.transition(
        id,
        ["AWAITING_APPROVAL"],
        "ACTIVE",
        now,
        { signature, signature_type: signatureType },
      );
      if (moved) {
        this.log(id, "USER_SIGNED", {
          signatureType,
          signer: row.user_address,
        });
        this.log(id, "STRATEGY_ACTIVATED", {
          demo: this.ctx.demoMode,
          execution: this.ctx.adapter.kind,
        });
        this.ctx.repo.notify(
          row.user_address,
          id,
          "STRATEGY_ACTIVATED",
          `${intent.asset.symbol} strategy activated.`,
          now,
        );
      }
      return moved;
    });
    if (!ok)
      throw new IntentError(
        "CONFLICT",
        "Strategy state changed; reload and retry.",
        409,
      );
    if (this.ctx.registry && signatureType === "EIP712")
      this.ctx.registry.activate(message, signature).then(
        (tx) =>
          tx &&
          this.ctx.repo.db
            .prepare("UPDATE trade_intents SET onchain_tx=? WHERE id=?")
            .run(tx, id),
        (e) =>
          this.log(id, "ONCHAIN_ACTIVATION_FAILED", {
            error: String(e?.message ?? e).slice(0, 200),
          }),
      );
    return this.view(this.ctx.repo.get(id)!);
  }

  /** Cancel before any execution has begun. After that, use closePosition. */
  async cancel(id: string, user: string) {
    const row = this.owned(id, user);
    const now = this.ctx.now();
    if (!EDITABLE_STATUSES.includes(row.status))
      throw new IntentError(
        "CONFLICT",
        row.status === "POSITION_OPEN" ||
          row.status === "MONITORING" ||
          row.status === "EXECUTING" ||
          row.status === "EXIT_TRIGGERED"
          ? "Execution has started. Close the position instead of cancelling."
          : `Strategy is already ${row.status}.`,
        409,
      );
    const ok = this.ctx.repo.tx(() => {
      const moved = this.ctx.repo.transition(
        id,
        EDITABLE_STATUSES,
        "CANCELLED",
        now,
      );
      if (moved) {
        this.log(id, "CANCELLED", {});
        this.ctx.repo.notify(
          row.user_address,
          id,
          "CANCELLED",
          "Strategy cancelled.",
          now,
        );
      }
      return moved;
    });
    // CAS lost: a worker moved it to EXECUTING in the meantime.
    if (!ok)
      throw new IntentError(
        "CONFLICT",
        "Execution has just started; it can no longer be cancelled.",
        409,
      );
    this.ctx.registry?.cancel(id).catch(() => undefined);
    return this.view(this.ctx.repo.get(id)!);
  }

  /** Manual close: highest-priority exit, handled by the worker with the same idempotent path. */
  async closePosition(id: string, user: string) {
    const row = this.owned(id, user);
    if (row.status !== "POSITION_OPEN" && row.status !== "MONITORING")
      throw new IntentError(
        "CONFLICT",
        "There is no open position to close.",
        409,
      );
    this.ctx.repo.patch(id, this.ctx.now(), { close_requested: 1 });
    this.log(id, "MANUAL_CLOSE_REQUESTED", {});
    return this.view(this.ctx.repo.get(id)!);
  }

  get(id: string, user: string) {
    return this.view(this.owned(id, user));
  }
  events(id: string, user: string) {
    this.owned(id, user);
    return this.ctx.repo.events(id).map((e) => ({
      id: e.id,
      type: e.event_type,
      payload: JSON.parse(e.payload),
      timestamp: e.timestamp,
    }));
  }
  list(user: string) {
    return this.ctx.repo.list(user).map((r) => this.view(r));
  }

  private view(row: IntentRow) {
    const intent = JSON.parse(row.normalized_intent_json) as AtlasTradeIntent;
    const p = this.ctx.repo.position(row.id);
    let position = null;
    if (p) {
      const entry = parsePrice(p.entry_price_usdt),
        cur = parsePrice(p.current_price_usdt);
      position = { ...p, pnlBps: Number(pnlBps(entry, cur)) };
    }
    return {
      id: row.id,
      status: row.status,
      intent,
      strategyHash: row.strategy_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      validUntil: row.valid_until,
      nonce: row.nonce,
      signatureType: row.signature_type,
      maxSpendUSDT: formatDecimal(BigInt(row.max_spend_usdt), 6),
      summary: summarizeIntent(intent),
      position,
      executions: this.ctx.repo.executions(row.id),
      error: row.error_code
        ? { code: row.error_code, message: row.error_message }
        : null,
      blocked: row.last_block,
      closeRequested: row.close_requested === 1,
      demo: row.demo === 1,
      executionMode: row.demo === 1 ? "SIMULATED" : this.ctx.adapter.kind,
      onchainTx: row.onchain_tx,
    };
  }

  notifications(user: string, markRead = false) {
    const rows = this.ctx.repo.notifications(user);
    if (markRead) this.ctx.repo.markNotificationsRead(user);
    return rows;
  }
  newRequestId = () => randomUUID();
}
