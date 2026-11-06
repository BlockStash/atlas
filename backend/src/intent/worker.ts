import { randomUUID } from "node:crypto";
import { IntentError, type AtlasTradeIntent } from "./types.js";
import type { IntentRow, PositionRow, ExecutionRow } from "./repository.js";
import type { EngineContext } from "./service.js";
import {
  evaluateEntryConditions,
  evaluateExitConditions,
} from "./conditions.js";
import { simulateIntent } from "./simulation.js";
import { calculateSlippage } from "./slippage.js";
import { formatPrice, parsePrice, quantityFor, formatDecimal } from "./math.js";
import { resolveNotional } from "./risk.js";

const MAX_RETRIES = 5;
const backoff = (n: number) => Math.min(15 * 2 ** n, 300);

/**
 * Database-backed execution loop. Safe to run in several processes:
 *  - a lease serializes work per intent,
 *  - every state change is a compare-and-set on `status`,
 *  - each trade has a unique execution id (`<intent>:ENTRY|EXIT`) enforced by a UNIQUE constraint,
 *    and the adapter returns the prior fill instead of trading twice.
 */
export class ExecutionWorker {
  private running = false;
  readonly id = randomUUID().slice(0, 8);
  constructor(private ctx: EngineContext) {}

  start(intervalMs = 5000) {
    const t = setInterval(
      () => void this.tick().catch(() => undefined),
      intervalMs,
    );
    t.unref();
    return () => clearInterval(t);
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      const now = this.ctx.now();
      for (const row of this.ctx.repo.workable(now)) {
        if (!this.ctx.repo.lease(row.id, now)) continue; // another worker owns it
        try {
          await this.process(this.ctx.repo.get(row.id)!);
          n++;
        } catch (e) {
          this.fail(row.id, e);
        } finally {
          this.ctx.repo.release(row.id);
        }
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  private log(id: string, type: string, payload: unknown = {}) {
    this.ctx.repo.addEvent(id, type, payload, this.ctx.now());
  }
  private notify(row: IntentRow, kind: string, msg: string) {
    this.ctx.repo.notify(row.user_address, row.id, kind, msg, this.ctx.now());
  }

  /** Bounded retries for transient errors; terminal state for everything else. */
  private fail(id: string, e: unknown) {
    const row = this.ctx.repo.get(id);
    if (!row) return;
    const now = this.ctx.now();
    const err =
      e instanceof IntentError
        ? e
        : new IntentError(
            "RPC_ERROR",
            String((e as Error)?.message ?? e),
            500,
            undefined,
            true,
          );
    const exiting = row.status === "EXIT_TRIGGERED";
    if (err.retryable) {
      const n = row.retry_count + 1;
      if (n >= MAX_RETRIES && !exiting) {
        this.finalFail(row, err);
        return;
      }
      // An open position must keep trying to exit; only the backoff grows.
      this.ctx.repo.patch(id, now, {
        retry_count: n,
        next_attempt_at: now + backoff(n),
        error_code: err.code,
        error_message: err.message,
      });
      this.log(id, "EXECUTION_RETRY", {
        attempt: n,
        code: err.code,
        message: err.message,
      });
      if (exiting && n === MAX_RETRIES)
        this.notify(
          row,
          "EXECUTION_FAILED",
          `Exit for ${this.sym(row)} keeps failing; the position is still open. You can close it manually.`,
        );
      return;
    }
    if (exiting) {
      this.ctx.repo.patch(id, now, {
        next_attempt_at: now + 600,
        error_code: "EXIT_EXECUTION_FAILED",
        error_message: err.message,
      });
      this.log(id, "EXIT_EXECUTION_FAILED", {
        code: err.code,
        message: err.message,
      });
      return;
    }
    this.finalFail(row, err);
  }
  private finalFail(row: IntentRow, err: IntentError) {
    const now = this.ctx.now();
    const from = [
      "ACTIVE",
      "WAITING_FOR_ENTRY",
      "EXECUTING",
      "POSITION_OPEN",
      "MONITORING",
    ] as IntentRow["status"][];
    if (
      this.ctx.repo.transition(row.id, from, "FAILED", now, {
        error_code: err.code,
        error_message: err.message,
      })
    ) {
      this.log(row.id, "EXECUTION_FAILED", {
        code: err.code,
        message: err.message,
      });
      this.notify(
        row,
        "EXECUTION_FAILED",
        `${this.sym(row)} strategy failed: ${err.message}`,
      );
    }
  }
  private sym = (row: IntentRow) =>
    (JSON.parse(row.normalized_intent_json) as AtlasTradeIntent).asset.symbol;

  private block(row: IntentRow, reasons: string[]) {
    const key = reasons.join(" | ").slice(0, 300);
    if (row.last_block !== key) {
      this.ctx.repo.patch(row.id, this.ctx.now(), { last_block: key });
      this.log(row.id, "ENTRY_BLOCKED", { reasons });
    }
  }

  async process(row: IntentRow) {
    const intent = JSON.parse(row.normalized_intent_json) as AtlasTradeIntent;
    const now = this.ctx.now();
    switch (row.status) {
      case "ACTIVE":
      case "WAITING_FOR_ENTRY":
      case "EXECUTING":
        return this.processEntry(row, intent, now);
      case "POSITION_OPEN":
      case "MONITORING":
      case "EXIT_TRIGGERED":
        return this.processPosition(row, intent, now);
    }
  }

  private async processEntry(
    row: IntentRow,
    intent: AtlasTradeIntent,
    now: number,
  ) {
    const resuming = row.status === "EXECUTING";
    if (
      row.status === "ACTIVE" &&
      this.ctx.repo.transition(row.id, ["ACTIVE"], "WAITING_FOR_ENTRY", now)
    )
      this.log(row.id, "WAITING_FOR_ENTRY", {});
    if (!resuming && row.valid_until && now > row.valid_until) {
      if (
        this.ctx.repo.transition(
          row.id,
          ["ACTIVE", "WAITING_FOR_ENTRY"],
          "EXPIRED",
          now,
        )
      ) {
        this.log(row.id, "EXPIRED", {});
        this.notify(
          row,
          "EXPIRED",
          `${intent.asset.symbol} strategy expired without executing.`,
        );
        this.ctx.registry?.cancel(row.id).catch(() => undefined);
      }
      return;
    }
    const quote = await this.ctx.prices.quote(intent.asset.stockId, now);
    if (!quote) return this.block(row, ["No price available (PRICE_STALE)"]);
    if (quote.isStale) return this.block(row, ["Price is stale (PRICE_STALE)"]);
    const px = parsePrice(quote.priceUSDT);
    const market = this.ctx.markets.state(intent.asset.market, now);

    if (!resuming) {
      const ev = evaluateEntryConditions(intent, market, px, now);
      if (!ev.satisfied) {
        this.maybeApproaching(row, intent, px, market.nextOpen, now);
        return this.block(row, ev.reasons);
      }
    }
    // Re-validate risk with fresh data right before acting.
    const portfolio = await this.ctx.portfolio(intent.userAddress);
    const sim = simulateIntent({
      intent,
      now,
      price: quote,
      market,
      portfolio,
      limits: this.ctx.limits,
    });
    const notionalNow = sim.risk.notional;
    const spend =
      notionalNow < BigInt(row.max_spend_usdt)
        ? notionalNow
        : BigInt(row.max_spend_usdt);
    if (!resuming) {
      const fatal = sim.risk.violations.filter(
        (v) => v.code !== "MAX_ACTIVE_INTENTS",
      );
      if (fatal.some((v) => v.code === "INSUFFICIENT_BALANCE"))
        throw new IntentError(
          "INSUFFICIENT_BALANCE",
          "Vault balance is below the strategy's spend.",
          422,
        );
      if (fatal.length)
        throw new IntentError("RISK_REJECTED", fatal[0]!.message, 422, fatal);
      const slip = calculateSlippage(spend, intent.asset.market);
      if (
        intent.constraints.maxSlippageBps !== undefined &&
        slip > intent.constraints.maxSlippageBps
      )
        return this.block(row, [
          `Estimated slippage ${slip} bps exceeds your ${intent.constraints.maxSlippageBps} bps limit (SLIPPAGE_TOO_HIGH)`,
        ]);
    }

    if (intent.side === "SELL")
      return this.armSell(row, intent, px, spend, now);

    // Win the race: exactly one worker (or none, if the user cancelled) moves to EXECUTING.
    if (!resuming) {
      if (
        !this.ctx.repo.transition(
          row.id,
          ["ACTIVE", "WAITING_FOR_ENTRY"],
          "EXECUTING",
          now,
          { last_block: null as unknown as string },
        )
      )
        return;
      this.log(row.id, "ENTRY_CONDITION_MET", { price: quote.priceUSDT });
    }
    this.log(row.id, "TRADE_SUBMITTED", {
      side: "BUY",
      spendUSDT: formatDecimal(spend, 6),
      adapter: this.ctx.adapter.kind,
    });
    const fill = await this.ctx.adapter.execute({
      executionId: `${row.id}:ENTRY`,
      intentId: row.id,
      kind: "ENTRY",
      side: "BUY",
      user: row.user_address,
      stockId: intent.asset.stockId,
      exchange: intent.asset.market,
      referencePrice: px,
      notionalUSDT: spend,
      now,
    });
    if (
      intent.constraints.maxExecutionPriceUSDT &&
      fill.fillPrice > parsePrice(intent.constraints.maxExecutionPriceUSDT)
    )
      throw new IntentError(
        "SLIPPAGE_TOO_HIGH",
        "Fill price exceeded your maximum execution price.",
        422,
      );
    const exec: ExecutionRow = {
      id: `${row.id}:ENTRY`,
      intent_id: row.id,
      kind: "ENTRY",
      side: "BUY",
      user_address: row.user_address,
      stock_id: intent.asset.stockId,
      quantity: fill.quantity.toString(),
      price_usdt: formatPrice(fill.fillPrice),
      notional_usdt: fill.notionalUSDT.toString(),
      slippage_bps: fill.slippageBps,
      fee_usdt: fill.feeUSDT.toString(),
      tx_hash: fill.txHash,
      executed_at: now,
    };
    const position: PositionRow = {
      id: randomUUID(),
      intent_id: row.id,
      user_address: row.user_address,
      stock_id: intent.asset.stockId,
      quantity: fill.quantity.toString(),
      entry_price_usdt: formatPrice(fill.fillPrice),
      current_price_usdt: formatPrice(px),
      status: "OPEN",
      source: "ENTRY_TRADE",
      opened_at: now,
      closed_at: null,
      exit_reason: null,
    };
    if (!this.ctx.repo.recordEntry({ exec, position, now })) return;
    this.log(row.id, "TRADE_CONFIRMED", {
      price: exec.price_usdt,
      quantity: exec.quantity,
      slippageBps: exec.slippage_bps,
      txHash: exec.tx_hash,
    });
    this.log(row.id, "POSITION_OPENED", { entry: exec.price_usdt });
    this.notify(
      row,
      "TRADE_EXECUTED",
      `Bought ${intent.asset.symbol} at $${exec.price_usdt}.`,
    );
    this.notify(
      row,
      "POSITION_OPENED",
      `${intent.asset.symbol} position is open and being monitored.`,
    );
    this.ctx.registry?.markExecuted(row.id).catch(() => undefined);
  }

  /** SELL strategies take a reference price at trigger time and then monitor exits against it. */
  private async armSell(
    row: IntentRow,
    intent: AtlasTradeIntent,
    px: bigint,
    spend: bigint,
    now: number,
  ) {
    const portfolio = await this.ctx.portfolio(intent.userAddress);
    const held =
      portfolio.positions.find(
        (p) => p.stockId.toLowerCase() === intent.asset.stockId.toLowerCase(),
      )?.quantity ?? 0n;
    const wanted = quantityFor(
      spend > 0n ? spend : resolveNotional(intent, portfolio, px),
      px,
    );
    const quantity = wanted < held ? wanted : held;
    if (quantity <= 0n)
      throw new IntentError(
        "INSUFFICIENT_BALANCE",
        `You hold no ${intent.asset.symbol} to sell.`,
        422,
      );
    const direct = intent.exitConditions.length === 0;
    const position: PositionRow = {
      id: randomUUID(),
      intent_id: row.id,
      user_address: row.user_address,
      stock_id: intent.asset.stockId,
      quantity: quantity.toString(),
      entry_price_usdt: formatPrice(px),
      current_price_usdt: formatPrice(px),
      status: "OPEN",
      source: "REFERENCE",
      opened_at: now,
      closed_at: null,
      exit_reason: null,
    };
    if (!this.ctx.repo.armReference(position, now)) return;
    this.log(row.id, "ENTRY_CONDITION_MET", {
      price: formatPrice(px),
      reference: true,
    });
    this.log(row.id, "POSITION_MONITORING", {
      referencePrice: formatPrice(px),
    });
    if (
      direct &&
      this.ctx.repo.transition(row.id, ["MONITORING"], "EXIT_TRIGGERED", now)
    )
      this.log(row.id, "EXIT_CONDITION_MET", { trigger: "ENTRY_RULES" });
  }

  private maybeApproaching(
    row: IntentRow,
    intent: AtlasTradeIntent,
    px: bigint,
    nextOpen: number | null,
    now: number,
  ) {
    const seen = this.ctx.repo
      .events(row.id)
      .some((e) => e.event_type === "ENTRY_APPROACHING");
    if (seen) return;
    let msg: string | null = null;
    for (const c of intent.entryConditions) {
      if (
        (c.type === "PRICE_BELOW" &&
          px > parsePrice(c.priceUSDT) &&
          (px - parsePrice(c.priceUSDT)) * 100n <= px) ||
        (c.type === "PRICE_ABOVE" &&
          px < parsePrice(c.priceUSDT) &&
          (parsePrice(c.priceUSDT) - px) * 100n <= px)
      )
        msg = `${intent.asset.symbol} is within 1% of your entry price.`;
    }
    if (
      !msg &&
      nextOpen !== null &&
      nextOpen - now <= 900 &&
      intent.entryConditions.some((c) => c.type === "MARKET_OPEN")
    )
      msg = `${intent.asset.market} opens in under 15 minutes.`;
    if (msg) {
      this.log(row.id, "ENTRY_APPROACHING", { message: msg });
      this.notify(row, "ENTRY_APPROACHING", msg);
    }
  }

  private async processPosition(
    row: IntentRow,
    intent: AtlasTradeIntent,
    now: number,
  ) {
    const pos = this.ctx.repo.position(row.id);
    if (!pos)
      throw new IntentError(
        "POSITION_MONITOR_ERROR",
        "Position record is missing.",
        500,
      );
    if (
      row.status === "POSITION_OPEN" &&
      this.ctx.repo.transition(row.id, ["POSITION_OPEN"], "MONITORING", now)
    ) {
      this.log(row.id, "POSITION_MONITORING", {});
      row = this.ctx.repo.get(row.id)!;
    }
    const quote = await this.ctx.prices.quote(intent.asset.stockId, now);
    if (!quote || quote.isStale) return; // never exit on a stale price; keep waiting
    const px = parsePrice(quote.priceUSDT);
    if (pos.status === "OPEN")
      this.ctx.repo.updatePositionPrice(row.id, quote.priceUSDT);
    const market = this.ctx.markets.state(intent.asset.market, now);

    let reason: string | null = null;
    if (row.status === "EXIT_TRIGGERED") {
      const last = this.ctx.repo
        .events(row.id)
        .filter((e) => e.event_type === "EXIT_CONDITION_MET")
        .pop();
      reason =
        row.close_requested === 1
          ? "MANUAL_CLOSE"
          : (last && (JSON.parse(last.payload).trigger as string)) ||
            "TRIGGERED";
    }
    if (row.status === "MONITORING") {
      // Priority: manual close > stop loss > take profit > price > time.
      if (row.close_requested === 1) reason = "MANUAL_CLOSE";
      else {
        const ev = evaluateExitConditions(
          intent.exitConditions,
          parsePrice(pos.entry_price_usdt),
          px,
          now,
        );
        if (ev.satisfied) {
          reason = ev.trigger!;
          this.log(row.id, "EXIT_CONDITION_MET", {
            trigger: ev.trigger,
            reasons: ev.reasons,
            pnlBps: Number(ev.pnlBps),
            price: quote.priceUSDT,
          });
          this.notify(
            row,
            ev.trigger === "STOP_LOSS_BPS"
              ? "STOP_LOSS"
              : ev.trigger === "TAKE_PROFIT_BPS"
                ? "TAKE_PROFIT"
                : "EXIT_TRIGGERED",
            ev.trigger === "STOP_LOSS_BPS"
              ? `${intent.asset.symbol} stop loss triggered.`
              : ev.trigger === "TAKE_PROFIT_BPS"
                ? `${intent.asset.symbol} take profit reached.`
                : `${intent.asset.symbol} exit triggered.`,
          );
        }
      }
      if (!reason) return;
      if (
        !this.ctx.repo.transition(row.id, ["MONITORING"], "EXIT_TRIGGERED", now)
      )
        return;
      if (reason === "MANUAL_CLOSE")
        this.log(row.id, "EXIT_CONDITION_MET", {
          trigger: "MANUAL_CLOSE",
          price: quote.priceUSDT,
        });
    }
    if (!reason) return;
    if (!market.open) return; // exits wait for the exchange to open; no failure
    // Sell no more than we actually hold, so two intents on one stock cannot double-sell.
    const portfolio = await this.ctx.portfolio(intent.userAddress);
    const held =
      portfolio.positions.find(
        (p) => p.stockId.toLowerCase() === intent.asset.stockId.toLowerCase(),
      )?.quantity ?? 0n;
    const want = BigInt(pos.quantity);
    const qty = want < held ? want : held;
    if (qty <= 0n)
      throw new IntentError(
        "EXIT_EXECUTION_FAILED",
        "No holdings left to sell.",
        422,
      );
    this.log(row.id, "TRADE_SUBMITTED", {
      side: "SELL",
      quantity: qty.toString(),
      reason,
    });
    const fill = await this.ctx.adapter.execute({
      executionId: `${row.id}:EXIT`,
      intentId: row.id,
      kind: "EXIT",
      side: "SELL",
      user: row.user_address,
      stockId: intent.asset.stockId,
      exchange: intent.asset.market,
      referencePrice: px,
      quantity: qty,
      now,
    });
    const exec: ExecutionRow = {
      id: `${row.id}:EXIT`,
      intent_id: row.id,
      kind: "EXIT",
      side: "SELL",
      user_address: row.user_address,
      stock_id: intent.asset.stockId,
      quantity: fill.quantity.toString(),
      price_usdt: formatPrice(fill.fillPrice),
      notional_usdt: fill.notionalUSDT.toString(),
      slippage_bps: fill.slippageBps,
      fee_usdt: fill.feeUSDT.toString(),
      tx_hash: fill.txHash,
      executed_at: now,
    };
    if (!this.ctx.repo.recordExit({ exec, reason, now })) return;
    this.log(row.id, "TRADE_CONFIRMED", {
      side: "SELL",
      price: exec.price_usdt,
      txHash: exec.tx_hash,
    });
    this.log(row.id, "POSITION_CLOSED", { reason });
    this.notify(
      row,
      "POSITION_CLOSED",
      `${intent.asset.symbol} position closed (${reason}).`,
    );
    this.ctx.registry?.markCompleted(row.id).catch(() => undefined);
  }
}
