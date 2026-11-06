import { ceilDiv } from "./math.js";

/** Deterministic demo liquidity profiles (USDT depth per exchange). Replace with venue data when it exists. */
export const LIQUIDITY_PROFILES: Record<
  string,
  { depthUSDT: bigint; baseBps: number }
> = {
  NASDAQ: { depthUSDT: 5_000_000n * 10n ** 6n, baseBps: 2 },
  NYSE: { depthUSDT: 5_000_000n * 10n ** 6n, baseBps: 2 },
  NSE: { depthUSDT: 1_500_000n * 10n ** 6n, baseBps: 4 },
  LSE: { depthUSDT: 1_200_000n * 10n ** 6n, baseBps: 4 },
  XETRA: { depthUSDT: 1_200_000n * 10n ** 6n, baseBps: 4 },
  "Euronext Amsterdam": { depthUSDT: 800_000n * 10n ** 6n, baseBps: 5 },
  "Euronext Paris": { depthUSDT: 800_000n * 10n ** 6n, baseBps: 5 },
  SGX: { depthUSDT: 400_000n * 10n ** 6n, baseBps: 6 },
};
const FALLBACK = { depthUSDT: 200_000n * 10n ** 6n, baseBps: 10 };

/** slippageBps = base + ceil(notional * 100 / depth). Pure function of its inputs: no randomness. */
export function calculateSlippage(
  notionalUSDT: bigint,
  exchange: string,
): number {
  const p = LIQUIDITY_PROFILES[exchange] ?? FALLBACK;
  return p.baseBps + Number(ceilDiv(notionalUSDT * 100n, p.depthUSDT));
}
export const isLowLiquidity = (notionalUSDT: bigint, exchange: string) => {
  const p = LIQUIDITY_PROFILES[exchange] ?? FALLBACK;
  return notionalUSDT * 100n >= p.depthUSDT * 2n; // order > 2% of modeled depth
};
