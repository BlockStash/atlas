# ATLAS

**Global Markets. One Wallet.**

Atlas combines MetaMask authentication on **Sepolia**, **World ID 4.x IDKit** QR verification, **ENSjs** identity, and encrypted profile storage on **Arkiv Rabdi**. The current v2 protocol adds six-decimal demo USDT, an ERC-4626 vault and five upgradeable ERC-1155 market contracts holding 50 initial stock IDs. It supports new-stock onboarding, native/FX/USD-USDT pricing and reserve-funded trades. These are demo synthetic assets with no legal equity ownership. Dashboard, portfolio and wallet balances are read from the signed-in wallet’s Sepolia contracts.

The v2 country architecture needs a new Sepolia deployment; existing per-stock ERC-20 contracts cannot be converted in place. Follow [the protocol guide](contracts/README.md). Existing deployments and holdings are preserved. Until a v2 manifest is configured, protocol pages display a setup message.

## Run locally

Requires Node.js 22.13+, npm, and [Foundry](https://getfoundry.sh/) for contract compilation and testing. Solidity is pinned to 0.8.33; the wrapper also supports a locally installed matching `solc`.

```sh
npm run setup
# Configure World ID in backend/.env as described below.
npm run dev
```

Open **http://127.0.0.1:3000**. The frontend proxies `/api/*` to port 4000. Use the 127.0.0.1 address consistently with `FRONTEND_ORIGIN`. Stop both servers with Ctrl+C.

To run separately, use `npm run dev --prefix backend` and `npm run dev --prefix frontend` in two terminals. For protocol setup, deployment, role configuration, test-token distribution and price refreshes, see [contracts/README.md](contracts/README.md). The user routes are `/vault` and `/trade`; the separate `admin/` application runs at **http://127.0.0.1:3001** using `npm run dev:admin`. The old `/admin` bookmark redirects there. World ID and ENS keep their existing login flow.

## Configure real World App verification

1. Create an app at [World Developer Portal](https://developer.world.org), enable World ID 4.0/RP registration, and create an action (for example, `verify-human`). Configure the app for World App verification and the intended development origin.
2. Put your portal values in **backend/.env**:

```dotenv
WORLD_ID_APP_ID=app_your_app_id
WORLD_ID_RP_ID=rp_your_rp_id
WORLD_ID_ACTION=verify-human
WORLD_ID_SIGNING_KEY=your_server_only_rp_signing_key
WORLD_ID_ENVIRONMENT=production
DEMO_WORLD_ID=false
DEMO_WALLET=false
```

3. In **frontend/.env.local**, keep:

```dotenv
NEXT_PUBLIC_DEMO_WORLD_ID=false
NEXT_PUBLIC_DEMO_WALLET=false
NEXT_PUBLIC_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

4. Restart the servers. Connect MetaMask, approve Sepolia, sign the login challenge, and select **Continue with World ID**. Scan IDKit's QR code with World App or follow its mobile link. You need a World ID with a proof-of-human credential (the Orb-compatible preset supports current and legacy proof formats).

The app cannot enable real World App verification without your portal app ID, RP ID, action and RP signing key. The signing key stays on the backend; never prefix it with `NEXT_PUBLIC_` or commit it. The client receives only a short-lived signed request. The server verifies the complete proof with World, checks its wallet signal, action, environment and one-use nonce, and persists a wallet-scoped nullifier claim. A credential already linked to another wallet is rejected. Reconnect the same wallet to restore its verification.

**World ID environment and Ethereum network are separate settings.** `production` means real World App proofs; transactions still use Sepolia exclusively. For the official World ID simulator, set `WORLD_ID_ENVIRONMENT=staging` and use the portal's matching test configuration. Staging proofs are labelled as simulator proofs, and production server mode rejects them.

Official references: [IDKit React](https://docs.world.org/world-id/idkit/react), [RP signatures](https://docs.world.org/world-id/idkit/signatures), [server verification](https://docs.world.org/api-reference/developer-portal/verify).

## ENS login, linking, and name creation

The login modal now offers **Login with ENS**, **Link existing ENS**, and **Create new ENS**, alongside MetaMask. All ENS interactions use **Sepolia**, independently of Arkiv's Rabdi database network.

- **Login with ENS:** enter your name, let Atlas resolve it, then connect that wallet in MetaMask and sign the login challenge. The backend independently checks the ENS record before issuing the challenge and again before accepting its signature. A public name alone cannot sign in.
- **Link existing ENS:** connect MetaMask and enter a name that resolves to the connected account. Atlas verifies it on the backend and stores the link in your profile. Linking does not change ENS ownership or onchain records. Unlinking only removes the Atlas association.
- **Create new ENS:** check a `.eth` name, review the owner, one-year term and live token price, then approve each step in MetaMask: deploy your personal resolver (initialized with your address record), commit the name, wait the registrar's onchain minimum, mint test USDC if needed, approve the exact quoted payment and register. After confirmation, link the new name to Atlas. The price is checked again before sending; transactions are restricted to Sepolia. Test ETH is needed for gas.

Registration secrets and pending transaction hashes are retained in this browser so registration can resume after refresh. Keep this browser's storage until registration completes. If a transaction is pending, use **Check transaction** rather than sending the same step again. A replaced/cancelled transaction should be checked in MetaMask; do not restart registration until its status is clear.

ENS linking/creation is also available under **Wallet → Your ENS identity** after onboarding. Names created here have a forward address record; Atlas can display the verified linked name without changing your wallet's onchain primary/reverse name.

## Arkiv profile database

Atlas uses the official `@arkiv-network/sdk` against the configured Rabdi development network:

```dotenv
PROFILE_STORE=arkiv
ARKIV_RPC_URL=https://rpc.rabdi.db-chain.testnet.arkiv.network
ARKIV_CHAIN_ID=7794095
ARKIV_SIGNER_ADDRESS=0xB9B85F4b79671A95365CF60F1767F63D4B8F1040
ARKIV_PRIVATE_KEY=the_matching_server_only_private_key
ARKIV_ENCRYPTION_KEY=64_hex_characters
ARKIV_NAMESPACE=atlas-poc
IDENTITY_CLAIMS_FILE=./data/world-id-claims.sqlite
```

These belong in `backend/.env`; the backend signing key must match the public signer address. Atlas checks the chain and signer before writes. Back up `ARKIV_ENCRYPTION_KEY`: it is required to decrypt profiles. The local environment has a generated encryption key; `.env.example` leaves secret values empty. The backend signer needs Rabdi test tGLM from the [Arkiv faucet](https://hub.arkiv.network/faucet). A public RPC is supported; an [Arkiv access-key URL](https://hub.arkiv.network/access-keys) can replace it if rate limits affect the demo.

Profile payloads are AES-256-GCM encrypted. Wallet and identity query tags are keyed hashes, and reads filter both owner and creator to the configured service signer. Preferences, ENS links and World ID verification state are stored in Arkiv entities with a 30-day lifetime, extended on updates. Existing local profiles migrate on their next successful save. There is no silent local fallback when Arkiv is selected but unreachable or misconfigured.

Arkiv schemas do not provide atomic SQL uniqueness constraints. A small, persistent SQLite ledger therefore enforces the **World ID replay constraint**, using a unique `(scope, nullifier)` key and full-precision decimal strings (up to 78 digits). Profiles remain in Arkiv. An identity tag is also checked against the service-owned Arkiv records. Keep the ledger on persistent disk and run one backend writer for this POC; replicated production instances require a shared transactional replay ledger. Expiration of an Arkiv profile never expires the local identity claim.

```sh
# Network, balance, signer-match and typed query checks; no writes:
npm run arkiv:check
# Temporary encrypted entity create/read/update/delete check:
npm run arkiv:check --prefix backend -- --write
```

The Arkiv development MCP is listed as connected in this environment, but it exposes no callable tools to this chat. Runtime database operations use the SDK directly and do not depend on the MCP connection.

## Test ENS and a Sepolia transaction

1. Connect your real MetaMask account and complete World App verification and onboarding.
2. Fund that account with test ETH using a [Sepolia faucet](https://ethereum.org/en/developers/docs/networks/#sepolia).
3. Open **Wallet**. The Sepolia panel shows the real test ETH balance, separate from illustrative token balances.
4. Enter a recipient `0x` address or an ENS name that has an ETH address record **on Sepolia**. Mainnet ENS records are not used as a fallback. The header and wallet panel also display a forward-confirmed Sepolia primary name when available.
5. Enter a small amount, select **Review test transfer**, and inspect the resolved recipient address, network, amount and estimated maximum gas fee.
6. Select **Approve in MetaMask** and approve the transaction there. Follow the transaction hash on Sepolia Etherscan. The app tracks pending, confirmed, reverted, and cancelled/replaced transactions; a saved pending hash can resume confirmation tracking after refresh.

ENS uses `@ensdomains/ensjs` with Sepolia's SDK-provided contracts and normalized names. Use **Create new ENS** in Atlas to register a Sepolia test name. See [ENS app developer guidance](https://docs.ens.domains/ensv2/tutorial-app-developers/).

Both transaction preparation and submission check the active Sepolia chain (11155111 / `0xaa36a7`) and wallet account. The wallet must approve every transfer. No private keys or seed phrases are collected.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
# With the local app running:
npm run test:smoke
```

Automated tests cover authentication, World ID, ENS, encrypted profiles, exact price normalization/history, vault accounting, access control, trading, stale feeds, liquidity limits and adversarial token behavior. Foundry includes fuzz and stateful invariant tests. Live World App verification and MetaMask signing require interactive testing. The explicit local protocol smoke command in the protocol guide broadcasts only to Anvil.

## Project structure and persistence

- `frontend/`: Next.js, React, TypeScript, Tailwind, Framer Motion, MetaMask Connect EVM, World ID IDKit, ENSjs and viem.
- `backend/`: Express, signed wallet sessions, World ID verification, Arkiv profiles, price ingestion and SQLite price history.
- `contracts/`: country UUPS proxies/implementation, shared vault/token/trading engine, legacy contracts, Foundry tests, deployment scripts and ABIs.
- `admin/`: independent React/Vite country-management dashboard; owner permissions, stocks, price feeds, treasury and upgrades.
- `scripts/`: setup, combined dev launcher and HTTP smoke checks.

Profiles are stored encrypted in Arkiv when `PROFILE_STORE=arkiv`; `backend/data/profiles.json` remains the explicit local-development adapter and migration source. Identity replay claims use the durable SQLite ledger. Preferences are also mirrored to localStorage. Sessions and pending challenges are memory-resident and expire after 24 hours / five minutes respectively. Restarting the backend requires wallet sign-in again. Use a transactional database and shared sessions before running multiple backend instances.

The old investor simulation remains available only if both frontend and backend demo flags are explicitly enabled in development. Simulated verification cannot enable the Sepolia transfer form. See [backend/README.md](backend/README.md) for the API contract.

## Actual wallet portfolio

The dashboard, My portfolio and Wallet pages use authenticated `/api/portfolio` reads from the configured v2 Sepolia deployment. They show actual wallet USDT, proportional vault claims, ERC-1155 stock quantities and test ETH. There is no sample ATLAS balance, sample portfolio total or generated performance chart. ETH is shown separately from the USDT total.

All balances and quotes in a snapshot use one block. The page refreshes every 20 seconds, on window focus and after confirmed protocol transactions. The server uses a short wallet/deployment-scoped cache. If a quote expires or a stock is disabled, the quantity remains visible and the current stock/total valuation is marked unavailable. RPC failures show an error rather than fabricating zero balances.

Historical account-value observations are stored in `backend/data/portfolio-history.sqlite` (override with `PORTFOLIO_HISTORY_FILE`). History starts with actual observations; old performance is not reconstructed or invented. Charts include deposits and transfers and are not investment-return calculations. World ID/passkey identity profiles remain in Arkiv.
