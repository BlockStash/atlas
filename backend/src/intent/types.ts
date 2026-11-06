import { z } from "zod";

/** Amounts: USDT = 6 decimals (bigint micro-units); prices = 1e8 scale; quantity = 1e18 scale. Same as the engine. */
export const USDT_DECIMALS = 6;
export const PRICE_SCALE = 100_000_000n;
export const QTY_SCALE = 10n ** 18n;
export const BPS = 10_000n;

export const INTENT_STATUSES = [
  "DRAFT",
  "PARSED",
  "INVALID",
  "SIMULATED",
  "AWAITING_APPROVAL",
  "ACTIVE",
  "WAITING_FOR_ENTRY",
  "EXECUTING",
  "POSITION_OPEN",
  "MONITORING",
  "EXIT_TRIGGERED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "PAUSED",
] as const;
export type AtlasIntentStatus = (typeof INTENT_STATUSES)[number];

export const ERROR_CODES = [
  "AI_PARSE_FAILED",
  "INVALID_INTENT",
  "UNSUPPORTED_INTENT",
  "RISK_REJECTED",
  "USER_REJECTED_SIGNATURE",
  "INTENT_EXPIRED",
  "PRICE_STALE",
  "MARKET_CLOSED",
  "SLIPPAGE_TOO_HIGH",
  "INSUFFICIENT_BALANCE",
  "TRADE_REVERTED",
  "RPC_ERROR",
  "POSITION_MONITOR_ERROR",
  "EXIT_EXECUTION_FAILED",
] as const;
export type AtlasErrorCode = (typeof ERROR_CODES)[number];

export class IntentError extends Error {
  constructor(
    public code: AtlasErrorCode | "NOT_FOUND" | "CONFLICT" | "FORBIDDEN",
    message: string,
    public status = 400,
    public details?: unknown,
    /** Transient failures may be retried by the worker; everything else is terminal. */
    public retryable = false,
  ) {
    super(message);
  }
}

/** Positive decimal string, max 8 fractional digits (matches the price scale). */
export const decimalString = z
  .string()
  .regex(/^(0|[1-9]\d{0,17})(\.\d{1,8})?$/, "Expected a decimal string");

const bps = (max: number) => z.number().int().min(1).max(max);
const unixSeconds = z.number().int().min(1_000_000_000).max(4_102_444_800);

export const entryConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MARKET_OPEN") }).strict(),
  z
    .object({ type: z.literal("PRICE_BELOW"), priceUSDT: decimalString })
    .strict(),
  z
    .object({ type: z.literal("PRICE_ABOVE"), priceUSDT: decimalString })
    .strict(),
  z.object({ type: z.literal("AT_TIME"), timestamp: unixSeconds }).strict(),
  z.object({ type: z.literal("AFTER_TIME"), timestamp: unixSeconds }).strict(),
  z.object({ type: z.literal("BEFORE_TIME"), timestamp: unixSeconds }).strict(),
]);
export type EntryCondition = z.infer<typeof entryConditionSchema>;

export const exitConditionSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("TAKE_PROFIT_BPS"), value: bps(1_000_000) })
    .strict(),
  z.object({ type: z.literal("STOP_LOSS_BPS"), value: bps(9_999) }).strict(),
  z
    .object({ type: z.literal("PRICE_ABOVE"), priceUSDT: decimalString })
    .strict(),
  z
    .object({ type: z.literal("PRICE_BELOW"), priceUSDT: decimalString })
    .strict(),
  z
    .object({
      type: z.literal("TIME_EXIT"),
      timestamp: unixSeconds,
      /** Hold relative to the actual entry fill ("sell 10 seconds after buying"); timestamp is only the preview estimate. */
      holdSeconds: z.number().int().positive().max(31_536_000).optional(),
    })
    .strict(),
]);
export type ExitCondition = z.infer<typeof exitConditionSchema>;

export const allocationSchema = z
  .object({
    type: z.enum(["FIXED_USDT", "PORTFOLIO_PERCENT", "VAULT_PERCENT"]),
    value: decimalString,
  })
  .strict();
export type Allocation = z.infer<typeof allocationSchema>;

export const constraintsSchema = z
  .object({
    maxSlippageBps: z.number().int().min(1).max(10_000).optional(),
    maxExecutionPriceUSDT: decimalString.optional(),
    minExecutionPriceUSDT: decimalString.optional(),
    validAfter: unixSeconds.optional(),
    validUntil: unixSeconds.optional(),
  })
  .strict();
export type Constraints = z.infer<typeof constraintsSchema>;

