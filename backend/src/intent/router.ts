import { Router } from "express";
import { z } from "zod";
import { strategySchema, IntentError } from "./types.js";
import type { IntentEngine } from "./wiring.js";
import type { WalletSession } from "../types.js";
import type { AtlasTradeIntent } from "./types.js";
import { strategyHash, strategyBody } from "./canonical.js";
import { MAX_PROMPT_CHARS, portfolioHint } from "./parser.js";
import { BACKTEST_PERIODS, backtestIntent } from "./backtest.js";
import { unsupportedAssets, unsupportedMessage } from "../strategies/core.js";

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
      onchain: c.onchain
        ? { executor: c.onchain.address, chainId: 11155111 }
        : null,
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
    // Only listed tokenized stocks (funded in aUSDT/USDT) can be traded.
    const unsupported = unsupportedAssets(prompt);
    if (unsupported.length) {
      res.json({
        status: "UNSUPPORTED_INTENT",
        reason: unsupportedMessage(unsupported),
        unsupported,
      });
      return;
    }
    // "Highest-priced stock within 1000 USDT": Atlas picks the asset from live quotes first.
    const picked = await ctx(res).service.selectAsset(prompt);
    if (picked.status === "NO_MATCH") {
      res.json({
        status: "CLARIFICATION_NEEDED",
        question: `${picked.reason} Which stock should Atlas trade?`,
        field: "asset",
        options: [],
      });
      return;
    }
    const selection = picked.status === "SELECTED" ? picked.selection : null;
    const instruction = selection?.prompt ?? prompt;
    const hint = portfolioHint(instruction);
    if (hint) {
      res.json({ status: "PORTFOLIO_STRATEGY", reason: hint });
      return;
    }
    const out = await ctx(res).service.parse(instruction, user(res));
    res.json({
      ...out,
      ...(selection
        ? {
            selection: {
              note: selection.note,
              symbol: selection.asset.symbol,
              priceUSDT: selection.priceUSDT,
              rank: selection.rank,
              capUSDT: selection.capUSDT,
            },
          }
        : {}),
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
  /** Scenario backtest of the plan's exact rules over synthetic paths, before anything is signed. */
  r.post("/backtest", async (req, res) => {
    const { intent, days } = z
      .object({
        intent: intentBody,
        days: z
          .number()
          .int()
          .refine((d) => (BACKTEST_PERIODS as readonly number[]).includes(d))
          .default(90),
      })
      .strict()
      .parse(req.body);
    const ev = await ctx(res).service.evaluate(toIntent(intent, user(res)));
    const sim = ev.simulation,
      price = Number(ev.price?.priceUSDT),
      notional = Number(sim?.estimatedNotionalUSDT);
    if (!sim || !(price > 0) || !(notional > 0))
      throw new IntentError(
        "INVALID_INTENT",
        "Fix the issues in this plan before backtesting it.",
        422,
      );
    res.json({
      backtest: backtestIntent({
        intent: ev.intent,
        price,
        notional,
        feeBps: (Number(sim.estimatedFeesUSDT) / notional) * 10_000,
        slippageBps: sim.estimatedSlippageBps,
        days: days as (typeof BACKTEST_PERIODS)[number],
        seedKey: `${ev.strategyHash}:${days}`,
        now: ctx(res).ctx.now() * 1000, // Engine clock (seconds), so demo/test clocks line up.
      }),
    });
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
  r.get("/trades", (_req, res) => res.json(ctx(res).service.trades(user(res))));
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
    const { signature, permission } = z
      .object({
        signature: z.string().min(4).max(1000),
        /** ERC-7715 grant from MetaMask (live execution only). */
        permission: z
          .object({
            context: z
              .string()
              .regex(/^0x[0-9a-fA-F]+$/)
              .max(20_000),
            delegationManager: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            allowanceShares: z
              .string()
              .regex(/^\d{1,78}$/)
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    const wallet = res.locals.wallet as WalletSession;
    res.json(
      await ctx(res).service.activate(
        id.parse(req.params.id),
        user(res),
        signature,
        wallet.demo,
        permission,
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
