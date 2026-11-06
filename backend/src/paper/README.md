# Atlas Paper Trading simulator

Run the normal Atlas development server with `npm run dev` from the repository root. Open **http://127.0.0.1:3000/paper**, connect an Atlas wallet session (or use the existing demo login), and keep this screen open while running a simulation. No LLM API key is needed.

## Repository findings and reuse

- Existing market data: `protocol/market-feed.ts` and `twelve-rest.ts` receive Twelve Data/Kraken observations; `price-service.ts` provides demo/HTTP snapshots and normalization; `historical-development.ts` publishes fixed dated test quotes to Sepolia. **The paper simulator never invokes these publishers.**
- Instrument registry: `intent/assets.ts`, backed by `protocol/catalog.json`, contains the 50 supported stock IDs, symbols, listing currencies and exchanges. Synthetic initial prices use the existing catalog's demo prices and fixture FX. They are simulated USDT values, not current market observations.
- Existing intent flow: `intent/parser.ts`, `service.ts`, `worker.ts`, `repository.ts`, `simulation.ts`, and `adapters.ts` implement parsing, risk preview, signed approval, evaluation and a SQLite demo execution ledger. Its V1 allocation is USDT-based and has no exact-share order field.
- Existing UI: `/intent`, `/intent/new`, `/trade`, `/portfolio` and `/strategies/*`. `frontend/src/lib/strategies.ts` explicitly implements a localStorage marketplace mock, including its old paper/live performance curves.
- New `market.ts` implements the existing `PriceSource` and `ExecutionAdapter` interfaces. `engine.ts` reuses `evaluateEntryConditions` and `evaluateExitConditions`; exact-share paper orders use their own wallet-scoped ledger rather than changing the existing signed V1 allocation schema. The paper prompt parser reuses the existing Claude transport when configured. The new `/paper` screen and marketplace link provide the review/confirmation flow.
- `strategy.ts` evaluates supported marketplace rule definitions on the same observed price timeline and executes through the same paper ledger. It does not reuse the marketplace's fabricated performance curves.

## Provider integration audit

| Provider         | Findings                                                                                                                                                                                                                                                                                              | Configuration                                                                                                         | Runtime verification                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI           | No direct SDK dependency, provider module, server route, or application call found in root/backend/frontend/admin manifests and application sources. No placeholder environment variables found in the checked templates.                                                                             | None found                                                                                                            | No integration to verify                                                                                                                                |
| Anthropic Claude | Wired, beyond a placeholder: `intent/parser.ts` sends Messages requests to `https://api.anthropic.com/v1/messages`; `intent/wiring.ts` injects the client into `IntentService`. The paper router reuses that transport. A standalone Anthropic SDK is not required: this code uses server-side fetch. | `ANTHROPIC_API_KEY`, `INTENT_AI_MODEL` in `backend/.env.example`. Existing configured default model name is retained. | The parser and transport boundary are tested with injected responses; no paid/provider API call, account entitlement or model availability was verified |

Claude can only parse/validate instructions. In the paper parser, every field—including quantity, percentage, local time and timezone—must match deterministic extraction. Provider errors or conflicting output fall back to the deterministic parser. Missing required values request clarification instead of inventing defaults. Price generation, indicators, triggers, guards, fees and fills never use a model.

## Walkthrough

1. Select **Entry & take-profit demo**. This resets the session to November 5, 2026, 10:29 America/New_York, paused, with 25,000 paper USDT. The test configuration includes a labelled 3% AAPL shock at tick 12; it is deliberately a scenario, not a market forecast.
2. Leave the supplied instruction and selected date unchanged. Click **Preview paper intent**.
3. Review the exact five shares, 10:30 entry, New York timezone, 0.5% maximum slippage, +2% take-profit, −1% stop-loss and 10:35 entry expiry. Check the authorization box and click **Confirm & activate Paper Trading**. A preview alone cannot fill.
4. Click **Advance 120 ticks**, or resume the clock. Entry occurs at 10:30 and the scenario reaches take-profit at 10:31. Inspect status, event history, fills, fees, positions and net P&L.
5. Select **Slippage expiry demo**, preview and explicitly confirm again, then advance 120 ticks. Its 80 bps impact exceeds the confirmed 50 bps cap, so entry is blocked and expires at 10:35 with zero fills and unchanged cash.
6. Use **Step**, **Pause**, **Resume** and the speed selector. Speed is simulated seconds per real second; it changes pacing only. Manual stepping is available while paused. Applying configuration resets the timeline, orders, confirmation tokens and balance.

