import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import catalog from "../protocol/catalog.json" with { type: "json" };
import { referencePrices } from "../protocol/market-feed.js";
import type { IntentRepository } from "./repository.js";
import { assetByStockId } from "./assets.js";
import { calculateSlippage } from "./slippage.js";
import { TRADING_FEE_BPS } from "./simulation.js";
import {
  BPS,
  IntentError,
  type PortfolioView,
  type PriceQuote,
} from "./types.js";
import {
  ceilDiv,
  formatPrice,
  parseDecimal,
  parsePrice,
  quantityFor,
  valueOf,
} from "./math.js";
import { marketState } from "./market-engine.js";
import type { MarketState } from "./types.js";

/** Prices older than this are never traded on (the display feed tolerates days; trading does not). */
export const MAX_PRICE_AGE_S = Number(
  process.env.INTENT_MAX_PRICE_AGE_S || 900,
);

export interface PriceSource {
  quote(stockId: string, now: number): Promise<PriceQuote | null>;
}

/** Live-ish prices from the existing market-feed cache (Twelve Data / Kraken), converted to USDT. */
export class FeedPriceSource implements PriceSource {
  constructor(
    private file = resolve(
      process.env.MARKET_FEED_CACHE_FILE || "data/market-feed.json",
    ),
  ) {}
  async quote(stockId: string, now: number): Promise<PriceQuote | null> {
    if (!existsSync(this.file)) return null;
    let rows;
    try {
      rows = referencePrices(this.file, now);
    } catch {
      throw new IntentError(
        "RPC_ERROR",
        "Price feed unavailable.",
        503,
        undefined,
        true,
      );
    }
    const row = rows.find(
      (r) => r.stockId.toLowerCase() === stockId.toLowerCase(),
    );
    const a = assetByStockId(stockId);
    if (!row || !a) return null;
    return {
      stockId: a.stockId,
      nativePrice: "",
      nativeCurrency: a.currency,
      priceUSDT: formatPrice(BigInt(row.priceUSDT)),
      updatedAt: row.timestamp,
      isStale: now - row.timestamp > MAX_PRICE_AGE_S,
      source: row.source,
    };
  }
}

/**
 * Deterministic fixture prices from the Atlas catalog. Clearly marked source "demo".
 * `multiplierBps` lets the investor demo move a price (10000 = unchanged).
 */
export class DemoPriceSource implements PriceSource {
  private mult = new Map<string, bigint>();
  setMultiplierBps(stockId: string, bps: number) {
    if (!Number.isInteger(bps) || bps < 100 || bps > 100_000)
      throw new IntentError("INVALID_INTENT", "Multiplier out of range.", 422);
    this.mult.set(stockId.toLowerCase(), BigInt(bps));
  }
  reset() {
    this.mult.clear();
  }
  async quote(stockId: string, now: number): Promise<PriceQuote | null> {
    const s = catalog.stocks.find(
      (x) => x.stockId.toLowerCase() === stockId.toLowerCase(),
    );
    if (!s) return null;
    const fx = (catalog.fx as Record<string, string>)[s.nativeCurrency];
    if (!fx) return null;
    const native = parsePrice(s.demoNativePrice);
    const usd = (native * parsePrice(fx)) / 10n ** 8n;
    const price = (usd * (this.mult.get(stockId.toLowerCase()) ?? BPS)) / BPS;
    return {
      stockId: s.stockId.toLowerCase(),
      nativePrice: s.demoNativePrice,
      nativeCurrency: s.nativeCurrency,
      priceUSDT: formatPrice(price),
      updatedAt: now,
      isStale: false,
      source: "demo",
    };
  }
}

/** Live feed first; in demo mode fall back to fixtures so the flow works offline. */
export class CompositePriceSource implements PriceSource {
  constructor(
    private live: PriceSource,
    private demo?: PriceSource,
    private preferDemo = false,
  ) {}
  async quote(stockId: string, now: number) {
    if (this.demo && this.preferDemo) return this.demo.quote(stockId, now);
    const q = await this.live.quote(stockId, now).catch((e) => {
      if (!this.demo) throw e;
      return null;
    });
    return q ?? (this.demo ? this.demo.quote(stockId, now) : null);
  }
}

export interface MarketSource {
  state(exchange: string, now: number): MarketState;
}
export class CalendarMarketSource implements MarketSource {
  /** Demo control: force every exchange open. Never used outside demo mode. */
  forceOpen = false;
  constructor(
    private allowForce = false,
    /** Atlas markets run 24/7 (see marketsAlwaysOpen); false applies exchange hours. */
    private alwaysOpen = false,
  ) {}
  state(exchange: string, now: number): MarketState {
    const s = marketState(exchange, now);
    if (this.alwaysOpen)
      return {
        ...s,
        open: true,
        reason: "OPEN",
        nextOpen: null,
        nextClose: null,
      };
    if (this.allowForce && this.forceOpen && !s.open)
      return {
        ...s,
        open: true,
        reason: "OPEN",
        nextOpen: null,
        nextClose: now + 3600,
      };
    return s;
  }
}

