import "dotenv/config";
import { resolve } from "node:path";
import { ArkivProfileStore, UnavailableProfileStore } from "./arkiv-store.js";
import type { ProfileRepository } from "./profile-repository.js";
import { createApp } from "./app.js";
import { createPortfolioReader } from "./protocol/portfolio.js";
import { createIntentEngine } from "./intent/wiring.js";
const production = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 4000);
let store: ProfileRepository | undefined;
if (process.env.PROFILE_STORE === "arkiv") {
  try {
    store = new ArkivProfileStore({
      rpcUrl: process.env.ARKIV_RPC_URL || "",
      accessKey: process.env.ARKIV_ACCESS_KEY,
      chainId: Number(process.env.ARKIV_CHAIN_ID),
      privateKey: process.env.ARKIV_PRIVATE_KEY || "",
      signerAddress: process.env.ARKIV_SIGNER_ADDRESS,
      encryptionKey: process.env.ARKIV_ENCRYPTION_KEY || "",
      namespace: process.env.ARKIV_NAMESPACE || "atlas-poc",
      maxFeeWei: process.env.ARKIV_MAX_TX_FEE_WEI
        ? BigInt(process.env.ARKIV_MAX_TX_FEE_WEI)
        : undefined,
      claimsFile: resolve(
        process.env.IDENTITY_CLAIMS_FILE || "data/world-id-claims.sqlite",
      ),
      legacyFile: resolve(process.env.DATA_FILE || "data/profiles.json"),
    });
  } catch {
    store = new UnavailableProfileStore(
      "Arkiv setup is incomplete. Configure ARKIV_PRIVATE_KEY matching ARKIV_SIGNER_ADDRESS and ARKIV_ENCRYPTION_KEY on the Atlas backend.",
    );
  }
}
const portfolioRead = createPortfolioReader();
const intents = createIntentEngine({ production, portfolioRead });
if (process.env.INTENT_WORKER_ENABLED !== "false")
  intents.worker.start(Number(process.env.INTENT_WORKER_INTERVAL_MS || 5000));
const app = createApp({
  intents,
  portfolioRead,
  store,
  dataFile: resolve(process.env.DATA_FILE ?? "data/profiles.json"),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://127.0.0.1:3000",
  demoWallet: process.env.DEMO_WALLET === "true",
  demoWorldId: process.env.DEMO_WORLD_ID === "true",
  production,
  passkeyRpId: process.env.PASSKEY_RP_ID || undefined,
  worldId: {
    appId: process.env.WORLD_ID_APP_ID || "",
    rpId: process.env.WORLD_ID_RP_ID || "",
    action: process.env.WORLD_ID_ACTION || "verify-human",
    signingKey: process.env.WORLD_ID_SIGNING_KEY || "",
    environment:
      process.env.WORLD_ID_ENVIRONMENT === "staging" ? "staging" : "production",
  },
});
const server = app.listen(port, () =>
  console.log(`Atlas API listening on http://localhost:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
