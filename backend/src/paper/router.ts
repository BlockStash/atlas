import { Router } from "express";
import { z } from "zod";
import { PaperEngine } from "./engine.js";
import { configSchema } from "./market.js";
import { parsePaperPrompt } from "./parser.js";
import {
  aiConfigured,
  anthropicModel,
  type ModelClient,
} from "../intent/parser.js";
import { IntentError } from "../intent/types.js";
import { resolveAsset } from "../intent/assets.js";
import type { WalletSession } from "../types.js";

/** Separate wallet-scoped in-memory ledgers. Never creates an IntentEngine or chainRegistry. */
export function paperRouter(
  production: boolean,
  model: ModelClient | undefined = aiConfigured()
    ? anthropicModel()
    : undefined,
) {
  const r = Router(),
    sessions = new Map<string, { engine: PaperEngine; touched: number }>();
  const timer = setInterval(() => {
    for (const [key, s] of sessions) {
      if (Date.now() - s.touched > 2 * 3600000) {
        sessions.delete(key);
        continue;
      }
      s.engine.pump();
    }
  }, 250);
  timer.unref();
  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (production)
      throw new IntentError(
        "FORBIDDEN",
        "The paper simulator is enabled only on development servers.",
        403,
      );
    next();
  });
  const engine = (res: import("express").Response) => {
    const key = (res.locals.wallet as WalletSession).address.toLowerCase();
    let s = sessions.get(key);
    if (!s) {
      if (sessions.size >= 50)
        throw new IntentError(
          "CONFLICT",
          "Paper simulation session limit reached.",
          409,
        );
      s = { engine: new PaperEngine(), touched: Date.now() };
      sessions.set(key, s);
    }
    s.touched = Date.now();
    return s.engine;
  };
  r.get("/", (_req, res) => res.json(engine(res).snapshot()));
  r.post("/reset", (req, res) =>
    res.json(engine(res).reset(configSchema.parse(req.body))),
  );
  r.post("/clock", (req, res) => {
    const b = z
      .object({
        action: z.enum(["pause", "resume", "speed", "step"]),
        speed: z.number().min(1).max(600).optional(),
        steps: z.number().int().min(1).max(3600).optional(),
      })
      .strict()
      .parse(req.body);
    const e = engine(res);
    res.json(
      b.action === "step" ? e.step(b.steps ?? 1) : e.control(b.action, b.speed),
    );
  });
  r.post("/preview", async (req, res) => {
    const b = z
      .object({
        prompt: z.string().min(1).max(1200),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .strict()
      .parse(req.body);
    const e = engine(res),
      result = await parsePaperPrompt(b.prompt, model);
    if (result.status !== "OK") {
      res.json(result);
      return;
    }
    const explicitDates = [...b.prompt.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(
      (m) => m[0],
    );
    if (explicitDates.some((d) => d !== b.date))
      throw new IntentError(
        "INVALID_INTENT",
        "The date in the instruction differs from the selected simulation date.",
        422,
      );
    try {
      res.json({
        status: "OK",
        parser: result.parser,
        ...e.preview(result.draft, b.date),
      });
    } catch (error) {
      if (error instanceof IntentError && error.code === "INVALID_INTENT") {
        res.json({ status: "CLARIFICATION_NEEDED", question: error.message });
        return;
      }
      throw error;
    }
  });
  /**
   * Turns an Atlas AI trade plan into a paper order on this wallet's simulation clock: buy now
   * (next simulated minute) with the plan's spend, slippage cap and bracket. Returns a preview and
   * one-use confirmation token; nothing fills until /:id/confirm.
   */
  r.post("/from-intent", (req, res) => {
    const b = z
      .object({
        symbol: z.string().min(1).max(16),
        notionalUSDT: z.number().positive().max(1_000_000),
        maxSlippageBps: z.number().int().min(0).max(1000).optional(),
        takeProfitBps: z.number().int().min(1).max(10000).optional(),
        stopLossBps: z.number().int().min(1).max(9999).optional(),
      })
      .strict()
      .parse(req.body);
    const e = engine(res),
      asset = resolveAsset(b.symbol);
    const quote = asset && e.market.quoteSync(asset.stockId, e.now);
    if (!asset?.active || !quote)
      throw new IntentError(
        "INVALID_INTENT",
        "This stock has no paper price yet. Open Paper Trading and start the clock first.",
        422,
      );
    const qty =
      Math.floor((b.notionalUSDT / Number(quote.priceUSDT)) * 1e8) / 1e8;
    if (!(qty > 0))
      throw new IntentError(
        "INVALID_INTENT",
        "Spend is too small for one share fraction.",
        422,
      );
    const at = new Date((Math.floor(e.now / 60) + 1) * 60 * 1000),
      date = at.toISOString().slice(0, 10),
      hhmm = (d: Date) => d.toISOString().slice(11, 16),
      expiry = new Date(
        Math.min(at.getTime() + 3600_000, Date.parse(`${date}T23:59:00Z`)),
      );
    if (expiry.getTime() <= at.getTime())
      throw new IntentError(
        "INVALID_INTENT",
        "The paper clock is at the end of its simulated day. Reset Paper Trading and try again.",
        422,
      );
    const defaults: string[] = [];
    if (b.takeProfitBps === undefined) defaults.push("take profit +10%");
    if (b.stopLossBps === undefined) defaults.push("stop loss -5%");
    if (b.maxSlippageBps === undefined) defaults.push("max slippage 1%");
    res.json({
      ...e.preview(
        {
          symbol: asset.symbol,
          quantity: String(qty),
          entryTime: hhmm(at),
          expiryTime: hhmm(expiry),
          timezone: "UTC",
          maxSlippageBps: b.maxSlippageBps ?? 100,
          takeProfitBps: b.takeProfitBps ?? 1000,
          stopLossBps: b.stopLossBps ?? 500,
        },
        date,
        "atlas-ai",
      ),
      defaults,
    });
  });
  r.post("/import", (req, res) => {
    const b = z
      .object({
        spec: z.unknown(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        timezone: z.string(),
        entryTime: z.string(),
        expiryTime: z.string(),
      })
      .strict()
      .parse(req.body);
    res.json(
      engine(res).importStrategy(
        b.spec,
        b.date,
        b.timezone,
        b.entryTime,
        b.expiryTime,
      ),
    );
  });
  r.post("/:id/confirm", (req, res) => {
    const b = z
      .object({
        confirmationToken: z.string().uuid(),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    res.json(engine(res).confirm(String(req.params.id), b.confirmationToken));
  });
  r.post("/:id/cancel", (req, res) =>
    res.json(engine(res).cancel(String(req.params.id))),
  );
  return r;
}
