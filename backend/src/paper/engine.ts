import type { ExecutionRequest } from "../intent/adapters.js";
import { randomUUID } from "node:crypto";
import { resolveAsset, assets } from "../intent/assets.js";
import {
  evaluateEntryConditions,
  evaluateExitConditions,
} from "../intent/conditions.js";
import {
  ceilDiv,
  formatPrice,
  formatQty,
  formatUSDT,
  parsePrice,
  parseDecimal,
  parseUSDT,
  valueOf,
} from "../intent/math.js";
import { IntentError, type MarketState } from "../intent/types.js";
import {
  configSchema,
  PaperMarket,
  PaperExecutionAdapter,
  type SimulationConfig,
} from "./market.js";
import { wallTime, paperDraftSchema, type PaperDraft } from "./parser.js";
import {
  evaluateRule,
  marketplaceSchema,
  type MarketplaceSpec,
} from "./strategy.js";

export type PaperOrder = {
  id: string;
  status:
    | "PREVIEW"
    | "ACTIVE"
    | "OPEN"
    | "COMPLETED"
    | "EXPIRED"
    | "CANCELLED"
    | "FAILED";
  draft: PaperDraft;
  simulationDate: string;
  entryAt: number;
  expiryAt: number;
  confirmedAt: number | null;
  quantity: string;
  entryFill: string | null;
  exitFill: string | null;
  entryFee: string;
  exitFee: string;
  reason: string;
  pnl: string;
  events: { timestamp: number; reason: string }[];
  sourceStrategy?: string;
  rule?: MarketplaceSpec["rules"][number];
};
export class PaperEngine {
  config: SimulationConfig;
  market: PaperMarket;
  adapter: PaperExecutionAdapter;
  now: number;
  tick = 0;
  paused = true;
  speed = 60;
  cash: bigint;
  readonly orders: PaperOrder[] = [];
  readonly fills: {
    orderId: string;
    side: "BUY" | "SELL";
    timestamp: number;
    price: string;
    quantity: string;
    fee: string;
    reason: string;
  }[] = [];
  private tokens = new Map<string, string>();
  private consumed = new Set<string>();
  private accumulator = 0;
  constructor(input: unknown = {}) {
    this.config = configSchema.parse(input);
    this.now = this.config.startTime;
    this.cash = parseUSDT(this.config.initialBalance);
    this.market = new PaperMarket(this.config);
    this.adapter = new PaperExecutionAdapter(this.market);
  }
  reset(input: unknown) {
    const next = new PaperEngine(input);
    Object.assign(this, next);
    return this.snapshot();
  }
  private note(o: PaperOrder, reason: string) {
    o.reason = reason;
    if (o.events.at(-1)?.reason !== reason)
      o.events.push({ timestamp: this.now, reason });
  }
  preview(
    draft: PaperDraft,
    date: string,
    sourceStrategy?: string,
    rule?: PaperOrder["rule"],
  ) {
    draft = paperDraftSchema.parse(draft);
    if (!resolveAsset(draft.symbol)?.active)
      throw new IntentError(
        "INVALID_INTENT",
        "Choose an active Atlas instrument.",
        422,
      );
    let entryAt: number, expiryAt: number;
    try {
      entryAt = wallTime(date, draft.entryTime, draft.timezone);
      expiryAt = wallTime(date, draft.expiryTime, draft.timezone);
    } catch (e) {
      throw new IntentError("INVALID_INTENT", (e as Error).message, 422);
    }
    if (expiryAt <= entryAt || expiryAt <= this.now)
      throw new IntentError(
        "INVALID_INTENT",
        "Entry expiry must follow entry time and the simulation clock.",
        422,
      );
    if (this.orders.length >= 200)
      throw new IntentError(
        "INVALID_INTENT",
        "Reset the session before adding more than 200 paper intents.",
        422,
      );
    const o: PaperOrder = {
      id: `paper-${this.orders.length + 1}`,
      status: "PREVIEW",
      draft,
      simulationDate: date,
      entryAt,
      expiryAt,
      confirmedAt: null,
      quantity: draft.quantity,
      entryFill: null,
      exitFill: null,
      entryFee: "0",
      exitFee: "0",
      reason: "Awaiting explicit confirmation",
      pnl: "0",
      events: [],
      sourceStrategy,
      rule,
    };
    this.orders.push(o);
    const confirmationToken = randomUUID();
    this.tokens.set(o.id, confirmationToken);
    const a = resolveAsset(draft.symbol)!,
      q = this.market.quoteSync(a.stockId, this.now);
    return {
      order: structuredClone(o),
      confirmationToken,
      estimatedFill: q
        ? formatPrice(
            this.market.executionPrice(parsePrice(q.priceUSDT), "BUY"),
          )
        : null,
      executionMode: "PAPER",
      exitSlippagePolicy:
        "The confirmed slippage cap applies to entry and exit fills.",
    };
  }
  confirm(id: string, token: string) {
    const o = this.get(id);
    if (this.tokens.get(id) !== token || this.consumed.has(token))
      throw new IntentError(
        "FORBIDDEN",
        "This preview confirmation is invalid or already used.",
        403,
      );
    if (o.status !== "PREVIEW" || this.now >= o.expiryAt)
      throw new IntentError(
        "CONFLICT",
        "Preview expired or already activated.",
        409,
      );
    this.consumed.add(token);
    o.confirmedAt = this.now;
    o.status = "ACTIVE";
    this.note(o, "User confirmed paper strategy");
    return this.snapshot();
  }
  get(id: string) {
    const o = this.orders.find((o) => o.id === id);
    if (!o)
      throw new IntentError("NOT_FOUND", "Paper strategy not found.", 404);
    return o;
  }
  cancel(id: string) {
    const o = this.get(id);
    if (o.status === "OPEN")
      throw new IntentError(
        "CONFLICT",
        "Open positions must exit through their confirmed rules; reset discards the paper session.",
        409,
      );
    if (o.status === "ACTIVE" || o.status === "PREVIEW") {
      o.status = "CANCELLED";
      this.note(o, "User cancelled entry");
    }
    return this.snapshot();
  }
  control(action: "pause" | "resume" | "speed", speed?: number) {
    if (action === "pause") this.paused = true;
    else if (action === "resume") this.paused = false;
    else {
      if (!Number.isFinite(speed) || speed! < 1 || speed! > 600)
        throw new IntentError(
          "INVALID_INTENT",
          "Speed must be 1–600 simulated seconds per real second.",
          422,
        );
      this.speed = speed!;
    }
    return this.snapshot();
  }
  pump() {
    if (this.paused) return;
    this.accumulator += this.speed / 4;
    let n = 0;
    while (this.accumulator >= this.config.stepSeconds && n++ < 60) {
      this.accumulator -= this.config.stepSeconds;
      this.step(1);
    }
  }
  step(count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 3600)
      throw new IntentError(
        "INVALID_INTENT",
        "Step count must be 1–3600.",
        422,
      );
    for (let i = 0; i < count; i++) {
      const target = this.now + this.config.stepSeconds;
      if (this.config.mode === "replay") {
        while (this.now < target) {
          let next = this.market.nextEvent(this.now, target);
          for (const o of this.orders)
            if (o.status === "ACTIVE")
              for (const t of [o.entryAt, o.expiryAt])
                if (t > this.now && t < next) next = t;
          this.now = next;
          this.market.advance(this.now, ++this.tick);
          this.evaluate();
        }
      } else {
        this.now = target;
        this.market.advance(this.now, ++this.tick);
        this.evaluate();
      }
    }
    return this.snapshot();
  }
  private evaluate() {
    for (const o of this.orders) {
      if (o.status !== "ACTIVE" && o.status !== "OPEN") continue;
      if (o.status === "ACTIVE" && this.now >= o.expiryAt) {
        o.status = "EXPIRED";
        this.note(o, "Entry expired without a fill");
        continue;
      }
      const a = resolveAsset(o.draft.symbol)!,
        q = this.market.quoteSync(a.stockId, this.now);
      if (!q || q.isStale) {
        this.note(o, "Waiting for an available, current simulated quote");
        continue;
      }
      const last = parsePrice(q.priceUSDT),
        side = o.status === "ACTIVE" ? "BUY" : "SELL";
      let reason = "";
      if (side === "BUY") {
        const market: MarketState = {
          open: true,
          nextOpen: null,
          nextClose: null,
          reason: "OPEN",
          timezone: o.draft.timezone,
          exchange: a.exchange,
        };
        const entry = evaluateEntryConditions(
          {
            entryConditions: [{ type: "AT_TIME", timestamp: o.entryAt }],
            constraints: { validUntil: o.expiryAt },
          },
          market,
          last,
          this.now,
        );
        if (!entry.satisfied) {
          this.note(o, entry.reasons.join("; "));
          continue;
        }
        if (
          o.rule &&
          !evaluateRule(
            o.rule.when,
            this.market.history.filter((t) => t.symbol === a.symbol),
            this.now,
          )
        ) {
          this.note(o, "Waiting for marketplace rule");
          continue;
        }
        reason = o.rule
          ? `Marketplace ${o.rule.when.indicator} entry`
          : "Scheduled entry time reached";
      } else {
        const exit = evaluateExitConditions(
          [
            { type: "TAKE_PROFIT_BPS", value: o.draft.takeProfitBps },
            { type: "STOP_LOSS_BPS", value: o.draft.stopLossBps },
          ],
          parsePrice(o.entryFill!),
          last,
          this.now,
        );
        if (!exit.satisfied) {
          this.note(o, "Monitoring confirmed take-profit and stop-loss");
          continue;
        }
        reason = exit.trigger!;
      }
      // Use the same fill function for preview, guard and execution. Nothing is debited before every guard passes.
      const request: ExecutionRequest = {
        executionId: `${o.id}:${side}`,
        intentId: o.id,
        kind: side === "BUY" ? "ENTRY" : "EXIT",
        side,
        user: "paper",
        stockId: a.stockId,
        exchange: a.exchange,
        referencePrice: last,
        quantity: parseDecimal(o.quantity, 18),
        now: this.now,
      };
      const f = this.adapter.fill(request);
      const deviation =
        f.fillPrice > last ? f.fillPrice - last : last - f.fillPrice;
      if (deviation * 10000n > last * BigInt(o.draft.maxSlippageBps)) {
        this.note(
          o,
          `SLIPPAGE_TOO_HIGH: estimated ${f.slippageBps} bps exceeds confirmed ${o.draft.maxSlippageBps} bps`,
        );
        continue;
      }
      if (side === "BUY" && f.notionalUSDT + f.feeUSDT > this.cash) {
        o.status = "FAILED";
        this.note(o, "INSUFFICIENT_PAPER_BALANCE");
        continue;
      }
      this.adapter.executeSync(request);
      if (side === "BUY") {
        this.cash -= f.notionalUSDT + f.feeUSDT;
        o.entryFill = formatPrice(f.fillPrice);
        o.entryFee = formatUSDT(f.feeUSDT);
        o.status = "OPEN";
      } else {
        this.cash += f.notionalUSDT - f.feeUSDT;
        o.exitFill = formatPrice(f.fillPrice);
        o.exitFee = formatUSDT(f.feeUSDT);
        o.status = "COMPLETED";
        o.pnl = formatUSDT(
          f.notionalUSDT -
            f.feeUSDT -
            valueOf(f.quantity, parsePrice(o.entryFill!), true) -
            parseUSDT(o.entryFee),
        );
      }
      this.fills.push({
        orderId: o.id,
        side,
        timestamp: this.now,
        price: formatPrice(f.fillPrice),
        quantity: formatQty(f.quantity),
        fee: formatUSDT(f.feeUSDT),
        reason,
      });
      this.note(o, reason);
    }
  }
  importStrategy(
    input: unknown,
    date: string,
    timezone: string,
    entryTime: string,
    expiryTime: string,
  ) {
    const spec = marketplaceSchema.parse(input);
    const previews = [];
    for (const asset of spec.universe) {
      const rule = spec.rules.find(
        (r) => r.appliesTo === "each_asset" || r.appliesTo === asset.symbol,
      );
      const q = this.market.latest.get(asset.symbol);
      if (!q)
        throw new IntentError(
          "INVALID_INTENT",
          `No current simulation price for ${asset.symbol}.`,
          422,
        );
      const budget =
        (this.cash *
          BigInt(Math.round(asset.weight * 100)) *
          BigInt(Math.round((100 - spec.risk.cashBufferPct) * 100)) *
          BigInt(Math.round((rule?.then.sizePct ?? 100) * 100))) /
        10000n /
        10000n /
        10000n;
      const quantity =
        ((budget * 10n ** 20n) / parsePrice(q.price) / 10000000000n) *
        10000000000n;
      if (!quantity)
        throw new IntentError(
          "INVALID_INTENT",
          "Strategy allocation rounds to zero.",
          422,
        );
      previews.push(
        this.preview(
          {
            symbol: asset.symbol,
            quantity: formatQty(quantity),
            entryTime,
            expiryTime,
            timezone,
            maxSlippageBps: spec.execution.maxSlippageBps,
            takeProfitBps: Math.round(spec.risk.takeProfitPct * 100),
            stopLossBps: Math.round(spec.risk.stopLossPct * 100),
          },
          date,
          "Imported marketplace strategy",
          rule,
        ),
      );
    }
    return {
      previews,
      notes:
        "Long-only, one entry and bracket exit per asset. Initial allocation uses current paper cash and target weights. No creator fee, live deployment or rebalancing.",
    };
  }
  snapshot() {
    let value = 0n;
    const positions = this.orders
      .filter((o) => o.status === "OPEN")
      .map((o) => {
        const q = this.market.latest.get(o.draft.symbol);
        const mark = q
          ? valueOf(parseDecimal(o.quantity, 18), parsePrice(q.price))
          : 0n;
        value += mark;
        return {
          orderId: o.id,
          symbol: o.draft.symbol,
          quantity: o.quantity,
          entryFill: o.entryFill,
          mark: q?.price ?? null,
          unrealizedPnl: formatUSDT(
            mark -
              valueOf(
                parseDecimal(o.quantity, 18),
                parsePrice(o.entryFill!),
                true,
              ) -
              parseUSDT(o.entryFee),
          ),
        };
      });
    return {
      mode: "Paper Trading",
      config:
        this.config.mode === "replay"
          ? { ...this.config, replay: undefined }
          : this.config,
      source:
        this.config.mode === "synthetic"
          ? `Seeded synthetic (${this.config.seed})`
          : this.config.replay!.source,
      simulatedTimestamp: this.now,
      paused: this.paused,
      speed: this.speed,
      tick: this.tick,
      cash: formatUSDT(this.cash),
      equity: formatUSDT(this.cash + value),
      pnl: formatUSDT(
        this.cash + value - parseUSDT(this.config.initialBalance),
      ),
      orders: structuredClone(this.orders),
      fills: [...this.fills],
      positions,
      quotes: assets.flatMap((a) => {
        const q = this.market.quoteSync(a.stockId, this.now);
        if (!q) return [];
        const p = parsePrice(q.priceUSDT),
          half = ceilDiv(
            p * BigInt(Math.ceil(this.config.spreadBps / 2)),
            10000n,
          );
        return [
          {
            symbol: a.symbol,
            last: q.priceUSDT,
            bid: formatPrice(p - half),
            ask: formatPrice(p + half),
            timestamp: q.updatedAt,
            stale: q.isStale,
          },
        ];
      }),
      history: this.market.history.slice(-1000),
      replayPolicy:
        this.config.mode === "replay" && this.config.replay!.candles.length
          ? "Assumed intrabar path: open → low → high → close. Not observed ticks."
          : null,
    };
  }
}
