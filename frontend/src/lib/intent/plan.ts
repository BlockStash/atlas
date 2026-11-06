/**
 * Bridges Atlas AI trade plans (the intent engine) and saved marketplace strategies.
 *
 * A strategy stores the plan without identity, id or creation time. Plans contain absolute
 * times (e.g. "after 30 seconds", "valid for 24 hours"), so each run shifts every time forward by
 * how long ago the plan was written; the plan keeps its relative timing whenever it is run.
 */
import type { ExecutablePlan, PlanIntent } from "../strategy-core";
import type { Intent } from "./client";

const MAX_PROMPT_CHARS = 600;
const ZERO_ID = "0x" + "0".repeat(64);

export function planFromIntent(
  intent: Intent,
  now = Math.floor(Date.now() / 1000),
): ExecutablePlan {
  const { asset, side, allocation, entryConditions, exitConditions } = intent;
  return {
    schema: "atlas.intent/v1",
    anchor: now,
    intent: structuredClone({
      version: "1",
      asset,
      side,
      allocation,
      entryConditions,
      exitConditions,
      constraints: intent.constraints,
      metadata: {
        originalPrompt: intent.metadata.originalPrompt.slice(
          0,
          MAX_PROMPT_CHARS,
        ),
        defaultsApplied: intent.metadata.defaultsApplied.slice(0, 10),
        parser: intent.metadata.parser,
      },
    }) as PlanIntent,
  };
}

/** The plan as a runnable intent, with its times moved forward to `now`. */
export function intentFromPlan(
  plan: ExecutablePlan,
  now = Math.floor(Date.now() / 1000),
): Intent {
  const delta = Math.max(0, now - plan.anchor);
  const shift = (t: unknown) => (typeof t === "number" ? t + delta : t);
  const intent = structuredClone(plan.intent) as unknown as Intent;
  intent.entryConditions = intent.entryConditions.map((c) =>
    "timestamp" in c ? { ...c, timestamp: shift(c.timestamp) as number } : c,
  );
  intent.exitConditions = intent.exitConditions.map((c) =>
    "timestamp" in c ? { ...c, timestamp: shift(c.timestamp) as number } : c,
  );
  for (const k of ["validAfter", "validUntil"] as const)
    if (intent.constraints[k] !== undefined)
      intent.constraints[k] = shift(intent.constraints[k]) as number;
  return {
    ...intent,
    id: ZERO_ID,
    userAddress: "",
    metadata: { ...intent.metadata, createdAt: 0 },
  };
}
