import { marketsAlwaysOpen } from "./market-engine.js";
import type {
  AtlasTradeIntent,
  EntryCondition,
  ExitCondition,
} from "./types.js";

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const when = (ts: number) =>
  new Date(ts * 1000).toISOString().replace(".000Z", "Z");
const usd = (p: string) => `$${p} USDT`;

export function describeEntry(c: EntryCondition, market: string): string {
  switch (c.type) {
    case "MARKET_OPEN":
      return marketsAlwaysOpen() ? "the plan is active" : `${market} is open`;
    case "PRICE_BELOW":
      return `price is below ${usd(c.priceUSDT)}`;
    case "PRICE_ABOVE":
      return `price is above ${usd(c.priceUSDT)}`;
    case "AT_TIME":
      return `the time is ${when(c.timestamp)}`;
    case "AFTER_TIME":
      return `the time is after ${when(c.timestamp)}`;
    case "BEFORE_TIME":
      return `the time is before ${when(c.timestamp)}`;
  }
}
export function describeExit(c: ExitCondition): string {
  switch (c.type) {
    case "TAKE_PROFIT_BPS":
      return `+${pct(c.value)} profit`;
    case "STOP_LOSS_BPS":
      return `-${pct(c.value)} loss`;
    case "PRICE_ABOVE":
      return `the price reaches ${usd(c.priceUSDT)}`;
    case "PRICE_BELOW":
      return `the price falls to ${usd(c.priceUSDT)}`;
    case "TIME_EXIT":
      return `${when(c.timestamp)}`;
  }
}
export const describeAllocation = (
  a: AtlasTradeIntent["allocation"],
  side: string,
) =>
  a.type === "FIXED_USDT"
    ? `${Number(a.value).toLocaleString("en-US")} USDT`
    : a.type === "VAULT_PERCENT"
      ? `${a.value}% of your vault`
      : side === "SELL"
        ? `${a.value}% of your position`
        : `${a.value}% of your portfolio`;

/** Generated from structured fields only, never from model text. */
export function summarizeIntent(i: AtlasTradeIntent): string {
  const c = i.constraints;
  const name = `${i.asset.companyName} (${i.asset.symbol})`;
  // With 24/7 markets a market-open entry means "now", so it isn't worth waiting on in words.
  const entry = i.entryConditions
    .filter((e) => !(e.type === "MARKET_OPEN" && marketsAlwaysOpen()))
    .map((e) => describeEntry(e, i.asset.market));
  const exits = i.exitConditions.map(describeExit);
  const parts: string[] = [];
  if (i.side === "BUY") {
    parts.push(
      `Atlas will ${entry.length ? `wait until ${entry.join(" and ")}, then ` : ""}attempt to buy approximately ${describeAllocation(i.allocation, i.side)} of ${name}.`,
    );
  } else {
    parts.push(
      `Atlas will ${entry.length ? `wait until ${entry.join(" and ")}, then ` : ""}sell ${describeAllocation(i.allocation, i.side)} of ${name} when ${exits.length ? exits.join(" or ") : "triggered"}.`,
    );
  }
  if (!marketsAlwaysOpen())
    parts.push(
      "Atlas always requires the exchange to be open before it trades.",
    );
  if (c.maxSlippageBps !== undefined)
    parts.push(
      `It will not execute if estimated slippage is above ${pct(c.maxSlippageBps)}.`,
    );
  if (c.maxExecutionPriceUSDT)
    parts.push(`It will not execute above ${usd(c.maxExecutionPriceUSDT)}.`);
  if (c.minExecutionPriceUSDT)
    parts.push(`It will not execute below ${usd(c.minExecutionPriceUSDT)}.`);
  if (i.side === "BUY" && exits.length)
    parts.push(
      `After execution, Atlas will monitor the position and exit at ${exits.join(" or ")}.`,
    );
  if (c.validUntil)
    parts.push(`The strategy expires at ${when(c.validUntil)}.`);
  return parts.join(" ");
}
