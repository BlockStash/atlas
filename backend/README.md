# Atlas API

TypeScript/Express API for the Atlas investor experience. No real securities trading, deposits, withdrawals, financial accounts, or identity documents are implemented. The frontend wallet can send Sepolia test ETH directly through MetaMask. Market prices, market statuses, portfolio and token balances are demo data.

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

| Method | Path               | Request                      | Response                                            |
| ------ | ------------------ | ---------------------------- | --------------------------------------------------- |
| GET    | `/health`          | —                            | status, demo feature availability                   |
| POST   | `/auth/challenge`  | `{address}`                  | `{message, expiresAt}`                              |
| POST   | `/auth/verify`     | `{address, signature}`       | `{wallet, profile}` + session cookie                |
| POST   | `/auth/demo`       | `{}`                         | `{wallet, profile}` + demo session, only if enabled |
| GET    | `/auth/session`    | cookie                       | `{wallet, profile}`, otherwise 401                  |
| POST   | `/auth/logout`     | cookie                       | `{ok:true}`, clears session                         |
| GET    | `/profile`         | cookie                       | profile                                             |
| PUT    | `/profile`         | cookie + partial preferences | updated profile                                     |
| POST   | `/world-id/verify` | cookie + `{demo:true}`       | `{verified:true,demo:true,profile}` when enabled    |
| GET    | `/markets`         | —                            | `{demo:true, markets:[…]}`                          |
| GET    | `/portfolio`       | cookie                       | demo portfolio, balances, history, positions        |

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
- Financial balances come from `src/data.ts`. Replace the portfolio balance adapter with trusted contract/RPC reads to integrate actual ERC-20 balances.

## POC Arkiv and ENS extensions

The runtime accepts a `ProfileRepository` adapter. `PROFILE_STORE=arkiv` selects `ArkivProfileStore`; it requires `ARKIV_RPC_URL`, `ARKIV_CHAIN_ID`, `ARKIV_SIGNER_ADDRESS`, its matching `ARKIV_PRIVATE_KEY`, and `ARKIV_ENCRYPTION_KEY`. Profiles are encrypted before Arkiv writes; only service-owned/service-created rows are trusted. See the root README for Rabdi configuration, retention, migration and the database check script. `PROFILE_STORE=local` (or an unset driver in isolated tests) selects the JSON adapter. World ID nullifiers have a persistent transactional uniqueness ledger, backed by SQLite, in both adapters.

| Method | Path                        | Behavior                                                                                                      |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/ens/resolve?name=...` | Normalizes a name and resolves its Sepolia ETH record.                                                        |
| POST   | `/api/auth/challenge`       | Optional `ensName` must resolve to the submitted address; name is included in the signed challenge.           |
| POST   | `/api/auth/verify`          | Verifies the wallet signature and re-resolves the ENS name to catch record changes; saves the validated link. |
| POST   | `/api/profile/ens`          | Authenticated `{name}`; verifies its address record matches the connected real wallet and saves the link.     |
| DELETE | `/api/profile/ens`          | Removes the profile link without changing any onchain records.                                                |
| GET    | `/api/storage/status`       | Authenticated storage driver/readiness and public signer address.                                             |

`ensName`, `ensChainId` and `ensVerifiedAt` are server-owned profile fields. General `PUT /profile` rejects attempts to modify them. Login and mapping use backend RPC resolution, so client claims cannot substitute a different wallet address. The frontend uses ENSjs and viem to prepare wallet-approved Sepolia registration transactions; the backend never holds the user's MetaMask private key.
