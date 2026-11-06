import type {
  AtlasTradeIntent,
  EntryCondition,
  ExitCondition,
  MarketState,
} from "./types.js";
import { parsePrice, pnlBps } from "./math.js";

export interface Evaluation {
  satisfied: boolean;
  reasons: string[];
}
const fmt = (n: bigint) => (Number(n) / 1e8).toString();

/** All entry conditions must hold (AND). Market must always be open to execute, regardless of conditions. */
export function evaluateEntryConditions(
  intent: Pick<AtlasTradeIntent, "entryConditions" | "constraints">,
  market: MarketState,
  priceScaled: bigint,
  now: number,
): Evaluation {
  const reasons: string[] = [];
  const {
    validAfter,
    validUntil,
    maxExecutionPriceUSDT,
    minExecutionPriceUSDT,
  } = intent.constraints;
  if (validAfter && now < validAfter) reasons.push("Strategy is not valid yet");
  if (validUntil && now > validUntil) reasons.push("Strategy has expired");
  if (!market.open) reasons.push(`Market closed (${market.reason})`);
  if (maxExecutionPriceUSDT && priceScaled > parsePrice(maxExecutionPriceUSDT))
    reasons.push(
      `Price ${fmt(priceScaled)} above max execution price ${maxExecutionPriceUSDT}`,
    );
  if (minExecutionPriceUSDT && priceScaled < parsePrice(minExecutionPriceUSDT))
    reasons.push(
      `Price ${fmt(priceScaled)} below min execution price ${minExecutionPriceUSDT}`,
    );
  for (const c of intent.entryConditions) {
    const miss = entryMiss(c, market, priceScaled, now);
    if (miss) reasons.push(miss);
  }
  return { satisfied: reasons.length === 0, reasons };
}
function entryMiss(
  c: EntryCondition,
  market: MarketState,
  p: bigint,
  now: number,
) {
  switch (c.type) {
    case "MARKET_OPEN":
      return market.open ? null : "Waiting for the market to open";
    case "PRICE_BELOW":
      return p < parsePrice(c.priceUSDT)
        ? null
        : `Price ${fmt(p)} is not below ${c.priceUSDT}`;
    case "PRICE_ABOVE":
      return p > parsePrice(c.priceUSDT)
        ? null
        : `Price ${fmt(p)} is not above ${c.priceUSDT}`;
    case "AT_TIME":
      // At-time is a trigger reached at or after the timestamp; the validity window bounds how late it may fire.
      return now >= c.timestamp ? null : "Waiting for the scheduled time";
    case "AFTER_TIME":
      return now >= c.timestamp
        ? null
        : "Waiting until after the specified time";
    case "BEFORE_TIME":
      return now < c.timestamp ? null : "The allowed time window has passed";
  }
}

/** Deterministic exit priority: stop loss > take profit > price exits > time exit. */
export const EXIT_PRIORITY: ExitCondition["type"][] = [
  "STOP_LOSS_BPS",
  "TAKE_PROFIT_BPS",
  "PRICE_BELOW",
  "PRICE_ABOVE",
  "TIME_EXIT",
];
export interface ExitEvaluation extends Evaluation {
  trigger: ExitCondition["type"] | null;
  pnlBps: bigint;
}
/** Exits are ORed. Returns the highest-priority triggered rule. (Manual close is handled by the service, ahead of all rules.) */
export function evaluateExitConditions(
  exits: ExitCondition[],
  entryPriceScaled: bigint,
  currentScaled: bigint,
  now: number,
): ExitEvaluation {
  const pnl = pnlBps(entryPriceScaled, currentScaled);
  const hits: { type: ExitCondition["type"]; reason: string }[] = [];
  for (const e of exits) {
    switch (e.type) {
      case "STOP_LOSS_BPS":
        if (
          currentScaled * 10000n <=
          entryPriceScaled * (10000n - BigInt(e.value))
        )
          hits.push({
            type: e.type,
            reason: `Stop loss: P&L ${Number(pnl) / 100}% <= -${e.value / 100}%`,
          });
        break;
      case "TAKE_PROFIT_BPS":
        if (
          currentScaled * 10000n >=
          entryPriceScaled * (10000n + BigInt(e.value))
        )
          hits.push({
            type: e.type,
            reason: `Take profit: P&L ${Number(pnl) / 100}% >= ${e.value / 100}%`,
          });
        break;
      case "PRICE_ABOVE":
        if (currentScaled >= parsePrice(e.priceUSDT))
          hits.push({ type: e.type, reason: `Price reached ${e.priceUSDT}` });
        break;
      case "PRICE_BELOW":
        if (currentScaled <= parsePrice(e.priceUSDT))
          hits.push({ type: e.type, reason: `Price fell to ${e.priceUSDT}` });
        break;
      case "TIME_EXIT":
        if (now >= e.timestamp)
          hits.push({ type: e.type, reason: "Time exit reached" });
        break;
    }
  }
  hits.sort(
    (a, b) => EXIT_PRIORITY.indexOf(a.type) - EXIT_PRIORITY.indexOf(b.type),
  );
  return {
    satisfied: hits.length > 0,
    reasons: hits.map((h) => h.reason),
    trigger: hits[0]?.type ?? null,
    pnlBps: pnl,
  };
}
