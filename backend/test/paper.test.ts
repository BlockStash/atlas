import { test } from "node:test";
import assert from "node:assert/strict";
import { PaperEngine } from "../src/paper/engine.js";
import { EXAMPLE, parsePaperPrompt, wallTime } from "../src/paper/parser.js";
import { resolveAsset } from "../src/intent/assets.js";
import { evaluateRule } from "../src/paper/strategy.js";
const start = 1793892540;
async function preview(e: PaperEngine) {
  const p = await parsePaperPrompt(EXAMPLE);
  assert.equal(p.status, "OK");
  if (p.status !== "OK") throw Error("Parse");
  return e.preview(p.draft, "2026-11-05");
}
async function active(e: PaperEngine) {
  const p = await preview(e);
  e.confirm(p.order.id, p.confirmationToken);
  return p;
}
const base = {
  seed: 42,
  startTime: start,
  volatilityBps: 0,
  driftBps: 0,
  shocks: [{ tick: 12, symbol: "AAPL", changeBps: 300 }],
};
test("paper example parses exact shares, timezone, slippage and bracket; missing fields clarify", async () => {
  const p = await parsePaperPrompt(EXAMPLE);
  assert.equal(p.status, "OK");
  if (p.status !== "OK") return;
  assert.deepEqual(p.draft, {
    symbol: "AAPL",
    quantity: "5",
    entryTime: "10:30",
    expiryTime: "10:35",
    timezone: "America/New_York",
    maxSlippageBps: 50,
    takeProfitBps: 200,
    stopLossBps: 100,
  });
  assert.equal(
    (await parsePaperPrompt("Buy AAPL when it looks good")).status,
    "CLARIFICATION_NEEDED",
  );
  assert.equal(
    (await parsePaperPrompt(EXAMPLE.replace("0.5%", "some"))).status,
    "CLARIFICATION_NEEDED",
  );
  assert.equal(wallTime("2026-11-05", "10:30", "America/New_York"), 1793892600);
  assert.throws(
    () => wallTime("2026-11-01", "01:30", "America/New_York"),
    /ambiguous/,
  );
  assert.throws(
    () => wallTime("2026-03-08", "02:30", "America/New_York"),
    /does not exist/,
  );
});
test("confirmed exact five-share intent enters then exits at take-profit, fees reconcile with cash", async () => {
  const e = new PaperEngine(base);
  await active(e);
  e.step(6);
  let s = e.snapshot();
  assert.equal(s.orders[0]!.status, "OPEN");
  assert.equal(s.fills.length, 1);
  assert.equal(s.fills[0]!.quantity, "5");
  assert.notEqual(
    s.fills[0]!.price,
    s.quotes.find((q) => q.symbol === "AAPL")!.last,
  );
  e.step(6);
  s = e.snapshot();
  assert.equal(s.orders[0]!.status, "COMPLETED");
  assert.equal(s.fills[1]!.reason, "TAKE_PROFIT_BPS");
  assert.equal(s.positions.length, 0);
  assert.ok(Number(s.pnl) > 0);
  assert.equal(s.orders[0]!.pnl, s.pnl);
  assert.equal(e.adapter.kind, "SIMULATED");
  assert.ok(s.fills.every((f) => !("txHash" in f)));
});
test("slippage blocks all fills then entry expires without moving funds", async () => {
  const e = new PaperEngine({ ...base, slippageBps: 80 });
  await active(e);
  e.step(6);
  assert.equal(e.fills.length, 0);
  assert.match(e.orders[0]!.reason, /SLIPPAGE_TOO_HIGH/);
  e.step(30);
  assert.equal(e.orders[0]!.status, "EXPIRED");
  assert.equal(e.snapshot().cash, "25000");
  assert.equal(e.snapshot().positions.length, 0);
  assert.equal(e.fills.length, 0);
});
test("unconfirmed previews never trade; wrong/reused and pre-reset confirmations are rejected", async () => {
  const e = new PaperEngine(base),
    p = await preview(e);
  e.step(12);
  assert.equal(e.fills.length, 0);
  assert.equal(e.orders[0]!.status, "PREVIEW");
  assert.throws(() => e.confirm(p.order.id, "wrong"));
  e.reset(base);
  const newer = await preview(e);
  assert.throws(() => e.confirm(newer.order.id, p.confirmationToken));
  e.confirm(newer.order.id, newer.confirmationToken);
  assert.throws(() => e.confirm(newer.order.id, newer.confirmationToken));
});
test("seed, config, clock and orders reproduce identical synthetic results after reset", async () => {
  const e = new PaperEngine({ ...base, volatilityBps: 8 });
  await active(e);
  e.step(120);
  const first = e.snapshot();
  e.reset({ ...base, volatilityBps: 8 });
  await active(e);
  e.step(120);
  assert.deepEqual(e.snapshot(), first);
  const other = new PaperEngine({ ...base, seed: 43, volatilityBps: 8 });
  await active(other);
  other.step(120);
  assert.notDeepEqual(other.snapshot().history, first.history);
});
test("pause/resume/speed alter pacing, not the price path", () => {
  const e = new PaperEngine(base);
  e.pump();
  assert.equal(e.tick, 0);
  e.control("speed", 40);
  e.control("resume");
  e.pump();
  assert.equal(e.tick, 1);
  e.control("pause");
  e.pump();
  assert.equal(e.tick, 1);
  const other = new PaperEngine(base);
  other.step(1);
  assert.deepEqual(e.snapshot().quotes, other.snapshot().quotes);
});
const replay = {
  mode: "replay",
  startTime: start,
  stepSeconds: 120,
  replay: {
    source: "test tick fixture",
    currency: "USDT",
    ticks: [
      { symbol: "AAPL", timestamp: start, price: "200" },
      { symbol: "AAPL", timestamp: start + 60, price: "200" },
      { symbol: "AAPL", timestamp: start + 90, price: "205" },
      { symbol: "AAPL", timestamp: start + 110, price: "195" },
    ],
  },
};
test("tick replay respects chronological intermediate ticks, hides future data and replays identically", async () => {
  const e = new PaperEngine(replay);
  assert.equal(e.snapshot().history.length, 1);
  assert.equal(e.snapshot().quotes[0]!.last, "200");
  assert.equal(
    e.market.quoteSync(resolveAsset("AAPL")!.stockId, start - 1),
    null,
  );
  assert.equal(e.snapshot().config.replay, undefined);
  await active(e);
  e.step(1);
  const a = e.snapshot();
  assert.equal(a.fills[0]!.timestamp, start + 60);
  assert.equal(a.fills[1]!.timestamp, start + 90);
  assert.equal(a.fills[1]!.reason, "TAKE_PROFIT_BPS");
  e.reset(replay);
  await active(e);
  e.step(1);
  assert.deepEqual(e.snapshot(), a);
});
test("OHLC replay uses declared O-L-H-C policy; low triggers stop before a later high", async () => {
  const e = new PaperEngine({
    mode: "replay",
    startTime: start,
    stepSeconds: 10,
    spreadBps: 0,
    slippageBps: 0,
    feeBps: 0,
    replay: {
      source: "OHLC fixture",
      currency: "USDT",
      candles: [
        {
          symbol: "AAPL",
          timestamp: start,
          durationSeconds: 90,
          open: "200",
          low: "200",
          high: "200",
          close: "200",
        },
        {
          symbol: "AAPL",
          timestamp: start + 91,
          durationSeconds: 90,
          open: "200",
          low: "190",
          high: "210",
          close: "205",
        },
      ],
    },
  });
  await active(e);
  e.step(6);
  assert.equal(e.orders[0]!.entryFill, "200");
  e.step(10);
  assert.equal(e.fills[1]!.reason, "STOP_LOSS_BPS");
  assert.equal(e.fills[1]!.price, "190");
  assert.match(e.snapshot().replayPolicy!, /low/);
});
test("replay rejects invalid OHLC, mixed data and duplicate timestamps; stale quotes block fills", async () => {
  assert.throws(
    () =>
      new PaperEngine({
        ...replay,
        replay: {
          ...replay.replay,
          ticks: [replay.replay.ticks[0], replay.replay.ticks[0]],
        },
      }),
  );
  assert.throws(
    () =>
      new PaperEngine({
        mode: "replay",
        replay: {
          source: "bad",
          currency: "USDT",
          candles: [
            {
              symbol: "AAPL",
              timestamp: start,
              durationSeconds: 60,
              open: "200",
              low: "210",
              high: "220",
              close: "215",
            },
          ],
        },
      }),
  );
  const e = new PaperEngine({
    ...replay,
    stepSeconds: 10,
    maxQuoteAgeSeconds: 1,
    replay: { ...replay.replay, ticks: [replay.replay.ticks[0]] },
  });
  await active(e);
  e.step(36);
  assert.equal(e.fills.length, 0);
  assert.equal(e.orders[0]!.status, "EXPIRED");
});
test("marketplace indicators use observed samples and require enough lookback", () => {
  const ticks = [200, 199, 198, 197].map((p, i) => ({
    symbol: "AAPL",
    timestamp: start + i * 10,
    price: String(p),
  }));
  assert.equal(
    evaluateRule(
      { indicator: "rsi", period: 3, op: "<", value: 30 },
      ticks,
      start + 30,
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      { indicator: "rsi", period: 3, op: "<", value: 30 },
      ticks,
      start + 10,
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      { indicator: "momentum", lookbackDays: 1, op: ">", valuePct: 1 },
      ticks,
      start + 30,
    ),
    false,
  );
});
test("entry failure and stop-loss are accounted independently; ledgers are isolated", async () => {
  const e = new PaperEngine({ ...base, initialBalance: "1" });
  await active(e);
  e.step(6);
  assert.equal(e.orders[0]!.status, "FAILED");
  assert.equal(e.fills.length, 0);
  assert.equal(e.snapshot().cash, "1");
  const other = new PaperEngine(base);
  assert.equal(other.snapshot().cash, "25000");
  assert.equal(other.orders.length, 0);
});
test("simulation fills and strategies operate with all network access forbidden", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("Network forbidden in simulator");
  };
  try {
    const e = new PaperEngine(base);
    await active(e);
    e.step(20);
    assert.equal(e.orders[0]!.status, "COMPLETED");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("configured Claude parser is reused but financial changes and failures cannot override the deterministic draft", async () => {
  let calls = 0;
  const baseline = await parsePaperPrompt(EXAMPLE);
  if (baseline.status !== "OK") throw Error("Parse");
  const parsed = await parsePaperPrompt(EXAMPLE, async () => {
    calls++;
    return JSON.stringify(baseline.draft);
  });
  assert.equal(parsed.status, "OK");
  if (parsed.status === "OK") assert.equal(parsed.parser, "claude");
  assert.equal(calls, 1);
  const wrong = await parsePaperPrompt(EXAMPLE, async () =>
    JSON.stringify({ ...baseline.draft, quantity: "5000" }),
  );
  assert.equal(wrong.status, "OK");
  if (wrong.status === "OK") {
    assert.equal(wrong.parser, "rules");
    assert.equal(wrong.draft.quantity, "5");
  }
});
test("saved marketplace rules use the same paper ledger and require their own confirmation", () => {
  const e = new PaperEngine({
    ...base,
    shocks: [],
    driftBps: -10,
    volatilityBps: 0,
  });
  const r = e.importStrategy(
    {
      schema: "atlas.strategy/v1",
      universe: [{ symbol: "AAPL", weight: 10 }],
      rules: [
        {
          appliesTo: "AAPL",
          when: { indicator: "rsi", period: 3, op: "<", value: 30 },
          then: { action: "buy", sizePct: 50 },
        },
      ],
      risk: { stopLossPct: 1, takeProfitPct: 2, cashBufferPct: 10 },
      execution: { maxSlippageBps: 50 },
    },
    "2026-11-05",
    "America/New_York",
    "10:30",
    "10:35",
  );
  e.step(6);
  assert.equal(e.fills.length, 0);
  const p = r.previews[0]!;
  e.confirm(p.order.id, p.confirmationToken);
  e.step(1);
  assert.equal(e.fills.length, 1);
  assert.match(e.fills[0]!.reason, /rsi/);
  assert.ok(Number(e.snapshot().cash) > 23000);
  assert.throws(() =>
    e.importStrategy(
      {
        schema: "atlas.strategy/v1",
        universe: [{ symbol: "AAPL", weight: 10 }],
        rules: [
          {
            appliesTo: "AAPL",
            when: { indicator: "rsi", period: 3, op: "<", value: 30 },
            then: { action: "sell", sizePct: 50 },
          },
        ],
        risk: { stopLossPct: 1, takeProfitPct: 2, cashBufferPct: 10 },
        execution: { maxSlippageBps: 50 },
      },
      "2026-11-05",
      "America/New_York",
      "10:30",
      "10:35",
    ),
  );
});
test("demo intent wiring never constructs a chain registry even when relayer configuration exists", async () => {
  const { createIntentEngine } = await import("../src/intent/wiring.js");
  const e = createIntentEngine({
    production: false,
    file: ":memory:",
    env: {
      INTENT_DEMO_MODE: "true",
      INTENT_MANAGER_ADDRESS: "0x1111111111111111111111111111111111111111",
      INTENT_EXECUTOR_PRIVATE_KEY: "invalid-key-would-throw-if-loaded",
    },
  });
  assert.equal(e.ctx.registry, undefined);
  e.ctx.repo.close();
});
test("stop loss compares exact price levels without triggering early through rounded P&L", async () => {
  const { evaluateExitConditions } =
    await import("../src/intent/conditions.js");
  const entry = 10000000000n;
  assert.equal(
    evaluateExitConditions(
      [{ type: "STOP_LOSS_BPS", value: 100 }],
      entry,
      9900000001n,
      start,
    ).satisfied,
    false,
  );
  assert.equal(
    evaluateExitConditions(
      [{ type: "STOP_LOSS_BPS", value: 100 }],
      entry,
      9900000000n,
      start,
    ).satisfied,
    true,
  );
});
test("paper execution adapter is idempotent per execution ID", async () => {
  const e = new PaperEngine(base),
    a = resolveAsset("AAPL")!;
  const r = {
    executionId: "paper-1:BUY",
    intentId: "paper-1",
    kind: "ENTRY" as const,
    side: "BUY" as const,
    user: "paper",
    stockId: a.stockId,
    exchange: a.exchange,
    referencePrice: 20000000000n,
    quantity: 5n * 10n ** 18n,
    now: start,
  };
  const first = await e.adapter.execute(r);
  const repeated = await e.adapter.execute({
    ...r,
    referencePrice: 30000000000n,
  });
  assert.deepEqual(first, repeated);
});
