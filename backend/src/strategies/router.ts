import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  CREATOR_FEE_BPS,
  STRATEGY_COLORS,
  STRATEGY_ICONS,
  generateSpec,
  unsupportedMessage,
  validateSpec,
} from "./core.js";
import { StrategyError, type StrategyService, type Viewer } from "./service.js";
import type { WalletSession } from "../types.js";

const icon = z
  .object({ name: z.enum(STRATEGY_ICONS), color: z.enum(STRATEGY_COLORS) })
  .strict();
const text = (max: number) => z.string().trim().min(1).max(max);
const createSchema = z
  .object({
    name: text(80),
    tagline: z.string().trim().max(240),
    prompt: z.string().trim().max(1000),
    spec: z.record(z.string(), z.unknown()),
    visibility: z.enum(["private", "public"]),
    icon: icon.nullable().optional(),
  })
  .strict();
const updateSchema = createSchema.omit({ visibility: true }).partial().strict();
const amount = z.number().finite().positive().max(1_000_000_000);
const id = z.string().regex(/^[a-z]{3}_[a-z0-9_]{1,48}$/i);

/**
 * /api/strategies — the strategy marketplace.
 * Reads work signed out (public strategies only); writes need a wallet session.
 */
export function strategiesRouter(options: {
  service: StrategyService;
  viewer: (res: Response) => Promise<Viewer | undefined>;
  limit: RequestHandler;
  production: boolean;
}) {
  const { service } = options;
  const r = Router();
  const need = async (res: Response) => {
    const v = await options.viewer(res);
    if (!v)
      throw new StrategyError(
        "AUTH_REQUIRED",
        "Connect your wallet to continue.",
        401,
      );
    return v;
  };
  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  r.get("/", async (_req, res) => {
    const viewer = await options.viewer(res);
    res.json({
      strategies: service.list(viewer),
      positions: viewer ? service.positions(viewer) : [],
      viewer: viewer ?? null,
      creatorFeeBps: CREATOR_FEE_BPS,
    });
  });

  /** Prompt → spec. Deterministic compiler today; the contract allows swapping in an LLM later. */
  r.post("/generate", options.limit, async (req, res) => {
    await need(res);
    const { prompt } = z
      .object({ prompt: text(1000) })
      .strict()
      .parse(req.body);
    const generated = generateSpec(prompt);
    if (generated.unsupported.length)
      throw new StrategyError(
        "UNSUPPORTED_ASSET",
        unsupportedMessage(generated.unsupported),
        422,
      );
    res.json(generated);
  });
  r.post("/validate", async (req, res) => {
    const { spec } = z.object({ spec: z.unknown() }).strict().parse(req.body);
    const result = validateSpec(spec);
    res.status(result.spec ? 200 : 422).json(result);
  });

  r.get("/positions", async (_req, res) => {
    res.json({ positions: service.positions(await need(res)) });
  });
  r.delete("/positions/:id", async (req, res) => {
    service.stop(await need(res), id.parse(req.params.id));
    res.json({ ok: true });
  });

  r.get("/creators/:handle", async (req, res) => {
    const handle = z.string().min(3).max(255).parse(req.params.handle);
    res.json(service.creator(handle, await options.viewer(res)));
  });

  r.post("/reset", async (_req, res) => {
    if (options.production)
      throw new StrategyError(
        "FORBIDDEN",
        "Demo reset is disabled in production.",
        403,
      );
    const viewer = await need(res);
    service.reset(viewer);
    res.json({
      strategies: service.list(viewer),
      positions: service.positions(viewer),
    });
  });

  r.post("/", options.limit, async (req, res) => {
    const input = createSchema.parse(req.body);
    res.status(201).json(service.create(await need(res), input));
  });
  r.get("/:id", async (req, res) => {
    res.json(service.get(id.parse(req.params.id), await options.viewer(res)));
  });
  r.patch("/:id", async (req, res) => {
    const patch = updateSchema.parse(req.body);
    res.json(service.update(await need(res), id.parse(req.params.id), patch));
  });
  r.put("/:id/visibility", async (req, res) => {
    const { visibility } = z
      .object({ visibility: z.enum(["private", "public"]) })
      .strict()
      .parse(req.body);
    res.json(
      service.setVisibility(
        await need(res),
        id.parse(req.params.id),
        visibility,
      ),
    );
  });
  r.delete("/:id", async (req, res) => {
    service.remove(await need(res), id.parse(req.params.id));
    res.json({ ok: true });
  });
  r.post("/:id/clone", options.limit, async (req, res) => {
    res
      .status(201)
      .json(service.clone(await need(res), id.parse(req.params.id)));
  });
  r.post("/:id/backtest", options.limit, async (req, res) => {
    const { capital } = z.object({ capital: amount }).strict().parse(req.body);
    res.json(
      service.backtest(await need(res), id.parse(req.params.id), capital),
    );
  });
  r.post("/:id/deploy", options.limit, async (req, res) => {
    const body = z
      .object({ mode: z.enum(["paper", "live"]), amount })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json(
        service.deploy(
          await need(res),
          id.parse(req.params.id),
          body.mode,
          body.amount,
        ),
      );
  });
  return r;
}

export const walletOf = (res: Response) =>
  res.locals.wallet as WalletSession | undefined;
