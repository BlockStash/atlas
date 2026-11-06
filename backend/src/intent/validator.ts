import {
  strategySchema,
  type AtlasTradeIntent,
  type ValidationIssue,
  type PriceQuote,
  type MarketState,
} from "./types.js";
import { assetByStockId } from "./assets.js";
import { parsePrice } from "./math.js";
import { isAddress } from "ethers";

export interface ValidationContext {
  now: number;
  price: PriceQuote | null;
  market: MarketState | null;
  /** Recorded as an issue, not a throw, so the user sees every problem at once. */
}
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const FORBIDDEN_PHRASES =
  /guaranteed? profit|risk[- ]free|definitely make money/i;

/** Deterministic structural, catalog and logical validation. No AI, no I/O. */
export function validateIntent(
  intent: AtlasTradeIntent,
  ctx: ValidationContext,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (code: string, message: string, path?: string) =>
    issues.push({ code, message, path });

  if (!isAddress(intent.userAddress))
    add("INVALID_WALLET", "Wallet address is invalid.", "userAddress");
  const parsed = strategySchema.safeParse({
    version: intent.version,
    asset: intent.asset,
    side: intent.side,
    allocation: intent.allocation,
    entryConditions: intent.entryConditions,
    exitConditions: intent.exitConditions,
    constraints: intent.constraints,
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues)
      add("SCHEMA", i.message, i.path.join("."));
    return { valid: false, issues };
  }

  const asset = assetByStockId(intent.asset.stockId);
  if (!asset)
    add(
      "UNKNOWN_STOCK",
      "This stock is not in the Atlas catalog.",
      "asset.stockId",
    );
  else {
    if (!asset.active)
      add(
        "STOCK_DISABLED",
        `${asset.symbol} is currently disabled.`,
        "asset.stockId",
      );
    if (
      asset.symbol !== intent.asset.symbol ||
      asset.exchange !== intent.asset.market
    )
      add(
        "ASSET_MISMATCH",
        "Asset fields do not match the Atlas catalog.",
        "asset",
      );
  }
  if (FORBIDDEN_PHRASES.test(intent.metadata.originalPrompt))
    add(
      "UNREALISTIC_CLAIM",
      "Atlas cannot guarantee returns or remove risk. Remove phrases like 'guaranteed profit' or 'risk-free'.",
      "metadata.originalPrompt",
    );

  // Allocation
  const alloc = intent.allocation;
  if (!(Number(alloc.value) > 0))
    add(
      "ALLOCATION_NOT_POSITIVE",
      "Allocation must be greater than zero.",
      "allocation.value",
    );
  if (alloc.type !== "FIXED_USDT" && Number(alloc.value) > 100)
    add(
      "ALLOCATION_PERCENT_RANGE",
      "Percent allocations must be between 0 and 100.",
      "allocation.value",
    );
  if (intent.side === "SELL" && alloc.type === "VAULT_PERCENT")
    add(
      "SELL_ALLOCATION_UNSUPPORTED",
      "Sell strategies use FIXED_USDT or a percent of the position.",
      "allocation.type",
    );

  const c = intent.constraints;
  if (c.validAfter && c.validUntil && c.validUntil <= c.validAfter)
    add(
      "EXPIRY_BEFORE_START",
      "The strategy would expire before it starts.",
      "constraints.validUntil",
    );
  if (c.validUntil && c.validUntil <= ctx.now)
    add(
      "ALREADY_EXPIRED",
      "The expiry time has already passed.",
      "constraints.validUntil",
    );
  if (
    c.maxExecutionPriceUSDT &&
    c.minExecutionPriceUSDT &&
    parsePrice(c.minExecutionPriceUSDT) > parsePrice(c.maxExecutionPriceUSDT)
  )
    add(
      "PRICE_BOUNDS_CONTRADICT",
      "Minimum execution price is above the maximum.",
      "constraints",
    );

  // Entry logic: entry conditions are ANDed. Detect impossible combinations.
  const entry = intent.entryConditions;
  if (intent.side === "BUY" && entry.length === 0)
    add(
      "MISSING_ENTRY",
      "A buy strategy needs an entry condition (market open, a price, or a time).",
      "entryConditions",
    );
  const below = entry.flatMap((e) =>
    e.type === "PRICE_BELOW" ? [parsePrice(e.priceUSDT)] : [],
  );
  const above = entry.flatMap((e) =>
    e.type === "PRICE_ABOVE" ? [parsePrice(e.priceUSDT)] : [],
  );
  if (below.length && above.length) {
    const hi = below.reduce((a, b) => (a < b ? a : b));
    const lo = above.reduce((a, b) => (a > b ? a : b));
    if (lo >= hi)
      add(
        "ENTRY_PRICE_CONTRADICTION",
        "Entry requires the price to be both below and above levels that cannot both hold.",
        "entryConditions",
      );
  }
  const at = entry.flatMap((e) => (e.type === "AT_TIME" ? [e.timestamp] : []));
  if (new Set(at).size > 1)
    add(
      "ENTRY_TIME_CONTRADICTION",
      "Multiple different AT_TIME entries cannot all be true.",
      "entryConditions",
    );
  const after = entry.flatMap((e) =>
    e.type === "AFTER_TIME" ? [e.timestamp] : [],
  );
  const before = entry.flatMap((e) =>
    e.type === "BEFORE_TIME" ? [e.timestamp] : [],
  );
  const lowT = Math.max(0, ...after, ...(c.validAfter ? [c.validAfter] : []));
  const highT = Math.min(
    Infinity,
    ...before,
    ...(c.validUntil ? [c.validUntil] : []),
  );
  if (lowT >= highT && (after.length || before.length))
    add(
      "ENTRY_TIME_CONTRADICTION",
      "The entry time window is empty.",
      "entryConditions",
    );
  if (at.length === 1 && (at[0]! < lowT || at[0]! > highT))
    add(
      "ENTRY_TIME_CONTRADICTION",
      "AT_TIME falls outside the allowed time window.",
      "entryConditions",
    );
  const maxP = c.maxExecutionPriceUSDT
    ? parsePrice(c.maxExecutionPriceUSDT)
    : null;
  const minP = c.minExecutionPriceUSDT
    ? parsePrice(c.minExecutionPriceUSDT)
    : null;
  if (
    maxP !== null &&
    above.length &&
    Math.min(...above.map(Number)) >= Number(maxP)
  )
    add(
      "ENTRY_PRICE_CONTRADICTION",
      "Entry PRICE_ABOVE is at or above the maximum execution price.",
      "constraints",
    );
  if (
    minP !== null &&
    below.length &&
    Math.max(...below.map(Number)) <= Number(minP)
  )
    add(
      "ENTRY_PRICE_CONTRADICTION",
      "Entry PRICE_BELOW is at or below the minimum execution price.",
      "constraints",
    );

  // Exit logic: exits are ORed, but each must be coherent.
  const exits = intent.exitConditions;
  if (intent.side === "SELL" && exits.length === 0 && entry.length === 0)
    add(
      "MISSING_TRIGGER",
      "A sell strategy needs a trigger (profit, loss, price or time).",
      "exitConditions",
    );
  const seen = new Set<string>();
  for (const e of exits) {
    if (
      seen.has(e.type) &&
      (e.type === "TAKE_PROFIT_BPS" || e.type === "STOP_LOSS_BPS")
    )
      add("DUPLICATE_EXIT", `Duplicate ${e.type}.`, "exitConditions");
    seen.add(e.type);
    if (
      e.type === "TIME_EXIT" &&
      e.holdSeconds === undefined &&
      c.validAfter &&
      e.timestamp <= c.validAfter
    )
      add(
        "EXIT_BEFORE_START",
        "Time exit is before the strategy starts.",
        "exitConditions",
      );
    if (
      e.type === "TIME_EXIT" &&
      e.holdSeconds === undefined &&
      e.timestamp <= ctx.now
    )
      add(
        "EXIT_ALREADY_PASSED",
        "Time exit has already passed.",
        "exitConditions",
      );
  }

  // Market data
  if (!ctx.price)
    add("PRICE_MISSING", "No price is available for this stock.", "asset");
  else {
    const p = parsePrice(ctx.price.priceUSDT);
    for (const e of exits) {
      if (
        e.type === "PRICE_ABOVE" &&
        intent.side === "BUY" &&
        parsePrice(e.priceUSDT) <= p &&
        !below.length
      )
        add(
          "EXIT_ALREADY_SATISFIED",
          "The exit price is already at or below the current price; it would trigger immediately.",
          "exitConditions",
        );
      if (
        e.type === "PRICE_BELOW" &&
        intent.side === "BUY" &&
        parsePrice(e.priceUSDT) >= p &&
        !above.length &&
        !below.length
      )
        add(
          "EXIT_ALREADY_SATISFIED",
          "The exit price is already at or above the current price; it would trigger immediately.",
          "exitConditions",
        );
    }
  }
  return { valid: issues.length === 0, issues };
}
