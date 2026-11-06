# Atlas AI Intent Trading Engine

```
prompt → parser (AI or rules) → zod schema → catalog resolution → normalizer
       → validator → risk engine → simulation → preview → user confirm
       → EIP-712 signature → activation → worker (entry → monitor → exit)
```

The model only answers "what did the user mean?". Everything after `parser.ts` is deterministic TypeScript.
The model has no tools, no keys and no network access to contracts. Its output is untrusted text.

| Module | Role |
| --- | --- |
| `types.ts` | zod schemas, status/error enums, intent types |
| `parser.ts` | system prompt, JSON extraction, **grounding check**, rule-based fallback grammar, normalization |
| `validator.ts` | schema, catalog, contradictory rules, expiry, market data |
| `risk.ts` | limits (`RiskLimits`), concentration/exposure, warnings. Violations reject; the AI cannot override |
| `simulation.ts`, `slippage.ts` | deterministic estimates (demo liquidity profiles, no randomness) |
| `market-engine.ts` | IANA time zones via `Intl` (DST-safe), weekends, a partial holiday table |
| `conditions.ts` | `evaluateEntryConditions`, `evaluateExitConditions` |
| `canonical.ts` | canonical JSON, `strategyHash`, EIP-712 typed data, signer recovery |
| `repository.ts` | sqlite (`node:sqlite`): `trade_intents`, `intent_events`, `positions`, `trade_executions`, `notifications` |
| `service.ts` | parse / create / activate / cancel / close |
| `worker.ts` | DB-backed execution loop |
| `adapters.ts` | price sources, market source, `ExecutionAdapter`, demo ledger |
| `router.ts`, `wiring.ts` | `/api/intents/*`, env wiring |

Contract: `contracts/src/AtlasIntentManager.sol` (EIP-712 + `SignatureChecker`, `AccessControl`, `Pausable`, nonce bitmap,
custom errors, no loops/delegatecall/tx.origin). It holds no funds.

## Guarantees

- **No AI → trade path.** `create` persists `AWAITING_APPROVAL`. Only `activate` with a valid signature over the
  server-built message makes a strategy `ACTIVE`. The server rebuilds the message from stored values, so a client
  cannot change what was previewed. Identity, id and time are always server-set.
- **Grounding.** Every number the model emits (allocation, %, prices, slippage) must appear in the user's text, else
  `AI_PARSE_FAILED`. Malformed or off-schema JSON is rejected, never repaired. Unknown symbols are rejected.
- **Ambiguity** returns `CLARIFICATION_NEEDED` with options (appended to the prompt).
  Defaults (1% slippage, 24h validity) are listed in `metadata.defaultsApplied` and shown in the UI.
- **Hash.** `keccak256("ATLAS_INTENT_V1:" + canonicalJSON(strategy))`. Keys sorted, condition lists sorted, decimals
  trimmed, integers only. The id, user, prompt and timestamps are excluded.
- **Replay.** Per-user nonce (`UNIQUE(user,nonce)`), CAS status transitions, contract `nonceUsed`.
- **Idempotent execution.** Per-intent lease, `UPDATE … WHERE status IN (…)` compare-and-set, and
  `UNIQUE(intent_id, kind)` on `trade_executions`; the adapter returns the prior fill for a repeated `executionId`.
  Entry/exit state change and fill are written in one transaction.
- **Cancel vs execute.** Both race on the same CAS. Exactly one wins. After `EXECUTING`, cancel is refused; use
  "Close position" (manual close has top priority).

## Rules worth knowing

- Entry conditions are ANDed. The exchange must be open to trade regardless of conditions.
- Exits are ORed. **Priority:** manual close > stop loss > take profit > price exits > time exit.
- Exits never use a stale price and wait for the market to open. An open position keeps retrying its exit
  (backoff capped at 5 min); entries fail after 5 transient retries.
- Not retried: invalid signature, expiry, insufficient balance, risk rejection, reverted trade.
- `SELL` allocation `PORTFOLIO_PERCENT` means percent **of the held position**. A SELL with exit rules takes a reference
  price when its entry rules are met, then monitors against it.
- Trading price max age: `INTENT_MAX_PRICE_AGE_S` (default 900). The display feed tolerates days; trading does not.

## Known limitations (read before production)

1. **Execution is simulated.** `AtlasCountryTradingEngine.buy/sell` act on `msg.sender`, so a backend cannot trade from a
   user's wallet. A real `ExecutionAdapter` needs a delegated entry point on the engine that checks
   `AtlasIntentManager.isActive(intentId)` and the signed `maxSpendUSDT` / `maxSlippageBps`. That is a contract change
   and audit, so it was not made. With `INTENT_DEMO_MODE=false`, `create` returns 501 until an `ONCHAIN` adapter exists.
2. The on-chain mirror (`chainRegistry`) is wired but untested against a deployed contract. It is off unless
   `INTENT_MANAGER_ADDRESS` and `INTENT_EXECUTOR_PRIVATE_KEY` are set; failures never block the off-chain lifecycle.
3. The holiday table in `market-engine.ts` is partial. Combine it with the Twelve Data market-state service before relying on it.
4. No China exchange: the Atlas catalog has no China listings.
5. The slippage model is a deterministic stand-in for venue depth.
6. In-process worker + sqlite suits a single host. Multiple workers on one DB file are safe (leases + CAS);
   multiple hosts need a networked DB.

## Demo mode

`INTENT_DEMO_MODE` (backend, default on outside production) and `NEXT_PUBLIC_INTENT_DEMO_MODE` (frontend label).
Fixture prices fall back when the live feed has none, positions live in a ledger seeded with
`INTENT_DEMO_START_USDT`, demo-wallet sessions may use a `DEMO` signature, and `/api/intents/demo/*`
(move price, force market open, run worker) are enabled. Every demo strategy is labelled "Investor Demo" and
`executionMode: "SIMULATED"`. Demo signatures are refused in production or for non-demo wallets.
