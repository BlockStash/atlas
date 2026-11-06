import type { AtlasTradeIntent } from "./types.js";

/**
 * Pre-deployment backtest for one trade plan.
 *
 * There is no tick history for every Atlas instrument, so this runs the plan's exact entry and
 * exit rules against many seeded synthetic price paths (geometric Brownian motion anchored at the
 * current price). It answers "how often does this bracket hit target vs stop, and over what
 * range of outcomes" — it is a scenario model, never a forecast or real historical performance.
 */

export const BACKTEST_PERIODS = [30, 90, 180] as const;
export type BacktestDays = (typeof BACKTEST_PERIODS)[number];
export type ExitReason =
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "PRICE_EXIT"
  | "TIME_EXIT"
  | "OPEN"
  | "NOT_TRIGGERED";

export interface BacktestInput {
  intent: AtlasTradeIntent;
  /** Current price, USDT. */
  price: number;
  /** Planned spend, USDT. */
  notional: number;
  feeBps: number;
  slippageBps: number;
  days: BacktestDays;
  seedKey: string;
  now: number;
}

export interface BacktestResult {
  days: number;
  runs: number;
  stepsPerDay: number;
  annualVolatility: number;
  /** Price percentiles per point, downsampled. `day` is days from today. */
  band: { day: number; p10: number; p50: number; p90: number }[];
  /** The median-outcome run, with its entry and exit marked. */
  sample: {
    path: { day: number; price: number }[];
    entry: { day: number; price: number } | null;
    exit: { day: number; price: number; reason: ExitReason } | null;
    pnlUSDT: number;
  };
  levels: {
    current: number;
    entryTrigger: number | null;
    takeProfit: number | null;
    stopLoss: number | null;
  };
  stats: {
    triggeredPct: number;
    takeProfitPct: number;
    stopLossPct: number;
    otherExitPct: number;
    stillOpenPct: number;
    winRatePct: number;
    expectedPnlUSDT: number;
    medianPnlUSDT: number;
    p10PnlUSDT: number;
    p90PnlUSDT: number;
    avgHoldDays: number | null;
  };
  disclaimer: string;
}

const RUNS = 400,
  STEPS_PER_DAY = 4,
  MAX_POINTS = 120,
  DAY_MS = 86_400_000;
const VOL: Record<string, number> = {
  NASDAQ: 0.32,
  NYSE: 0.26,
  LSE: 0.22,
  XETRA: 0.24,
  EURONEXT: 0.24,
  SGX: 0.2,
  NSE: 0.26,
  BSE: 0.26,
};
const DRIFT = 0.07;

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pctile = (sorted: number[], p: number) =>
  sorted[
    Math.min(
      sorted.length - 1,
      Math.max(0, Math.round(p * (sorted.length - 1))),
    )
  ]!;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

interface Run {
  path: number[];
  entry: { i: number; price: number } | null;
  exit: { i: number; price: number; reason: ExitReason } | null;
  pnl: number;
}

