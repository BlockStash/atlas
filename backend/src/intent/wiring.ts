import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import abis from "../protocol/abis.json" with { type: "json" };
import type { PortfolioSnapshot } from "../protocol/portfolio.js";
import {
  CalendarMarketSource,
  CompositePriceSource,
  DemoPriceSource,
  FeedPriceSource,
  SimulatedExecutionAdapter,
  ledgerPortfolio,
} from "./adapters.js";
import { aiConfigured, anthropicModel } from "./parser.js";
import { IntentRepository } from "./repository.js";
import { limitsFromEnv } from "./risk.js";
import {
  IntentService,
  type EngineContext,
  type IntentRegistry,
} from "./service.js";
import { ExecutionWorker } from "./worker.js";
import type { PortfolioView } from "./types.js";

export interface IntentEngine {
  service: IntentService;
  worker: ExecutionWorker;
  ctx: EngineContext;
}

export function snapshotToView(
  s: PortfolioSnapshot,
  activeIntents: number,
): PortfolioView {
  return {
    totalValueUSDT: BigInt(s.totalValueUSDT ?? s.cashValueUSDT),
    vaultAssetsUSDT: BigInt(s.vaultAssets),
    walletUSDT: BigInt(s.walletUSDT),
    positions: s.positions.map((p) => ({
      stockId: p.stockId,
      country: p.country,
      quantity: BigInt(p.quantity),
      valueUSDT: BigInt(p.valueUSDT ?? "0"),
    })),
    activeIntents,
  };
}

/** Thin ethers wrapper over AtlasIntentManager. Enabled only when address + relayer key are configured. */
export function chainRegistry(env = process.env): IntentRegistry | undefined {
  const address = env.INTENT_MANAGER_ADDRESS,
    key = env.INTENT_EXECUTOR_PRIVATE_KEY;
  if (!address || !key) return undefined;
  const provider = new JsonRpcProvider(
    env.PROTOCOL_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  );
  const c = new Contract(
    address,
    abis.AtlasIntentManager,
    new Wallet(key, provider),
  );
  return {
    activate: async (auth, sig) => {
      const tx = await c.activateIntent!(auth, sig);
      await tx.wait();
      return tx.hash as string;
    },
    cancel: async (id) => void (await (await c.cancelIntent!(id)).wait()),
    markExecuted: async (id) => void (await (await c.markExecuted!(id)).wait()),
    markCompleted: async (id) =>
      void (await (await c.markCompleted!(id)).wait()),
  };
}

export function createIntentEngine(o: {
  production: boolean;
  portfolioRead?: (address: string) => Promise<PortfolioSnapshot>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  file?: string;
}): IntentEngine {
  const env = o.env ?? process.env;
  const now = o.now
    ? () => Math.floor(o.now!() / 1000)
    : () => Math.floor(Date.now() / 1000);
  // Demo defaults on outside production; production must opt in explicitly (and still has no live adapter).
  const demoMode = env.INTENT_DEMO_MODE
    ? env.INTENT_DEMO_MODE === "true"
    : !o.production;
  const repo = new IntentRepository(
    o.file ?? resolve(env.INTENT_DB_FILE || "data/intents.sqlite"),
  );
  const demoPrices = demoMode ? new DemoPriceSource() : undefined;
  const prices = new CompositePriceSource(new FeedPriceSource(), demoPrices);
  const markets = new CalendarMarketSource(demoMode);
  const portfolio = async (user: string): Promise<PortfolioView> => {
    if (demoMode) return ledgerPortfolio(repo, prices, user, now());
    if (!o.portfolioRead) throw new Error("Portfolio reader unavailable");
    return snapshotToView(await o.portfolioRead(user), repo.countActive(user));
  };
  const ctx: EngineContext = {
    repo,
    now,
    prices,
    markets,
    portfolio,
    limits: limitsFromEnv(env),
    demoMode,
    domain: {
      chainId: 11155111,
      verifyingContract:
        env.INTENT_MANAGER_ADDRESS ||
        "0x0000000000000000000000000000000000000000",
    },
    adapter: new SimulatedExecutionAdapter(repo),
    model: aiConfigured() ? anthropicModel() : undefined,
    registry: demoMode ? undefined : chainRegistry(env),
    demoPrices,
    demoMarkets: demoMode ? markets : undefined,
  };
  return {
    service: new IntentService(ctx),
    worker: new ExecutionWorker(ctx),
    ctx,
  };
}
