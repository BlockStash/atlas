# Atlas API

TypeScript/Express API for Atlas identity, profiles and portfolio reads. Deposits, withdrawals and synthetic stock trades execute against Sepolia contracts through the user's wallet. The frontend also supports Sepolia test ETH transfers. Market overview indices/statuses remain illustrative. `/portfolio` reads actual settlement-token, vault-share and ERC-1155 stock balances for the authenticated wallet; it does not return sample balances or positions.

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

API: `http://localhost:4000`. The Next frontend proxies `/api/*` here. For a standalone frontend client, set `FRONTEND_ORIGIN` to its exact origin; credentials must be included on requests. For a frontend proxy, browser Origin must also match this setting. Both demo flags default to **false** when omitted, and both are forcibly disabled when `NODE_ENV=production`.

```sh
npm run typecheck
npm test
npm run build
npm start
```

## API contract

All endpoints start with `/api`. Failures return `{ "error": { "code": "…", "message": "…" } }`. Wallet auth signs a Sepolia (chain 11155111) challenge and uses a 24-hour HttpOnly, SameSite=Lax cookie. Secure cookies are enforced in production.

| Method | Path               | Request                      | Response                                                                    |
| ------ | ------------------ | ---------------------------- | --------------------------------------------------------------------------- |
| GET    | `/health`          | —                            | status, demo feature availability                                           |
| POST   | `/auth/challenge`  | `{address}`                  | `{message, expiresAt}`                                                      |
| POST   | `/auth/verify`     | `{address, signature}`       | `{wallet, profile}` + session cookie                                        |
| POST   | `/auth/demo`       | `{}`                         | `{wallet, profile}` + demo session, only if enabled                         |
| GET    | `/auth/session`    | cookie                       | `{wallet, profile}`, otherwise 401                                          |
| POST   | `/auth/logout`     | cookie                       | `{ok:true}`, clears session                                                 |
| GET    | `/profile`         | cookie                       | profile                                                                     |
| PUT    | `/profile`         | cookie + partial preferences | updated profile                                                             |
| POST   | `/world-id/verify` | cookie + `{demo:true}`       | `{verified:true,demo:true,profile}` when enabled                            |
| GET    | `/markets`         | —                            | `{demo:true, markets:[…]}`                                                  |
| GET    | `/portfolio`       | cookie                       | onchain wallet balances, stock positions and observed account-value history |

Wallet: `{address, network, demo}`. Real sign-in network is Sepolia. The frontend confirms network chain ID `0xaa36a7` before authentication. Demo sessions receive random per-visitor addresses, preventing preferences from leaking between demo visitors.

Profile:

```ts
{
  walletAddress: string;
  selectedMarkets: ('india'|'usa'|'uk'|'china'|'europe')[];
  preferredAsset: 'USDT'|'ATLAS';
  experienceLevel: 'beginner'|'intermediate'|'advanced';
  currentStep: number; // 0 through 5
  worldIdVerified: boolean;
  worldIdVerifiedDemo: boolean;
  onboardingComplete: boolean;
  productTourComplete: boolean;
  updatedAt: string;
}
```

`PUT /profile` permits only selectedMarkets, preferredAsset, experienceLevel, currentStep, onboardingComplete and productTourComplete. The wallet identity and verification flags are server-owned. Completing onboarding requires server-recorded verification. Preferences use the configured ProfileRepository. The Arkiv adapter stores encrypted entities; the explicit local adapter uses serialized atomic file replacement under DATA_FILE (default data/profiles.json, ignored by Git).

## Integration and deployment limits

- Wallet challenges contain an origin, random nonce, chain, issued time and five-minute expiry. The server verifies the signature against the saved challenge. Challenges are one-use, including failed attempts. Never request private keys or seed phrases.
- Sessions, rate limits and pending challenges are in memory. A server restart requires signing in again; profile preferences remain saved. Run one process for the JSON-file store. A replicated deployment needs a transactional database, shared sessions/rate limits and a hardened proxy configuration.
- `src/world-id.ts` signs World ID 4.x RP requests with `@worldcoin/idkit-core/signing` and verifies proofs through the official v4 API. Configure `WORLD_ID_APP_ID`, `WORLD_ID_RP_ID`, `WORLD_ID_ACTION`, `WORLD_ID_SIGNING_KEY` and `WORLD_ID_ENVIRONMENT` in the server environment. Missing configuration returns 503. Proofs must match a session-owned one-use nonce, configured environment/action, proof-of-human credential and signed-in wallet signal. Nullifier claims persist atomically and cannot link to multiple wallets. Production rejects demo and staging proofs.
- Production requires HTTPS, the correct frontend origin, a persistent volume for profile storage (or a database adapter), and valid World ID portal configuration before allowing live onboarding completion. Market sessions shown by `/markets` are explicitly fixed presentation data, not exchange-calendar data.
- Portfolio balances come from `src/protocol/portfolio.ts` using the configured v2 deployment and one block per snapshot. Amounts are integer strings (USDT 6, aUSDT 12, stock/ETH 18, quote prices 8 decimals). Missing/stale quotes preserve quantities but make the current valuation unavailable. Recorded observations use `PORTFOLIO_HISTORY_FILE` or `data/portfolio-history.sqlite`. No fabricated fallback balance or historical returns are returned.

