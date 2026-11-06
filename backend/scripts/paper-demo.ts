import assert from "node:assert/strict";
import { PaperEngine } from "../src/paper/engine.js";
import { parsePaperPrompt, EXAMPLE } from "../src/paper/parser.js";
async function activate(e: PaperEngine) {
  const parsed = await parsePaperPrompt(EXAMPLE);
  assert.equal(parsed.status, "OK");
  if (parsed.status !== "OK") throw Error("parse");
  const p = e.preview(parsed.draft, "2026-11-05");
  e.confirm(p.order.id, p.confirmationToken);
}
const config = {
  seed: 42,
  startTime: 1793892540,
  driftBps: 0,
  volatilityBps: 4,
  shocks: [{ tick: 12, symbol: "AAPL", changeBps: 300 }],
};
const success = new PaperEngine(config);
await activate(success);
success.step(120);
assert.equal(success.orders[0]!.status, "COMPLETED");
const blocked = new PaperEngine({ ...config, slippageBps: 80 });
await activate(blocked);
blocked.step(120);
assert.equal(blocked.orders[0]!.status, "EXPIRED");
assert.equal(blocked.fills.length, 0);
const replayConfig = {
  mode: "replay",
  startTime: 1793892540,
  replay: {
    source: "Illustrative replay fixture, not actual historical ticks",
    currency: "USDT",
    ticks: [
      { symbol: "AAPL", timestamp: 1793892540, price: "200" },
      { symbol: "AAPL", timestamp: 1793892600, price: "200" },
      { symbol: "AAPL", timestamp: 1793892660, price: "205" },
    ],
  },
};
const replay = new PaperEngine(replayConfig);
await activate(replay);
replay.step(20);
const first = replay.snapshot();
replay.reset(replayConfig);
await activate(replay);
replay.step(20);
assert.deepEqual(replay.snapshot(), first);
console.log(
  JSON.stringify(
    {
      successfulStrategy: {
        status: success.orders[0]!.status,
        fills: success.fills,
        netPnlUSDT: success.snapshot().pnl,
      },
      blockedStrategy: {
        status: blocked.orders[0]!.status,
        fills: blocked.fills.length,
        cash: blocked.snapshot().cash,
        events: blocked.orders[0]!.events,
      },
      replay: { identical: true, fills: first.fills },
    },
    null,
    2,
  ),
);