/** The strategy body: everything the user signs (via its canonical hash). */
export const strategySchema = z
  .object({
    version: z.literal("1"),
    asset: z
      .object({
        stockId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        symbol: z.string().min(1).max(16),
        companyName: z.string().min(1).max(120),
        market: z.string().min(1).max(40),
        country: z.string().min(1).max(8),
        currency: z.string().min(3).max(3),
      })
      .strict(),
    side: z.enum(["BUY", "SELL"]),
    allocation: allocationSchema,
    entryConditions: z.array(entryConditionSchema).max(6),
    exitConditions: z.array(exitConditionSchema).max(6),
    constraints: constraintsSchema,
  })
  .strict();
export type AtlasStrategy = z.infer<typeof strategySchema>;

export type AtlasTradeIntent = AtlasStrategy & {
  id: string;
  userAddress: string;
  metadata: {
    originalPrompt: string;
    createdAt: number;
    /** Fields Atlas filled with defaults because the prompt omitted them. Always shown to the user. */
    defaultsApplied: string[];
    parser: "ai" | "rules" | "manual";
  };
};

/** What the model is allowed to emit. Symbols are free text; Atlas resolves them against its own catalog. */
export const draftSchema = z
  .object({
    symbol: z.string().min(1).max(40),
    side: z.enum(["BUY", "SELL"]),
    allocation: allocationSchema.optional(),
    entryConditions: z.array(entryConditionSchema).max(6).default([]),
    exitConditions: z.array(exitConditionSchema).max(6).default([]),
    constraints: constraintsSchema.default({}),
  })
  .strict();
export type IntentDraft = z.infer<typeof draftSchema>;

export const aiResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("OK"), intent: draftSchema }).strict(),
  z
    .object({
      status: z.literal("CLARIFICATION_NEEDED"),
      question: z.string().max(300),
      field: z.enum(["entry", "allocation", "asset", "side", "exit"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("UNSUPPORTED_INTENT"),
      reason: z.string().max(300),
    })
    .strict(),
]);
export type AiResponse = z.infer<typeof aiResponseSchema>;

export type Severity = "LOW" | "MEDIUM" | "HIGH";
export const WARNING_CODES = [
  "HIGH_SLIPPAGE",
  "HIGH_POSITION_SIZE",
  "HIGH_CONCENTRATION",
  "COUNTRY_CONCENTRATION",
  "NO_STOP_LOSS",
  "LOW_LIQUIDITY",
  "MARKET_CLOSED",
  "PRICE_STALE",
  "VAULT_UTILIZATION_HIGH",
  "EXPIRY_TOO_LONG",
] as const;
export interface RiskWarning {
  severity: Severity;
  code: (typeof WARNING_CODES)[number];
  message: string;
}
export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface MarketState {
  open: boolean;
  /** Next open instant (unix s) when closed; null when open or unknown. */
  nextOpen: number | null;
  nextClose: number | null;
  reason: "OPEN" | "OUTSIDE_HOURS" | "WEEKEND" | "HOLIDAY";
  timezone: string;
  exchange: string;
}

export interface PriceQuote {
  stockId: string;
  nativePrice: string;
  nativeCurrency: string;
  /** 1e8-scaled USDT price as a decimal string. */
  priceUSDT: string;
  updatedAt: number;
  isStale: boolean;
  /** Where the price came from; "demo" is never presented as live. */
  source?: string;
}

export interface PortfolioView {
  totalValueUSDT: bigint;
  vaultAssetsUSDT: bigint;
  walletUSDT: bigint;
  positions: {
    stockId: string;
    country: string;
    valueUSDT: bigint;
    quantity: bigint;
  }[];
  activeIntents: number;
}

export interface IntentSimulation {
  estimatedEntryPrice: string;
  estimatedQuantity: string;
  estimatedNotionalUSDT: string;
  estimatedFeesUSDT: string;
  estimatedSlippageUSDT: string;
  estimatedSlippageBps: number;
  estimatedTakeProfitPrice?: string;
  estimatedStopLossPrice?: string;
  estimatedProfitAtTargetUSDT?: string;
  estimatedLossAtStopUSDT?: string;
  marketStatus: string;
  exposureAfterTradePercent: string;
  warnings: RiskWarning[];
  disclaimer: string;
}

export interface RiskMetrics {
  tradeNotionalUSDT: string;
  portfolioPercent: string;
  singleAssetExposurePercent: string;
  countryExposurePercent: string;
  vaultUtilizationPercent: string;
  estimatedMaxLossUSDT: string | null;
  stopLossDistanceBps: number | null;
  slippageToleranceBps: number;
  potentialReturnBps: number | null;
}

export const DISCLAIMER =
  "Atlas AI converts your instructions into trading rules. It does not guarantee returns. Estimates are not guaranteed results.";