## Real prices: Twelve Data + Kraken

The feed worker receives stock/native-currency prices and native/USD FX from Twelve Data, plus actual USDT/USD trades from Kraken. It combines WebSockets with paced REST quote polling and writes an atomic backend-only cache. The existing price publisher converts fresh data into Atlas's eight-decimal prices and submits it to the configured country proxies. The portfolio continues to use confirmed Sepolia quotes; receiving a provider quote by itself does not update the contracts or the portfolio valuation.

Add these settings to the existing `backend/.env` (preserve your other settings):

```dotenv
PRICE_SOURCE=twelvedata-kraken
TWELVE_DATA_API_KEY=your_server_only_key
MARKET_FEED_CONFIG=./config/market-feed.json
MARKET_FEED_CACHE_FILE=./data/market-feed.json
PRICE_PUBLISH_INTERVAL_SECONDS=300
```

From the repository root, keep the worker running in a separate terminal:

```sh
npm run prices:feed
```

Then check the fresh observations without a private key or blockchain transaction:

```sh
npm run prices:check
```

The mapping in `backend/config/market-feed.json` enables **all 10 onboarded US stocks**. AAPL uses WebSockets; the others use REST (`stream: false`) to work with Basic's trial-symbol restrictions. Add verified entries `{stockId, symbol, exchange, currency, stream?}` for other active onchain stocks. `stockId` identifies the deployed Atlas stock; `symbol` and `exchange` identify the provider instrument, which can differ from the Atlas ticker. Each mapping's currency must match the contract's native currency. Subscriptions automatically include the required `INR/USD`, `GBP/USD`, `SGD/USD` or `EUR/USD` FX pairs. USD/USD is the identity 1. No stocks are inferred from a ticker alone. Restart the worker after changing mappings or credentials, and run only one worker per cache file.

REST requests are spaced at least nine seconds apart, with a 700-request UTC daily budget persisted beside the cache. Quotes refresh every ten minutes when the provider reports an open market and hourly when closed; recent WebSocket observations skip REST requests. HTTP 429 pauses REST for 15 minutes. A startup pass for ten stocks takes about 90 seconds. Other API consumers using the same key also consume its provider quota. Existing international markets need verified symbols and appropriate entitlements before enabling them.

Twelve Data may reject instruments depending on your plan and exchange permissions. A successful subscription does not guarantee ticks while its market is closed. GBX (pence) quotes cannot currently be substituted for GBP quotes; the worker rejects currency mismatches. Add an explicitly verified unit conversion before enabling such instruments. FX streaming is implemented and tested with recorded-format messages; the US-only configuration does not exercise a live FX subscription.

To automate publication, create a dedicated test wallet, give it Sepolia ETH, and use the owner/admin dashboard to grant its address `PRICE_UPDATER_ROLE` on each configured country market. Store its key only as `PRICE_UPDATER_PRIVATE_KEY` in `backend/.env`. Do not reuse an Arkiv or World ID signing key. With the feed still running:

```sh
npm run prices:update  # one publication pass; sends Sepolia transactions
npm run prices:watch   # subsequent continuous publishing; choose one publisher process
```

The 300-second interval avoids a transaction for every tick. Newer observations are published, existing/older observations are skipped, and the country's `maxPriceAge` remains enforced. The worker reconnects with backoff, sends heartbeats, validates prices/timestamps/currencies, and never replaces missing prices with demo fixtures or stamps old quotes as fresh. Market closure or a feed outage eventually makes the quote expire.

`GET /api/protocol/market-prices` provides indicative provider reference prices for stock discovery. It converts the original quote using FX and Kraken USDT/USD, retains the oldest stock/FX observation timestamp, and requires a USDT observation within 15 minutes. References older than seven days are omitted. Market drawers and trading tables display these timestamps when an executable onchain price is unavailable. Reference prices do not enable the order form, enter executable quote calculations, or replace the portfolio's onchain valuation. REST observations use `last_quote_at`, rather than the time of the HTTP request or the daily candle's opening timestamp.

Keep `npm run dev` running and open your actual portfolio after a successful publication. Portfolio observations are saved when `/api/portfolio` is read. A line needs at least two valid observations from distinct blocks; this integration does not fabricate earlier history or backfill pre-purchase account values. Arkiv continues storing identity profiles; trades and published quotes remain on Sepolia. No contract redeployment is required.

