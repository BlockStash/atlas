import {
  DISCLAIMER,
  BPS,
  type AtlasTradeIntent,
  type IntentSimulation,
  type PortfolioView,
  type PriceQuote,
  type MarketState,
} from "./types.js";
import { assessRisk, type RiskLimits, type RiskResult } from "./risk.js";
import { calculateSlippage } from "./slippage.js";
import {
  ceilDiv,
  formatPrice,
  formatQty,
  formatUSDT,
  parsePrice,
  priceAtBps,
  quantityFor,
  valueOf,
} from "./math.js";

export const TRADING_FEE_BPS = 10n; // AtlasCountryTradingEngine default tradingFeeBps

export interface SimulationInput {
  intent: AtlasTradeIntent;
  now: number;
  price: PriceQuote;
  market: MarketState;
  portfolio: PortfolioView;
  limits: RiskLimits;
}
export interface SimulationOutput {
  simulation: IntentSimulation;
  risk: RiskResult;
}

/** Pure, deterministic preview. Every figure is an estimate and is labelled as such in the UI. */
export function simulateIntent(i: SimulationInput): SimulationOutput {
  const { intent, price: q } = i;
  const px = parsePrice(q.priceUSDT);
  const risk = assessRisk(intent, {
    now: i.now,
    price: q,
    market: i.market,
    portfolio: i.portfolio,
    limits: i.limits,
    exchange: intent.asset.market,
  });
  const notional = risk.notional;
  const slipBps = BigInt(calculateSlippage(notional, intent.asset.market));
  const buy = intent.side === "BUY";
  // BUY pays up, SELL receives less.
  const entryPx = buy
    ? px + ceilDiv(px * slipBps, BPS)
    : px - (px * slipBps) / BPS;
  const slippageUSDT = ceilDiv(notional * slipBps, BPS);
  const fees = ceilDiv(notional * TRADING_FEE_BPS, BPS);
  const qty = quantityFor(notional, entryPx);

  const tp = intent.exitConditions.find((e) => e.type === "TAKE_PROFIT_BPS");
  const sl = intent.exitConditions.find((e) => e.type === "STOP_LOSS_BPS");
  const out: IntentSimulation = {
    estimatedEntryPrice: formatPrice(entryPx),
    estimatedQuantity: formatQty(qty),
    estimatedNotionalUSDT: formatUSDT(notional),
    estimatedFeesUSDT: formatUSDT(fees),
    estimatedSlippageUSDT: formatUSDT(slippageUSDT),
    estimatedSlippageBps: Number(slipBps),
    marketStatus: i.market.open ? "OPEN" : i.market.reason,
    exposureAfterTradePercent: risk.metrics.singleAssetExposurePercent,
    warnings: [...risk.warnings],
    disclaimer: DISCLAIMER,
  };
  const maxSlip = intent.constraints.maxSlippageBps;
  if (maxSlip !== undefined && Number(slipBps) > maxSlip)
    out.warnings.push({
      severity: "HIGH",
      code: "HIGH_SLIPPAGE",
      message: `Estimated slippage (${Number(slipBps) / 100}%) exceeds your ${maxSlip / 100}% limit; Atlas would not execute right now.`,
    });
  if (tp?.type === "TAKE_PROFIT_BPS") {
    const target = priceAtBps(entryPx, BigInt(tp.value));
    out.estimatedTakeProfitPrice = formatPrice(target);
    out.estimatedProfitAtTargetUSDT = formatUSDT(
      valueOf(qty, target) - valueOf(qty, entryPx, true),
    );
  }
  if (sl?.type === "STOP_LOSS_BPS") {
    const stop = priceAtBps(entryPx, -BigInt(sl.value));
    out.estimatedStopLossPrice = formatPrice(stop);
    out.estimatedLossAtStopUSDT = formatUSDT(
      valueOf(qty, entryPx, true) - valueOf(qty, stop),
    );
  }
  return { simulation: out, risk };
}
