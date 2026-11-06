import { z } from "zod";
import { resolveAsset } from "../intent/assets.js";
import type { Tick } from "./market.js";
const condition = z.discriminatedUnion("indicator", [
  z
    .object({
      indicator: z.literal("rsi"),
      period: z.number().int().min(2).max(500),
      op: z.enum(["<", ">"]),
      value: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      indicator: z.literal("sma_cross"),
      fast: z.number().int().min(1).max(499),
      slow: z.number().int().min(2).max(500),
      op: z.enum(["crosses_above", "crosses_below"]),
    })
    .strict()
    .refine((v) => v.fast < v.slow),
  z
    .object({
      indicator: z.literal("drawdown"),
      lookbackDays: z.number().int().min(1).max(365),
      op: z.literal(">"),
      valuePct: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      indicator: z.literal("momentum"),
      lookbackDays: z.number().int().min(1).max(365),
      op: z.enum(["<", ">"]),
      valuePct: z.number().min(-100).max(1000),
    })
    .strict(),
]);
export const marketplaceSchema = z.object({
  schema: z.literal("atlas.strategy/v1"),
  universe: z
    .array(
      z.object({
        symbol: z.string().refine((s) => !!resolveAsset(s)?.active),
        weight: z.number().min(0.01).max(100),
      }),
    )
    .min(1)
    .max(20)
    .refine(
      (a) =>
        new Set(a.map((v) => v.symbol)).size === a.length &&
        a.reduce((s, v) => s + v.weight, 0) <= 100.001,
    ),
  rules: z
    .array(
      z.object({
        appliesTo: z.string(),
        when: condition,
        then: z.object({
          action: z.enum(["buy", "increase"]),
          sizePct: z.number().min(0.01).max(100),
        }),
      }),
    )
    .max(1),
  risk: z.object({
    stopLossPct: z.number().min(0.01).max(99.99),
    takeProfitPct: z.number().min(0.01).max(100),
    cashBufferPct: z.number().min(0).max(99),
  }),
  execution: z.object({ maxSlippageBps: z.number().int().min(0).max(1000) }),
});
export type MarketplaceSpec = z.infer<typeof marketplaceSchema>;
/** Same declarative rule shape as the marketplace; only observed samples are used. */
export function evaluateRule(
  c: z.infer<typeof condition>,
  history: Tick[],
  now: number,
) {
  const h = history.filter((v) => v.timestamp <= now),
    p = h.map((v) => Number(v.price));
  const cmp = (v: number, t: number) => (c.op === "<" ? v < t : v > t);
  if (c.indicator === "rsi") {
    if (p.length < c.period + 1) return false;
    let up = 0,
      down = 0;
    for (let i = p.length - c.period; i < p.length; i++) {
      const d = p[i]! - p[i - 1]!;
      if (d > 0) up += d;
      else down -= d;
    }
    const rsi =
      down === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / down);
    return cmp(rsi, c.value);
  }
  if (c.indicator === "sma_cross") {
    if (p.length < c.slow + 1) return false;
    const avg = (period: number, offset: number) =>
      p
        .slice(p.length - period - offset, p.length - offset)
        .reduce((s, v) => s + v, 0) / period;
    const prev = avg(c.fast, 1) - avg(c.slow, 1),
      cur = avg(c.fast, 0) - avg(c.slow, 0);
    return c.op === "crosses_above"
      ? prev <= 0 && cur > 0
      : prev >= 0 && cur < 0;
  }
  const cutoff = now - c.lookbackDays * 86400,
    base = h.filter((v) => v.timestamp <= cutoff).at(-1);
  if (!base || !p.length) return false; // insufficient lookback is not a signal
  if (c.indicator === "momentum")
    return cmp((p.at(-1)! / Number(base.price) - 1) * 100, c.valuePct);
  const peak = Math.max(
    Number(base.price),
    ...h.filter((v) => v.timestamp >= cutoff).map((v) => Number(v.price)),
  );
  return (1 - p.at(-1)! / peak) * 100 > c.valuePct;
}
