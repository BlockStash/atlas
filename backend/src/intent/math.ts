import { PRICE_SCALE, QTY_SCALE, BPS } from "./types.js";

/** Parse a decimal string into a bigint with `decimals` fractional digits (no floats, truncating nothing). */
export function parseDecimal(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`Invalid decimal: ${value}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`Too many decimals: ${value}`);
  return BigInt(m[1]! + frac.padEnd(decimals, "0"));
}
export function formatDecimal(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = (neg ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = abs.slice(0, abs.length - decimals);
  const frac = abs.slice(abs.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
export const parseUSDT = (v: string) => parseDecimal(v, 6);
export const formatUSDT = (v: bigint) => formatDecimal(v, 6);
export const parsePrice = (v: string) => parseDecimal(v, 8);
export const formatPrice = (v: bigint) => formatDecimal(v, 8);
export const formatQty = (v: bigint) => formatDecimal(v, 18);

export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Quantity (1e18) purchasable for a USDT notional (1e6) at a price (1e8). Rounded down. */
export const quantityFor = (notional: bigint, price: bigint) =>
  (notional * 10n ** 20n) / price;
/** USDT value (1e6) of a quantity (1e18) at a price (1e8). */
export const valueOf = (quantity: bigint, price: bigint, up = false) =>
  up ? ceilDiv(quantity * price, 10n ** 20n) : (quantity * price) / 10n ** 20n;
/** Signed P&L in bps relative to entry; integer arithmetic only (floor toward -inf). */
export function pnlBps(entry: bigint, current: bigint): bigint {
  const n = (current - entry) * BPS;
  return n >= 0n ? n / entry : -ceilDiv(-n, entry);
}
export const priceAtBps = (entry: bigint, deltaBps: bigint) =>
  (entry * (BPS + deltaBps)) / BPS;
/** bigint percent with 2 decimals, e.g. 7234n/10000n -> "72.34" */
export const percentString = (num: bigint, den: bigint) =>
  den === 0n ? "0" : formatDecimal((num * 10_000n) / den, 2);
export { PRICE_SCALE, QTY_SCALE };