Offline scenario command:

```sh
npm run paper:demo
```

This asserts a completed entry/exit, a slippage-blocked expiry and byte-for-byte-equivalent replay snapshots after reset, then prints fills and balances. Default successful scenario: buy 5 AAPL at 270.40522684, sell at 277.96248051, net +35.044427 paper USDT including fees. These are deterministic fixture results, not historical performance.

## Market and fill assumptions

- Synthetic: fixed ticks, integer price arithmetic, seed + symbol + tick determine bounded noise. `volatilityBps` is the maximum uniform per-tick perturbation, not annualized volatility. `driftBps` adds a per-tick trend. `regimes` override drift/noise over inclusive tick ranges; first matching regime wins. A zero-drift low-volatility regime models sideways periods. `shocks` add a specified bps change at a specified tick, optionally for one symbol. This is a transparent scenario model, not calibrated venue microstructure.
- The synthetic price path covers all 50 stocks. Paper markets operate continuously for development; actual exchange calendars do not gate fills. The UI always shows simulation time and source.
- Prices use 8 decimals, quantities 18, cash/fees 6; exact share quantities are preserved. Buy is ask plus configured impact; sell is bid minus impact. The displayed bid/ask excludes impact. Half-spread rounds up to whole basis points (an odd configured spread therefore yields an effective spread one bps wider).
- Slippage is measured against the current displayed last price and **includes spread plus impact**. Cross-multiplication checks the confirmed cap before changing cash, quantity, order status or recording any fill. The cap applies to entry and exit. An exit blocked by slippage keeps the position open; entry expiry does not force-close a position.
- Entry conditions are ANDed. Exit conditions are ORed, with stop-loss before take-profit if simultaneous. Targets are based on the **actual entry fill**, not the preview or the last quote. Triggers do not guarantee fill prices: a gap can execute beyond a target/stop at the next observed executable price. Fees apply on both sides. Cash is debited only when sufficient for the full order plus fee; there are no partial fills, shorts or margin.
- Entries expire at `now >= expiry`; expiry applies only to an unfilled entry. `maxQuoteAgeSeconds` blocks execution from old replay observations. No future ticks or future candle fields are returned in snapshots. At the same timestamp, all instrument updates are applied before orders evaluate, in order-creation order. Entry is evaluated once per observed step; a newly opened position is first considered for exit on a subsequent step.
- Realized P&L includes both fees; open position mark-to-market includes paid entry fees and values remaining shares at last price, with no assumed exit fee. P&L is paper USDT, not aUSDT vault shares.

Example synthetic configuration (advanced JSON panel):

```json
{
  "mode": "synthetic",
  "seed": 42,
  "startTime": 1793892540,
  "stepSeconds": 10,
  "initialBalance": "25000",
  "volatilityBps": 8,
  "driftBps": 0,
  "spreadBps": 4,
  "slippageBps": 5,
  "feeBps": 10,
  "regimes": [
    { "fromTick": 1, "untilTick": 60, "driftBps": 1, "volatilityBps": 6 },
    { "fromTick": 61, "untilTick": 120, "driftBps": 0, "volatilityBps": 2 },
    { "fromTick": 121, "untilTick": 180, "driftBps": -1, "volatilityBps": 10 }
  ],
  "shocks": [{ "tick": 12, "symbol": "AAPL", "changeBps": 300 }]
}
```

## Historical replay input

Atlas's saved Stock Analysis snapshot has session opening/closing prices and previous close, not a timestamped intraday series or complete OHLC. It cannot reconstruct the example's 10:30–10:35 historical trading window. Supply your own dataset using **Load tick or OHLC replay JSON**. The downloadable sample (`frontend/public/paper-replay-example.json`) is clearly labelled illustrative, not real historical data. Upload sets the clock to the earliest observation; select the matching strategy date before previewing.

Tick format:

```json
{
  "source": "Your licensed dataset / observation provenance",
  "currency": "USDT",
  "ticks": [
    { "symbol": "AAPL", "timestamp": 1793892540, "price": "200" },
    { "symbol": "AAPL", "timestamp": 1793892600, "price": "200" },
    { "symbol": "AAPL", "timestamp": 1793892660, "price": "205" }
  ]
}
```

