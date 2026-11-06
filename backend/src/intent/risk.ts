import {
  type AtlasTradeIntent,
  type PortfolioView,
  type PriceQuote,
  type RiskMetrics,
  type RiskWarning,
  type ValidationIssue,
  type MarketState,
  BPS,
} from "./types.js";
import {
  formatUSDT,
  parsePrice,
  parseUSDT,
  percentString,
  valueOf,
} from "./math.js";
import { isLowLiquidity } from "./slippage.js";

export interface RiskLimits {
  maxTradeUSDT: string;
  maxPortfolioPercentPerTrade: number;
  maxSingleAssetExposurePercent: number;
  maxCountryExposurePercent: number;
  maxSlippageBps: number;
  maxStopLossBps: number;
  maxTakeProfitBps: number;
  maxActiveIntents: number;
  /** Not user-overridable. Soft thresholds only produce warnings. */
  maxValidityDays: number;
}
export const DEFAULT_LIMITS: RiskLimits = {
  maxTradeUSDT: "50000",
  maxPortfolioPercentPerTrade: 50,
  maxSingleAssetExposurePercent: 70,
  maxCountryExposurePercent: 90,
  maxSlippageBps: 300,
  maxStopLossBps: 5000,
  maxTakeProfitBps: 100_000,
  maxActiveIntents: 10,
  maxValidityDays: 30,
};
export function limitsFromEnv(env = process.env): RiskLimits {
  const n = (k: string, d: number) =>
    env[k] && Number.isFinite(Number(env[k])) ? Number(env[k]) : d;
  return {
    ...DEFAULT_LIMITS,
    maxTradeUSDT: env.INTENT_MAX_TRADE_USDT || DEFAULT_LIMITS.maxTradeUSDT,
    maxPortfolioPercentPerTrade: n(
      "INTENT_MAX_PORTFOLIO_PERCENT",
      DEFAULT_LIMITS.maxPortfolioPercentPerTrade,
    ),
    maxActiveIntents: n("INTENT_MAX_ACTIVE", DEFAULT_LIMITS.maxActiveIntents),
    maxSlippageBps: n("INTENT_MAX_SLIPPAGE_BPS", DEFAULT_LIMITS.maxSlippageBps),
  };
}

/** Resolve the allocation into a USDT notional (6-dec). SELL percent = percent of the held position. */
export function resolveNotional(
  intent: Pick<AtlasTradeIntent, "allocation" | "side" | "asset">,
  portfolio: PortfolioView,
  price: bigint,
): bigint {
  const { type, value } = intent.allocation;
  if (type === "FIXED_USDT") return parseUSDT(value);
  const pct = BigInt(Math.round(Number(value) * 100)); // percent with 2 decimals; value is validated
  if (intent.side === "SELL") {
    const held = portfolio.positions.find(
      (p) => p.stockId.toLowerCase() === intent.asset.stockId.toLowerCase(),
    );
    return held ? (valueOf(held.quantity, price) * pct) / 10_000n : 0n;
  }
  const base =
    type === "VAULT_PERCENT"
      ? portfolio.vaultAssetsUSDT
      : portfolio.totalValueUSDT;
  return (base * pct) / 10_000n;
}

export interface RiskContext {
  now: number;
  price: PriceQuote;
  market: MarketState;
  portfolio: PortfolioView;
  limits: RiskLimits;
  exchange: string;
}
export interface RiskResult {
  metrics: RiskMetrics;
  warnings: RiskWarning[];
  violations: ValidationIssue[];
  notional: bigint;
}

