import { z } from "zod";
import catalog from "../protocol/catalog.json" with { type: "json" };
import { assets, assetByStockId } from "../intent/assets.js";
import type {
  PriceSource,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "../intent/adapters.js";
import { formatPrice, parsePrice, ceilDiv, valueOf } from "../intent/math.js";
import { IntentError } from "../intent/types.js";

const price = z
  .string()
  .regex(/^\d+(\.\d{1,8})?$/)
  .refine((v) => parsePrice(v) > 0n && parsePrice(v) < 10n ** 20n);
const symbol = z.string().refine((s) => assets.some((a) => a.symbol === s));
const timestamp = z.number().int().min(1000000000).max(4102444800);
export const replaySchema = z
  .object({
    source: z.string().min(1).max(120),
    currency: z.literal("USDT"),
    ticks: z
      .array(z.object({ symbol, timestamp, price }).strict())
      .max(20000)
      .default([]),
    candles: z
      .array(
        z
          .object({
            symbol,
            timestamp,
            durationSeconds: z.number().int().min(3).max(86400),
            open: price,
            high: price,
            low: price,
            close: price,
          })
          .strict(),
      )
      .max(5000)
      .default([]),
  })
  .strict()
  .superRefine((r, c) => {
    if (!r.ticks.length === !r.candles.length)
      c.addIssue({
        code: "custom",
        message: "Supply either ticks or candles, not both.",
      });
    for (const b of r.candles)
      if (
        parsePrice(b.low) > parsePrice(b.high) ||
        parsePrice(b.open) < parsePrice(b.low) ||
        parsePrice(b.open) > parsePrice(b.high) ||
        parsePrice(b.close) < parsePrice(b.low) ||
        parsePrice(b.close) > parsePrice(b.high)
      )
        c.addIssue({ code: "custom", message: "Invalid OHLC range." });
  });
export const configSchema = z
  .object({
    mode: z.enum(["synthetic", "replay"]).default("synthetic"),
    seed: z.number().int().min(0).max(4294967295).default(42),
    startTime: timestamp.default(1793892540), // 2026-11-05 10:29 America/New_York
    stepSeconds: z.number().int().min(1).max(300).default(10),
    spreadBps: z.number().int().min(0).max(1000).default(4),
    slippageBps: z.number().int().min(0).max(2000).default(5),
    feeBps: z.number().int().min(0).max(100).default(10),
    initialBalance: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/)
      .default("25000")
      .refine((v) => Number(v) > 0 && Number(v) <= 1e9),
    maxQuoteAgeSeconds: z.number().int().min(1).max(86400).default(300),
    volatilityBps: z.number().int().min(0).max(500).default(8),
    driftBps: z.number().int().min(-500).max(500).default(0),
    regimes: z
      .array(
        z
          .object({
            fromTick: z.number().int().min(1),
            untilTick: z.number().int().min(1),
            driftBps: z.number().int().min(-500).max(500),
            volatilityBps: z.number().int().min(0).max(500),
          })
          .strict()
          .refine((r) => r.fromTick <= r.untilTick),
      )
      .max(20)
      .default([]),
    shocks: z
      .array(
        z
          .object({
            tick: z.number().int().min(1),
            symbol: symbol.optional(),
            changeBps: z.number().int().min(-9000).max(10000),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    replay: replaySchema.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.mode === "replay" && !v.replay)
      c.addIssue({ code: "custom", message: "Replay data is required." });
  });
export type SimulationConfig = z.infer<typeof configSchema>;
export type Tick = { symbol: string; timestamp: number; price: string };
function hash(seed: number, text: string) {
  let h = seed >>> 0;
  for (const c of text) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return h >>> 0;
}
export function replayTicks(input: z.infer<typeof replaySchema>): Tick[] {
  const ticks = input.ticks.length
    ? [...input.ticks]
    : input.candles.flatMap((b) => [
        { symbol: b.symbol, timestamp: b.timestamp, price: b.open },
        {
          symbol: b.symbol,
          timestamp: b.timestamp + Math.floor(b.durationSeconds / 3),
          price: b.low,
        },
        {
          symbol: b.symbol,
          timestamp: b.timestamp + Math.floor((b.durationSeconds * 2) / 3),
          price: b.high,
        },
        {
          symbol: b.symbol,
          timestamp: b.timestamp + b.durationSeconds,
          price: b.close,
        },
      ]);
  ticks.sort(
    (a, b) => a.timestamp - b.timestamp || a.symbol.localeCompare(b.symbol),
  );
  const seen = new Set<string>();
  for (const t of ticks) {
    const key = t.symbol + ":" + t.timestamp;
    if (seen.has(key))
      throw new IntentError(
        "INVALID_INTENT",
        "Overlapping or duplicate replay timestamps for a symbol.",
        422,
      );
    seen.add(key);
  }
  return ticks;
}
/** Implements the existing intent pricing interface; no feed, RPC or wall clock. */
export class PaperMarket implements PriceSource {
  readonly latest = new Map<string, Tick>();
  readonly history: Tick[] = [];
  private events: Tick[];
  private cursor = 0;
  constructor(readonly config: SimulationConfig) {
    this.events = config.mode === "replay" ? replayTicks(config.replay!) : [];
    if (config.mode === "synthetic")
      for (const s of catalog.stocks) {
        const px =
          (parsePrice(s.demoNativePrice) *
            parsePrice(
              (catalog.fx as Record<string, string>)[s.nativeCurrency]!,
            )) /
          10n ** 8n;
        this.record({
          symbol: s.ticker,
          timestamp: config.startTime,
          price: formatPrice(px),
        });
      }
    else this.advance(config.startTime, 0);
  }
  private record(t: Tick) {
    this.latest.set(t.symbol, t);
    this.history.push(t);
  }
  advance(now: number, tick: number) {
    if (this.config.mode === "replay") {
      while (
        this.cursor < this.events.length &&
        this.events[this.cursor]!.timestamp <= now
      )
        this.record(this.events[this.cursor++]!);
      if (this.history.length > 50000)
        this.history.splice(0, this.history.length - 50000);
      return;
    }
    const c = this.config,
      r = c.regimes.find((r) => tick >= r.fromTick && tick <= r.untilTick);
    for (const a of assets) {
      const old = this.latest.get(a.symbol)!;
      const noise = (hash(c.seed, `${a.symbol}:${tick}`) % 20001) - 10000;
      let change =
        (r?.driftBps ?? c.driftBps) +
        Math.trunc((noise * (r?.volatilityBps ?? c.volatilityBps)) / 10000);
      for (const s of c.shocks)
        if (s.tick === tick && (!s.symbol || s.symbol === a.symbol))
          change += s.changeBps;
      const px =
        (parsePrice(old.price) * BigInt(Math.max(1, 10000 + change))) / 10000n;
      this.record({
        symbol: a.symbol,
        timestamp: now,
        price: formatPrice(px > 0n ? px : 1n),
      });
    }
    if (this.history.length > 50000)
      this.history.splice(0, this.history.length - 50000);
  }
  nextEvent(after: number, before: number) {
    const t = this.events[this.cursor]?.timestamp;
    return t !== undefined && t > after && t <= before ? t : before;
  }
  async quote(stockId: string, now: number) {
    return this.quoteSync(stockId, now);
  }
  quoteSync(stockId: string, now: number) {
    const a = assetByStockId(stockId),
      t = a && this.latest.get(a.symbol);
    if (!a || !t || t.timestamp > now) return null;
    return {
      stockId: a.stockId,
      nativePrice: "",
      nativeCurrency: a.currency,
      priceUSDT: t.price,
      updatedAt: t.timestamp,
      isStale: now - t.timestamp > this.config.maxQuoteAgeSeconds,
      source:
        this.config.mode === "replay"
          ? this.config.replay!.source
          : `Seeded synthetic / ${this.config.seed}`,
    };
  }
  executionPrice(last: bigint, side: "BUY" | "SELL") {
    const half = BigInt(Math.ceil(this.config.spreadBps / 2));
    const spread = ceilDiv(last * half, 10000n);
    const touch = side === "BUY" ? last + spread : last - spread;
    const impact = ceilDiv(touch * BigInt(this.config.slippageBps), 10000n);
    return side === "BUY" ? touch + impact : touch - impact;
  }
}
/** Implements ExecutionAdapter, but can only return paper fills. No signing or chain dependencies. */
export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly kind = "SIMULATED" as const;
  private executions = new Map<string, ExecutionResult>();
  constructor(private market: PaperMarket) {}
  fill(r: ExecutionRequest): ExecutionResult {
    if (!r.quantity || r.quantity <= 0n)
      throw new IntentError(
        "INVALID_INTENT",
        "Paper orders require a positive exact share quantity.",
        422,
      );
    const fillPrice = this.market.executionPrice(r.referencePrice, r.side);
    const notionalUSDT = valueOf(r.quantity, fillPrice, r.side === "BUY");
    const delta =
      fillPrice >= r.referencePrice
        ? fillPrice - r.referencePrice
        : r.referencePrice - fillPrice;
    return {
      txHash: null,
      fillPrice,
      quantity: r.quantity,
      notionalUSDT,
      feeUSDT: ceilDiv(
        notionalUSDT * BigInt(this.market.config.feeBps),
        10000n,
      ),
      slippageBps: Number(ceilDiv(delta * 10000n, r.referencePrice)),
    };
  }
  executeSync(r: ExecutionRequest) {
    const prior = this.executions.get(r.executionId);
    if (prior) return prior;
    const result = this.fill(r);
    this.executions.set(r.executionId, result);
    return result;
  }
  async execute(r: ExecutionRequest) {
    return this.executeSync(r);
  }
}
