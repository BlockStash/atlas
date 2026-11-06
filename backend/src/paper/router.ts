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
