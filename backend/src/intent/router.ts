import { Router } from "express";
import { z } from "zod";
import { strategySchema, IntentError } from "./types.js";
import type { IntentEngine } from "./wiring.js";
import type { WalletSession } from "../types.js";
import type { AtlasTradeIntent } from "./types.js";
import { strategyHash, strategyBody } from "./canonical.js";
import { MAX_PROMPT_CHARS } from "./parser.js";

const intentBody = z
  .object({
    id: z.string().optional(),
    userAddress: z.string().optional(),
    ...strategySchema.shape,
    metadata: z
      .object({
        originalPrompt: z.string().max(MAX_PROMPT_CHARS),
        createdAt: z.number().optional(),
        defaultsApplied: z.array(z.string().max(40)).max(10).default([]),
        parser: z.enum(["ai", "rules", "manual"]).default("manual"),
      })
      .strip(),
  })
  .strip();
/** Client-supplied intents are untrusted: identity, id and time are overwritten by the server. */
const toIntent = (
  b: z.infer<typeof intentBody>,
  user: string,
): AtlasTradeIntent =>
  ({
    ...b,
    id: "0x" + "0".repeat(64),
    userAddress: user,
    metadata: { ...b.metadata, createdAt: 0 },
  }) as AtlasTradeIntent;

export function intentRouter() {
  const r = Router();
  const ctx = (res: import("express").Response) =>
    res.locals.engine as IntentEngine;
  const user = (res: import("express").Response) =>
    (res.locals.wallet as WalletSession).address;
  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  r.get("/config", (_req, res) => {
    const { ctx: c } = ctx(res);
    res.json({
      demoMode: c.demoMode,
      executionMode: c.adapter.kind === "ONCHAIN" ? "ONCHAIN" : "SIMULATED",
      aiParser: c.model ? "ai" : "rules",
      limits: c.limits,
      domain: c.domain,
      demoControls: c.demoMode,
    });
  });

  r.post("/parse", async (req, res) => {
    const { prompt } = z
      .object({
        prompt: z
          .string()
          .min(1)
          .max(MAX_PROMPT_CHARS * 2),
      })
      .strict()
      .parse(req.body);
    const out = await ctx(res).service.parse(prompt, user(res));
    res.json({
      ...out,
      parseHash:
        out.status === "OK"
          ? strategyHash(strategyBody(out.intent))
          : undefined,
    });
  });
  r.post("/validate", async (req, res) => {
    const { intent } = z
      .object({ intent: intentBody })
      .strict()
      .parse(req.body);
    res.json(await ctx(res).service.evaluate(toIntent(intent, user(res))));
  });
  r.post("/simulate", async (req, res) => {
    const { intent } = z
      .object({ intent: intentBody })
      .strict()
      .parse(req.body);
    res.json(await ctx(res).service.evaluate(toIntent(intent, user(res))));
  });
  r.post("/", async (req, res) => {
    const { intent, parseHash } = z
      .object({
        intent: intentBody,
        parseHash: z
          .string()
          .regex(/^0x[0-9a-f]{64}$/i)
          .optional(),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(
      await ctx(res).service.create(toIntent(intent, user(res)), user(res), {
        parseHash,
      }),
    );
  });
  r.get("/", (_req, res) =>
    res.json({ intents: ctx(res).service.list(user(res)) }),
  );
  r.get("/notifications", (req, res) =>
    res.json({
      notifications: ctx(res).service.notifications(
        user(res),
        req.query.markRead === "1",
      ),
    }),
  );

  // Demo-only controls, so an investor can move a price or open a market on demand.
  const demoOnly = (res: import("express").Response) => {
    const c = ctx(res).ctx;
    if (!c.demoMode || !c.demoPrices)
      throw new IntentError("FORBIDDEN", "Demo controls are disabled.", 403);
    return c;
  };
  r.post("/demo/price", async (req, res) => {
    const c = demoOnly(res);
    const b = z
      .object({
        stockId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        multiplierBps: z.number().int(),
      })
      .strict()
      .parse(req.body);
    c.demoPrices!.setMultiplierBps(b.stockId, b.multiplierBps);
    res.json({ ok: true });
  });
  r.post("/demo/market", (req, res) => {
    const c = demoOnly(res);
    const b = z.object({ open: z.boolean() }).strict().parse(req.body);
    c.demoMarkets!.forceOpen = b.open;
    res.json({ ok: true, forceOpen: b.open });
  });
  r.post("/demo/tick", async (_req, res) => {
    demoOnly(res);
    res.json({ processed: await ctx(res).worker.tick() });
  });

  const id = z.string().regex(/^0x[0-9a-f]{64}$/i);
  r.get("/:id", (req, res) =>
    res.json(ctx(res).service.get(id.parse(req.params.id), user(res))),
  );
  r.get("/:id/events", (req, res) =>
    res.json({
      events: ctx(res).service.events(id.parse(req.params.id), user(res)),
    }),
  );
  r.post("/:id/activate", async (req, res) => {
    const { signature } = z
      .object({ signature: z.string().min(4).max(1000) })
      .strict()
      .parse(req.body);
    const wallet = res.locals.wallet as WalletSession;
    res.json(
      await ctx(res).service.activate(
        id.parse(req.params.id),
        user(res),
        signature,
        wallet.demo,
      ),
    );
  });
  r.post("/:id/cancel", async (req, res) =>
    res.json(await ctx(res).service.cancel(id.parse(req.params.id), user(res))),
  );
  r.post("/:id/close", async (req, res) =>
    res.json(
      await ctx(res).service.closePosition(id.parse(req.params.id), user(res)),
    ),
  );
  return r;
}