Provider references: [Twelve Data WebSockets](https://twelvedata.com/docs/websocket/websocket-getting-started), [exchange access](https://twelvedata.com/exchanges?level=overview), [Kraken public trade stream](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade). Keep the Twelve Data key on the server and check external-display entitlements before publishing the application publicly.

## Historical references for all 50 stocks

`GET /api/protocol/stock-sessions` serves `config/web-market-reference.json`: a dated research snapshot with recorded session close, session opening price, the preceding close, native currency, original quote units, source URL and retrieval time. The initial snapshot covers November 5, 2026 sessions, with preceding closes from November 4. Records were researched on November 6 in India (the retrieval timestamp is stored in UTC). These are manually researched historical observations; the application does not continuously query Google or scrape financial pages. Refresh the snapshot through a new source review when newer historical sessions are needed. `WEB_REFERENCE_FILE` can select a replacement JSON with the same schema.

Sources were discovered through web search and read from each listing’s Stock Analysis historical-data page, with an exact source link retained per stock. Original pence prices are stored alongside normalized GBP values and validated at a 100:1 conversion. All records are checked against the seeded stock ID, exchange, ticker and native currency; duplicate IDs, future dates, unsupported units and inconsistent conversions are rejected. New onchain stocks without a researched record remain unrecorded rather than receiving sample values.

The same response attaches current exchange status from Twelve Data’s `market_state` endpoint. The backend caches one all-exchange response for at most 15 minutes, expires it at the next reported opening/closing boundary, coalesces concurrent requests, and persists the cache in `MARKET_STATUS_FILE` (default `data/market-status.json`). Expired/missing data displays status unavailable. This metadata endpoint works on the configured Basic account even when non-US price endpoints require another plan. Status calls have a separate persisted cap of 96/day, keeping the combined status and quote worker budgets within 796 requests/day; other users of the same key also consume provider quota.

Market drawers, country cards, the global open-count and the trading table use these references/statuses. Historical values stay in native currency and are never treated as USDT trading quotes, published to Sepolia, used to enable orders, or substituted for portfolio valuations. Quotes for execution continue through the existing authorised price publisher. No deployment is required for this display feature.

## POC Arkiv and ENS extensions

The runtime accepts a `ProfileRepository` adapter. `PROFILE_STORE=arkiv` selects `ArkivProfileStore`; it requires `ARKIV_RPC_URL`, `ARKIV_CHAIN_ID`, `ARKIV_SIGNER_ADDRESS`, its matching `ARKIV_PRIVATE_KEY`, and `ARKIV_ENCRYPTION_KEY`. Profiles are encrypted before Arkiv writes; only service-owned/service-created rows are trusted. See the root README for Rabdi configuration, retention, migration and the database check script. `PROFILE_STORE=local` (or an unset driver in isolated tests) selects the JSON adapter. World ID nullifiers have a persistent transactional uniqueness ledger, backed by SQLite, in both adapters.

Set `ARKIV_ACCESS_KEY` to a free key from [Arkiv Hub](https://hub.arkiv.network/access-keys) to avoid the heavily rate-limited public Rabdi endpoint. When `ARKIV_RPC_URL` is the bare official Rabdi URL, the adapter automatically uses the keyed URL from `rabdi({accessKey})`; an explicitly configured custom RPC or keyed URL is preserved. Restart the backend after editing `.env`. Both the app and `npm run arkiv:check` use this configuration. RPC calls have a six-second timeout with no automatic transport retries so failed profile reads return JSON 503 errors before the frontend proxy's timeout. No local profile fallback is used when Arkiv is selected.

| Method | Path                        | Behavior                                                                                                      |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/ens/resolve?name=...` | Normalizes a name and resolves its Sepolia ETH record.                                                        |
| POST   | `/api/auth/challenge`       | Optional `ensName` must resolve to the submitted address; name is included in the signed challenge.           |
| POST   | `/api/auth/verify`          | Verifies the wallet signature and re-resolves the ENS name to catch record changes; saves the validated link. |
| POST   | `/api/profile/ens`          | Authenticated `{name}`; verifies its address record matches the connected real wallet and saves the link.     |
| DELETE | `/api/profile/ens`          | Removes the profile link without changing any onchain records.                                                |
| GET    | `/api/storage/status`       | Authenticated storage driver/readiness and public signer address.                                             |

`ensName`, `ensChainId` and `ensVerifiedAt` are server-owned profile fields. General `PUT /profile` rejects attempts to modify them. Login and mapping use backend RPC resolution, so client claims cannot substitute a different wallet address. The frontend uses ENSjs and viem to prepare wallet-approved Sepolia registration transactions; the backend never holds the user's MetaMask private key.