export interface ExecutionRequest {
  executionId: string;
  intentId: string;
  kind: "ENTRY" | "EXIT";
  side: "BUY" | "SELL";
  user: string;
  stockId: string;
  exchange: string;
  referencePrice: bigint;
  /** BUY: USDT notional to spend. SELL: quantity to sell (1e18). */
  notionalUSDT?: bigint;
  quantity?: bigint;
  /** The strategy's slippage limit; live execution bounds shares spent/received by it. */
  maxSlippageBps?: number;
  now: number;
}
export interface ExecutionResult {
  txHash: string | null;
  fillPrice: bigint;
  quantity: bigint;
  notionalUSDT: bigint;
  feeUSDT: bigint;
  slippageBps: number;
}
/** The only component that moves value. Must be idempotent on `executionId`. */
export interface ExecutionAdapter {
  readonly kind: "SIMULATED" | "ONCHAIN";
  execute(req: ExecutionRequest): Promise<ExecutionResult>;
}

/**
 * Deterministic demo executor backed by the local ledger. It does NOT touch Sepolia.
 * A real adapter needs a delegated entry point on the trading engine that checks AtlasIntentManager
 * (the current engine only trades for msg.sender), so none is provided here.
 */
export class SimulatedExecutionAdapter implements ExecutionAdapter {
  readonly kind = "SIMULATED" as const;
  constructor(private repo: IntentRepository) {}
  async execute(r: ExecutionRequest): Promise<ExecutionResult> {
    const prior = this.repo.execution(r.intentId, r.kind);
    if (prior)
      return {
        txHash: prior.tx_hash,
        fillPrice: parsePrice(prior.price_usdt),
        quantity: BigInt(prior.quantity),
        notionalUSDT: BigInt(prior.notional_usdt),
        feeUSDT: BigInt(prior.fee_usdt),
        slippageBps: prior.slippage_bps,
      };
    const hash = keccak256(toUtf8Bytes(r.executionId));
    const txHash = `simulated:${hash.slice(0, 18)}`;
    if (r.side === "BUY") {
      const spend = r.notionalUSDT ?? 0n;
      const slip = calculateSlippage(spend, r.exchange);
      const fill =
        r.referencePrice + ceilDiv(r.referencePrice * BigInt(slip), BPS);
      const quantity = quantityFor(spend, fill);
      if (quantity <= 0n)
        throw new IntentError(
          "TRADE_REVERTED",
          "Order size rounds to zero.",
          422,
        );
      const cost = valueOf(quantity, fill, true);
      return {
        txHash,
        fillPrice: fill,
        quantity,
        notionalUSDT: cost,
        feeUSDT: ceilDiv(cost * TRADING_FEE_BPS, BPS),
        slippageBps: slip,
      };
    }
    const quantity = r.quantity ?? 0n;
    const gross = valueOf(quantity, r.referencePrice);
    const slip = calculateSlippage(gross, r.exchange);
    const fill = r.referencePrice - (r.referencePrice * BigInt(slip)) / BPS;
    const proceeds = valueOf(quantity, fill);
    return {
      txHash,
      fillPrice: fill,
      quantity,
      notionalUSDT: proceeds,
      feeUSDT: ceilDiv(proceeds * TRADING_FEE_BPS, BPS),
      slippageBps: slip,
    };
  }
}

/** Starting vault balance for the investor-demo ledger. */
export const DEMO_START_USDT = parseDecimal(
  process.env.INTENT_DEMO_START_USDT || "25000",
  6,
);

/** Demo portfolio derived from executions (cash + quantities) priced at current quotes. */
export async function ledgerPortfolio(
  repo: IntentRepository,
  prices: PriceSource,
  user: string,
  now: number,
): Promise<PortfolioView> {
  const { cash, qty } = repo.ledger(user);
  const positions: PortfolioView["positions"] = [];
  let stockValue = 0n;
  for (const [stockId, q] of qty) {
    if (q <= 0n) continue;
    const quote = await prices.quote(stockId, now);
    const a = assetByStockId(stockId);
    const v = quote ? valueOf(q, parsePrice(quote.priceUSDT)) : 0n;
    stockValue += v;
    positions.push({
      stockId,
      country: a?.country ?? "??",
      valueUSDT: v,
      quantity: q,
    });
  }
  const vault = DEMO_START_USDT + cash;
  return {
    totalValueUSDT: vault + stockValue,
    vaultAssetsUSDT: vault > 0n ? vault : 0n,
    walletUSDT: 0n,
    positions,
    activeIntents: repo.countActive(user),
  };
}
