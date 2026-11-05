export type PortfolioPosition = {
  stockId: string;
  countryContract: string;
  symbol: string;
  name: string;
  market: string;
  marketName: string;
  country: string;
  exchange: string;
  quantity: string;
  priceUSDT: string | null;
  valueUSDT: string | null;
  priceUpdatedAt: number | null;
  priceValidUntil: number | null;
  status: "fresh" | "stale" | "disabled";
};
export type PortfolioPoint = {
  timestamp: number;
  blockNumber: number;
  valueUSDT: string;
};
export type PortfolioSnapshot = {
  source: "sepolia";
  address: string;
  chainId: number;
  blockNumber: number;
  timestamp: number;
  settlementToken: string;
  vault: string;
  tradingEngine: string;
  walletUSDT: string;
  vaultShares: string;
  vaultAssets: string;
  walletETH: string;
  cashValueUSDT: string;
  stockValueUSDT: string | null;
  totalValueUSDT: string | null;
  positions: PortfolioPosition[];
  history: PortfolioPoint[];
};
export function formatPortfolioAmount(
  raw: string,
  decimals: number,
  digits = 6,
) {
  const n = BigInt(raw),
    negative = n < 0n,
    absolute = negative ? -n : n,
    scale = 10n ** BigInt(decimals);
  const whole = (absolute / scale).toLocaleString("en-US");
  const fractional = (absolute % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, digits)
    .replace(/0+$/, "");
  if (
    absolute > 0n &&
    absolute < scale &&
    fractional === "" &&
    digits < decimals
  ) {
    const threshold = digits > 0 ? `0.${"0".repeat(digits - 1)}1` : "1";
    return negative ? `>-${threshold}` : `<${threshold}`;
  }
  return `${negative ? "-" : ""}${whole}${fractional ? "." + fractional : ""}`;
}
export function portfolioAtTime(snapshot: PortfolioSnapshot, now: number) {
  const positions = snapshot.positions.map((p) =>
    p.priceValidUntil !== null && p.priceValidUntil < now
      ? { ...p, priceUSDT: null, valueUSDT: null, status: "stale" as const }
      : p,
  );
  const stockValue = positions.some((p) => p.valueUSDT === null)
    ? null
    : positions.reduce((sum, p) => sum + BigInt(p.valueUSDT!), 0n);
  return {
    ...snapshot,
    positions,
    stockValueUSDT: stockValue?.toString() ?? null,
    totalValueUSDT:
      stockValue === null
        ? null
        : (BigInt(snapshot.cashValueUSDT) + stockValue).toString(),
  };
}
export function portfolioHistory(
  history: PortfolioPoint[],
  period: string,
  now: number,
) {
  const seconds: Record<string, number> = {
    "1D": 86400,
    "1W": 604800,
    "1M": 2592000,
    "1Y": 31536000,
  };
  return period === "ALL"
    ? history
    : history.filter(
        (point) => point.timestamp >= now - (seconds[period] ?? 0),
      );
}