export function assessRisk(
  intent: AtlasTradeIntent,
  ctx: RiskContext,
): RiskResult {
  const { limits, portfolio, price: quote } = ctx;
  const price = parsePrice(quote.priceUSDT);
  const notional = resolveNotional(intent, portfolio, price);
  const warnings: RiskWarning[] = [];
  const violations: ValidationIssue[] = [];
  const v = (code: string, message: string, path?: string) =>
    violations.push({ code, message, path });
  const w = (
    severity: RiskWarning["severity"],
    code: RiskWarning["code"],
    message: string,
  ) => warnings.push({ severity, code, message });

  const total = portfolio.totalValueUSDT;
  const maxTrade = parseUSDT(limits.maxTradeUSDT);
  if (notional <= 0n)
    v(
      "ALLOCATION_RESOLVES_TO_ZERO",
      "This allocation resolves to zero USDT.",
      "allocation",
    );
  if (notional > maxTrade)
    v(
      "MAX_TRADE_EXCEEDED",
      `Trade size exceeds the Atlas limit of ${limits.maxTradeUSDT} USDT.`,
      "allocation",
    );

  const tradePct = total > 0n ? (notional * 10_000n) / total : 0n;
  if (intent.side === "BUY") {
    if (
      total > 0n &&
      tradePct > BigInt(limits.maxPortfolioPercentPerTrade * 100)
    )
      v(
        "MAX_PORTFOLIO_PERCENT_EXCEEDED",
        `A single trade may use at most ${limits.maxPortfolioPercentPerTrade}% of your portfolio.`,
        "allocation",
      );
    if (notional > portfolio.vaultAssetsUSDT)
      v(
        "INSUFFICIENT_BALANCE",
        "Your Atlas Vault balance is lower than the maximum spend.",
        "allocation",
      );
  }

  const held = portfolio.positions
    .filter(
      (p) => p.stockId.toLowerCase() === intent.asset.stockId.toLowerCase(),
    )
    .reduce((a, p) => a + p.valueUSDT, 0n);
  const countryHeld = portfolio.positions
    .filter((p) => p.country === intent.asset.country)
    .reduce((a, p) => a + p.valueUSDT, 0n);
  const sign = intent.side === "BUY" ? 1n : -1n;
  const assetAfter = held + sign * notional;
  const countryAfter = countryHeld + sign * notional;
  const assetPct = total > 0n ? (assetAfter * 10_000n) / total : 0n;
  const countryPct = total > 0n ? (countryAfter * 10_000n) / total : 0n;

  if (intent.side === "BUY") {
    if (assetPct > BigInt(limits.maxSingleAssetExposurePercent * 100))
      v(
        "ASSET_CONCENTRATION_EXCEEDED",
        `This would raise ${intent.asset.symbol} exposure to ${percentString(assetPct, 100n)}%, above the ${limits.maxSingleAssetExposurePercent}% limit.`,
      );
    else if (assetPct > 4000n)
      w(
        "HIGH",
        "HIGH_CONCENTRATION",
        `This strategy would increase ${intent.asset.symbol} exposure to ${percentString(assetPct, 100n)}% of your portfolio.`,
      );
    if (countryPct > BigInt(limits.maxCountryExposurePercent * 100))
      v(
        "COUNTRY_CONCENTRATION_EXCEEDED",
        `This would raise ${intent.asset.country} exposure above ${limits.maxCountryExposurePercent}%.`,
      );
    else if (countryPct > 6000n)
      w(
        "MEDIUM",
        "COUNTRY_CONCENTRATION",
        `${intent.asset.country} would be ${percentString(countryPct, 100n)}% of your portfolio.`,
      );
    if (tradePct > 2500n)
      w(
        "MEDIUM",
        "HIGH_POSITION_SIZE",
        `This trade uses ${percentString(tradePct, 100n)}% of your portfolio.`,
      );
  }

  const vaultUtil =
    portfolio.vaultAssetsUSDT > 0n
      ? (notional * 10_000n) / portfolio.vaultAssetsUSDT
      : 0n;
  if (intent.side === "BUY" && vaultUtil > 7500n)
    w(
      "MEDIUM",
      "VAULT_UTILIZATION_HIGH",
      `This uses ${percentString(vaultUtil, 100n)}% of your vault balance.`,
    );

  const slipCfg = intent.constraints.maxSlippageBps ?? 0;
  if (slipCfg > limits.maxSlippageBps)
    v(
      "MAX_SLIPPAGE_EXCEEDED",
      `Slippage tolerance may not exceed ${limits.maxSlippageBps} bps.`,
      "constraints.maxSlippageBps",
    );
  else if (slipCfg > 100)
    w(
      "MEDIUM",
      "HIGH_SLIPPAGE",
      `A ${slipCfg / 100}% slippage tolerance is high.`,
    );

  const tp = intent.exitConditions.find((e) => e.type === "TAKE_PROFIT_BPS");
  const sl = intent.exitConditions.find((e) => e.type === "STOP_LOSS_BPS");
  if (tp?.type === "TAKE_PROFIT_BPS" && tp.value > limits.maxTakeProfitBps)
    v(
      "MAX_TAKE_PROFIT_EXCEEDED",
      `Take profit may not exceed ${limits.maxTakeProfitBps / 100}%.`,
    );
  if (sl?.type === "STOP_LOSS_BPS" && sl.value > limits.maxStopLossBps)
    v(
      "MAX_STOP_LOSS_EXCEEDED",
      `Stop loss may not exceed ${limits.maxStopLossBps / 100}%.`,
    );
  if (intent.side === "BUY" && !sl)
    w(
      "MEDIUM",
      "NO_STOP_LOSS",
      "This strategy has no stop loss; losses are not capped by a rule.",
    );

  if (isLowLiquidity(notional, ctx.exchange))
    w(
      "HIGH",
      "LOW_LIQUIDITY",
      "This order is large relative to modeled market depth; slippage may be high.",
    );
  if (!ctx.market.open)
    w(
      "LOW",
      "MARKET_CLOSED",
      `${ctx.exchange} is currently closed. Atlas will wait for the market to open.`,
    );
  if (quote.isStale)
    w(
      "HIGH",
      "PRICE_STALE",
      "The latest price is stale. Atlas will not trade until a fresh price is available.",
    );
  const until = intent.constraints.validUntil;
  const from = intent.constraints.validAfter ?? ctx.now;
  if (until && until - from > limits.maxValidityDays * 86_400)
    v(
      "EXPIRY_TOO_LONG",
      `Strategies may be valid for at most ${limits.maxValidityDays} days.`,
      "constraints.validUntil",
    );
  else if (until && until - from > 7 * 86_400)
    w(
      "LOW",
      "EXPIRY_TOO_LONG",
      "This strategy stays active for more than 7 days.",
    );

  const maxLoss =
    sl?.type === "STOP_LOSS_BPS" ? (notional * BigInt(sl.value)) / BPS : null;
  const metrics: RiskMetrics = {
    tradeNotionalUSDT: formatUSDT(notional),
    portfolioPercent: percentString(tradePct, 100n),
    singleAssetExposurePercent: percentString(
      assetPct < 0n ? 0n : assetPct,
      100n,
    ),
    countryExposurePercent: percentString(
      countryPct < 0n ? 0n : countryPct,
      100n,
    ),
    vaultUtilizationPercent: percentString(vaultUtil, 100n),
    estimatedMaxLossUSDT: maxLoss === null ? null : formatUSDT(maxLoss),
    stopLossDistanceBps: sl?.type === "STOP_LOSS_BPS" ? sl.value : null,
    slippageToleranceBps: slipCfg,
    potentialReturnBps: tp?.type === "TAKE_PROFIT_BPS" ? tp.value : null,
  };
  return { metrics, warnings, violations, notional };
}