Unix timestamps are seconds; prices are positive decimal strings (max eight decimals). Prices must already be USDT, with provenance for any FX/USDT conversion. The backend does not silently assume native currencies equal USDT. Unknown symbols, duplicates and overlapping same-symbol timestamps are rejected. Input is sorted; events are consumed chronologically, including intermediate events when clock steps exceed the interval between records. Only observations at or before the clock are available.

Alternatively provide `candles` instead of `ticks`:

```json
{
  "source": "Your OHLC dataset",
  "currency": "USDT",
  "candles": [
    {
      "symbol": "AAPL",
      "timestamp": 1793892540,
      "durationSeconds": 90,
      "open": "200",
      "low": "198",
      "high": "205",
      "close": "203"
    }
  ]
}
```

A candle's `timestamp` is its start. Because OHLC does not reveal intrabar order, Atlas explicitly assumes **open → low → high → close**, at start, one-third, two-thirds and end respectively. There is no interpolation or guaranteed threshold fill between these points. For an existing long position, a candle touching both stop and target visits the low first; the stop wins and fills at the low's executable price. If entry happens later in that assumed path, only subsequent path points can trigger its exit. Future high/low/close points are hidden until their assumed time. This is a deterministic approximation; use tick replay for observed ordering. Consecutive candles for a symbol must not repeat the preceding close timestamp as the next open timestamp; offset the next start by at least one second.

## Existing marketplace strategies

The strategy detail page links to `/paper`; its saved strategies appear in the import selector. Import creates previews, never live deployments. Supported subset: up to 20 registered stock assets, nonnegative target weights totaling at most 100%, at most one buy/increase rule, and explicit non-null take-profit/stop-loss. Sell/reduce, multiple rules, crypto assets and missing bracket parameters are rejected rather than approximated. Allocation applies paper cash × (1 − cash buffer) × target weight × rule size; quantity is rounded down to eight share decimals. Weights are percentages reused against **paper USDT**, not actual aUSDT balances. The UI discloses the subset before import.

Supported indicators are simple window RSI, SMA crossover, momentum and drawdown. RSI/SMA periods count observed samples. RSI uses summed gains/losses over the specified window (not Wilder smoothing). Momentum/drawdown use real simulation elapsed days, not ticks renamed as days. Insufficient lookback is no signal. Up to 50,000 past observations are retained per session, shared by symbols; rules needing more history will not trigger. The bridge tests one initial allocation plus a bracket exit; portfolio rebalancing, creator fees and repeat cycles are not implemented. The old marketplace mock performance and the onchain Atlas holdings remain separate.

## Isolation and limits

`/api/paper/*` requires an authenticated Atlas session and is unavailable in production. Each wallet has its own in-memory engine, initial balance, orders and positions. The paper module has no registry, signer, RPC, wallet transport or live execution dependency. Normal demo intents now also skip `chainRegistry`, even if relayer credentials exist. No `executionMode=live` option is accepted. A one-use server token binds confirmation to the stored preview; reset invalidates old tokens. Live portfolio and order endpoints are never invoked.

Sessions expire after two hours of inactivity and are lost on backend restart. Maximum 50 sessions, 200 intents per session, 20,000 replay ticks or 5,000 candles, and a 2 MB request body. The snapshot shows the latest 1,000 observed points; this display limit does not change evaluation history. Export/download of complete sessions and durable paper persistence are not implemented. The synthetic price path and explicit clock/order commands reproduce exactly; wall-clock timing of interactive clicks is not a substitute for replaying the same commands at the same simulated time. Confirmation tokens intentionally differ after reset, while the fills, ledger, timeline and public snapshots reproduce.

## Checks

```sh
npm test --prefix backend
npm run test:wallet
npm run typecheck --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend -- --webpack
npm run paper:demo
```

Tests cover successful entry/exit and fee reconciliation, slippage-blocked expiry, no execution before confirmation, invalid/reused/reset tokens, wrong-wallet access, production refusal, rejection of live mode, no live portfolio/network calls, clock pacing, seeded reset repeatability, chronological/no-lookahead replay, identical replay reruns, OHLC stop ordering, stale/invalid inputs, timezone/DST ambiguity, exact stop thresholds, marketplace indicators, and the reused Claude boundary without credentials. Browser interaction was unavailable in the implementation session; API tests and frontend compilation were verified instead.
