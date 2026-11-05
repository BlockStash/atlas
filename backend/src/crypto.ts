import { VerificationError } from "./world-id.js";

/** Simulated crypto market. Prices are illustrative; nothing settles on-chain. */
export type CryptoCategory =
  "Layer 1" | "Layer 2" | "DeFi" | "Oracle" | "Stablecoin" | "Real-world asset";

export interface CryptoAsset {
  symbol: string;
  name: string;
  category: CryptoCategory;
  color: string;
  /** USD price with 6 decimals, as an integer string. */
  priceMicros: string;
  change24h: number;
}

const usd = (value: string) => {
  const [whole = "0", fraction = ""] = value.split(".");
  return (
    BigInt(whole) * 1_000_000n +
    BigInt(fraction.padEnd(6, "0").slice(0, 6))
  ).toString();
};

export const cryptoAssets: CryptoAsset[] = [
  {
    symbol: "BTC",
    name: "Bitcoin",
    category: "Layer 1",
    color: "#f2a33a",
    priceMicros: usd("97240.15"),
    change24h: 1.84,
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    category: "Layer 1",
    color: "#8fa2f5",
    priceMicros: usd("3612.48"),
    change24h: 2.31,
  },
  {
    symbol: "SOL",
    name: "Solana",
    category: "Layer 1",
    color: "#9b7cf0",
    priceMicros: usd("214.62"),
    change24h: -0.92,
  },
  {
    symbol: "BNB",
    name: "BNB",
    category: "Layer 1",
    color: "#e9c349",
    priceMicros: usd("642.10"),
    change24h: 0.44,
  },
  {
    symbol: "XRP",
    name: "XRP",
    category: "Layer 1",
    color: "#9fb0c4",
    priceMicros: usd("2.18"),
    change24h: -1.37,
  },
  {
    symbol: "ARB",
    name: "Arbitrum",
    category: "Layer 2",
    color: "#5fa8e8",
    priceMicros: usd("0.82"),
    change24h: 3.05,
  },
  {
    symbol: "OP",
    name: "Optimism",
    category: "Layer 2",
    color: "#e86a6a",
    priceMicros: usd("2.04"),
    change24h: 1.12,
  },
  {
    symbol: "LINK",
    name: "Chainlink",
    category: "Oracle",
    color: "#5b84e8",
    priceMicros: usd("21.37"),
    change24h: 0.68,
  },
  {
    symbol: "UNI",
    name: "Uniswap",
    category: "DeFi",
    color: "#e57bb6",
    priceMicros: usd("12.64"),
    change24h: -0.51,
  },
  {
    symbol: "AAVE",
    name: "Aave",
    category: "DeFi",
    color: "#a58ae0",
    priceMicros: usd("318.90"),
    change24h: 2.76,
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    category: "Stablecoin",
    color: "#6c9be0",
    priceMicros: usd("1.00"),
    change24h: 0,
  },
  {
    symbol: "PAXG",
    name: "PAX Gold",
    category: "Real-world asset",
    color: "#d8b45c",
    priceMicros: usd("2684.30"),
    change24h: 0.21,
  },
];

/** 8 decimal places for quantities, 6 for USD. */
export const QTY = 100_000_000n;
export const USD = 1_000_000n;
export const STARTING_CASH = (10_000n * USD).toString();
export const FEE_BPS = 10n; // 0.10%

export interface CryptoAccount {
  cashMicros: string;
  holdings: Record<string, { quantity: string; costMicros: string }>;
}

export const defaultCryptoAccount = (): CryptoAccount => ({
  cashMicros: STARTING_CASH,
  holdings: {},
});

export function parseDecimal(value: string, decimals: number, label: string) {
  if (!/^\d{1,15}(\.\d+)?$/.test(value))
    throw new VerificationError(
      "INVALID_AMOUNT",
      `Enter a valid ${label}.`,
      400,
    );
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new VerificationError(
      "INVALID_AMOUNT",
      `${label.charAt(0).toUpperCase()}${label.slice(1)} supports up to ${decimals} decimal places.`,
      400,
    );
  const result =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (result <= 0n)
    throw new VerificationError(
      "INVALID_AMOUNT",
      `Enter a ${label} above zero.`,
      400,
    );
  return result;
}

export function executeCryptoTrade(
  account: CryptoAccount,
  input: { symbol: string; side: "buy" | "sell"; amount: string },
) {
  const asset = cryptoAssets.find((a) => a.symbol === input.symbol);
  if (!asset)
    throw new VerificationError(
      "UNKNOWN_ASSET",
      "This asset is not listed.",
      404,
    );
  const price = BigInt(asset.priceMicros);
  const cash = BigInt(account.cashMicros);
  const current = account.holdings[asset.symbol] ?? {
    quantity: "0",
    costMicros: "0",
  };
  const heldQty = BigInt(current.quantity),
    heldCost = BigInt(current.costMicros);
  let quantity: bigint, gross: bigint, fee: bigint, nextCash: bigint, next;
  if (input.side === "buy") {
    // Buy amount is the USD spent, fee included.
    const spend = parseDecimal(input.amount, 6, "USD amount");
    if (spend > cash)
      throw new VerificationError(
        "INSUFFICIENT_FUNDS",
        "Not enough simulated USDT for this purchase.",
        400,
      );
    fee = (spend * FEE_BPS + 9_999n) / 10_000n;
    gross = spend - fee;
    quantity = (gross * QTY) / price;
    if (quantity <= 0n)
      throw new VerificationError(
        "INVALID_AMOUNT",
        "Amount is too small to buy.",
        400,
      );
    nextCash = cash - spend;
    next = {
      quantity: (heldQty + quantity).toString(),
      costMicros: (heldCost + spend).toString(),
    };
  } else {
    // Sell amount is a token quantity.
    quantity = parseDecimal(input.amount, 8, "quantity");
    if (quantity > heldQty)
      throw new VerificationError(
        "INSUFFICIENT_HOLDING",
        `You hold less ${asset.symbol} than this.`,
        400,
      );
    gross = (quantity * price) / QTY;
    fee = (gross * FEE_BPS + 9_999n) / 10_000n;
    nextCash = cash + gross - fee;
    const remaining = heldQty - quantity;
    next = {
      quantity: remaining.toString(),
      costMicros: (remaining === 0n
        ? 0n
        : heldCost - (heldCost * quantity) / heldQty
      ).toString(),
    };
  }
  const holdings = { ...account.holdings };
  if (BigInt(next.quantity) === 0n) delete holdings[asset.symbol];
  else holdings[asset.symbol] = next;
  return {
    account: { cashMicros: nextCash.toString(), holdings },
    trade: {
      symbol: asset.symbol,
      side: input.side,
      quantity: quantity.toString(),
      priceMicros: asset.priceMicros,
      grossMicros: gross.toString(),
      feeMicros: fee.toString(),
      executedAt: new Date().toISOString(),
    },
  };
}