export function backtestIntent(input: BacktestInput): BacktestResult {
  const { intent, price, notional, days, now } = input;
  const steps = days * STEPS_PER_DAY,
    dt = 1 / (365 * STEPS_PER_DAY),
    vol = VOL[intent.asset.market?.toUpperCase?.() ?? ""] ?? 0.28,
    stepAt = (ts: number) =>
      Math.ceil((ts * 1000 - now) / (DAY_MS / STEPS_PER_DAY));
  const cost = (input.feeBps + input.slippageBps) / 10_000;

  // Entry rules (all must hold), as step windows and price triggers.
  let earliest = 0,
    latest = steps,
    below: number | null = null,
    above: number | null = null;
  for (const c of intent.entryConditions) {
    if (c.type === "PRICE_BELOW") below = Number(c.priceUSDT);
    else if (c.type === "PRICE_ABOVE") above = Number(c.priceUSDT);
    else if (c.type === "AT_TIME" || c.type === "AFTER_TIME")
      earliest = Math.max(earliest, stepAt(c.timestamp));
    else if (c.type === "BEFORE_TIME")
      latest = Math.min(latest, stepAt(c.timestamp));
  }
  if (intent.constraints.validAfter)
    earliest = Math.max(earliest, stepAt(intent.constraints.validAfter));
  if (intent.constraints.validUntil)
    latest = Math.min(latest, stepAt(intent.constraints.validUntil));

  // Exit rules (any one fires). Bps targets are relative to the actual fill.
  let tpBps: number | null = null,
    slBps: number | null = null,
    exitAbove: number | null = null,
    exitBelow: number | null = null,
    exitAt: number | null = null;
  for (const c of intent.exitConditions) {
    if (c.type === "TAKE_PROFIT_BPS") tpBps = c.value;
    else if (c.type === "STOP_LOSS_BPS") slBps = c.value;
    else if (c.type === "PRICE_ABOVE") exitAbove = Number(c.priceUSDT);
    else if (c.type === "PRICE_BELOW") exitBelow = Number(c.priceUSDT);
    else if (c.type === "TIME_EXIT") exitAt = stepAt(c.timestamp);
  }

  const rand = rng(hash(input.seedKey));
  const runs: Run[] = [];
  for (let k = 0; k < RUNS; k++) {
    const path = [price];
    for (let i = 1; i <= steps; i++) {
      const z =
        Math.sqrt(-2 * Math.log(rand() || 1e-12)) *
        Math.cos(2 * Math.PI * rand());
      path.push(
        path[i - 1]! *
          Math.exp((DRIFT - (vol * vol) / 2) * dt + vol * Math.sqrt(dt) * z),
      );
    }
    let entry: Run["entry"] = null,
      exit: Run["exit"] = null;
    for (let i = Math.max(0, earliest); i <= Math.min(steps, latest); i++) {
      const p = path[i]!;
      if ((below === null || p <= below) && (above === null || p >= above)) {
        entry = { i, price: p };
        break;
      }
    }
    if (entry) {
      const tp = tpBps ? entry.price * (1 + tpBps / 10_000) : null,
        sl = slBps ? entry.price * (1 - slBps / 10_000) : null;
      for (let i = entry.i + 1; i <= steps; i++) {
        const p = path[i]!;
        // Stop-loss wins when both hit in one step, matching the execution worker.
        if (sl !== null && p <= sl) exit = { i, price: p, reason: "STOP_LOSS" };
        else if (exitBelow !== null && p <= exitBelow)
          exit = { i, price: p, reason: "PRICE_EXIT" };
        else if (tp !== null && p >= tp)
          exit = { i, price: p, reason: "TAKE_PROFIT" };
        else if (exitAbove !== null && p >= exitAbove)
          exit = { i, price: p, reason: "PRICE_EXIT" };
        else if (exitAt !== null && i >= exitAt)
          exit = { i, price: p, reason: "TIME_EXIT" };
        if (exit) break;
      }
    }
    let pnl = 0;
    if (entry) {
      const mark = exit?.price ?? path[steps]!;
      if (intent.side === "BUY") {
        const qty = (notional * (1 - cost)) / entry.price;
        pnl = qty * mark * (exit ? 1 - cost : 1) - notional;
      } else {
        // A sell locks in the trigger price versus holding at today's price.
        const qty = notional / price;
        pnl = qty * (entry.price * (1 - cost) - price);
      }
    }
    runs.push({ path, entry, exit, pnl });
  }

  const pnls = runs.map((r) => r.pnl).sort((a, b) => a - b);
  const triggered = runs.filter((r) => r.entry);
  const count = (f: (r: Run) => boolean) =>
    (runs.filter(f).length / RUNS) * 100;
  const holds = triggered.map(
    (r) => ((r.exit?.i ?? steps) - r.entry!.i) / STEPS_PER_DAY,
  );
  const median = pctile(pnls, 0.5);
  const sampleRun = runs.reduce((best, r) =>
    Math.abs(r.pnl - median) < Math.abs(best.pnl - median) ? r : best,
  );

  const stride = Math.max(1, Math.ceil(steps / MAX_POINTS));
  const idx: number[] = [];
  for (let i = 0; i <= steps; i += stride) idx.push(i);
  if (idx.at(-1) !== steps) idx.push(steps);
  const band = idx.map((i) => {
    const col = runs.map((r) => r.path[i]!).sort((a, b) => a - b);
    return {
      day: r2(i / STEPS_PER_DAY),
      p10: r4(pctile(col, 0.1)),
      p50: r4(pctile(col, 0.5)),
      p90: r4(pctile(col, 0.9)),
    };
  });

  return {
    days,
    runs: RUNS,
    stepsPerDay: STEPS_PER_DAY,
    annualVolatility: vol,
    band,
    sample: {
      path: idx.map((i) => ({
        day: r2(i / STEPS_PER_DAY),
        price: r4(sampleRun.path[i]!),
      })),
      entry: sampleRun.entry
        ? {
            day: r2(sampleRun.entry.i / STEPS_PER_DAY),
            price: r4(sampleRun.entry.price),
          }
        : null,
      exit: sampleRun.exit
        ? {
            day: r2(sampleRun.exit.i / STEPS_PER_DAY),
            price: r4(sampleRun.exit.price),
            reason: sampleRun.exit.reason,
          }
        : null,
      pnlUSDT: r2(sampleRun.pnl),
    },
    levels: {
      current: r4(price),
      entryTrigger: below ?? above,
      takeProfit: tpBps
        ? r4((below ?? above ?? price) * (1 + tpBps / 10_000))
        : exitAbove,
      stopLoss: slBps
        ? r4((below ?? above ?? price) * (1 - slBps / 10_000))
        : exitBelow,
    },
    stats: {
      triggeredPct: r2((triggered.length / RUNS) * 100),
      takeProfitPct: r2(count((r) => r.exit?.reason === "TAKE_PROFIT")),
      stopLossPct: r2(count((r) => r.exit?.reason === "STOP_LOSS")),
      otherExitPct: r2(
        count(
          (r) =>
            r.exit?.reason === "PRICE_EXIT" || r.exit?.reason === "TIME_EXIT",
        ),
      ),
      stillOpenPct: r2(count((r) => !!r.entry && !r.exit)),
      winRatePct: triggered.length
        ? r2(
            (triggered.filter((r) => r.pnl > 0).length / triggered.length) *
              100,
          )
        : 0,
      expectedPnlUSDT: r2(pnls.reduce((s, v) => s + v, 0) / RUNS),
      medianPnlUSDT: r2(median),
      p10PnlUSDT: r2(pctile(pnls, 0.1)),
      p90PnlUSDT: r2(pctile(pnls, 0.9)),
      avgHoldDays: holds.length
        ? r2(holds.reduce((s, v) => s + v, 0) / holds.length)
        : null,
    },
    disclaimer: `Scenario backtest: ${RUNS} synthetic price paths at ${Math.round(vol * 100)}% annual volatility, using this plan's exact entry and exit rules, fees and slippage. Not historical performance and not a forecast.`,
  };
}
