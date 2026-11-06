import {
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
  getAddress,
  id as idHash,
} from "ethers";
import {
  strategySchema,
  type AtlasStrategy,
  type AtlasTradeIntent,
} from "./types.js";
import { parseUSDT } from "./math.js";

/** Deterministic JSON: keys sorted recursively, no whitespace, integers only (no floats, no undefined). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Canonical form allows only safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new Error("Unsupported value in canonical form");
}

const condKey = (c: object) => canonicalize(c);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const trimDecimal = (s: string) =>
  s.includes(".") ? s.replace(/\.?0+$/, "") || "0" : s;
function normDecimalFields<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = { ...o };
  for (const k of [
    "priceUSDT",
    "maxExecutionPriceUSDT",
    "minExecutionPriceUSDT",
    "value",
  ])
    if (typeof out[k] === "string" && /^\d/.test(out[k] as string))
      out[k] = trimDecimal(out[k] as string);
  return out as T;
}

/** The strategy body only: no id, user, prompt or timestamps. Order-insensitive for condition lists. */
export function normalizeStrategy(input: AtlasStrategy): AtlasStrategy {
  const s = strategySchema.parse(input);
  return {
    ...s,
    asset: { ...s.asset, stockId: s.asset.stockId.toLowerCase() },
    allocation: normDecimalFields(s.allocation),
    entryConditions: s.entryConditions
      .map((c) => normDecimalFields(c) as typeof c)
      .sort((a, b) => cmp(condKey(a), condKey(b))),
    exitConditions: s.exitConditions
      .map((c) => normDecimalFields(c) as typeof c)
      .sort((a, b) => cmp(condKey(a), condKey(b))),
    constraints: normDecimalFields(s.constraints),
  };
}
export function strategyBody(intent: AtlasTradeIntent): AtlasStrategy {
  const { id: _i, userAddress: _u, metadata: _m, ...body } = intent;
  return body;
}
export const canonicalIntent = (s: AtlasStrategy) =>
  `ATLAS_INTENT_V1:${canonicalize(normalizeStrategy(s))}`;
export const strategyHash = (s: AtlasStrategy) =>
  keccak256(toUtf8Bytes(canonicalIntent(s)));

export const EIP712_TYPES = {
  AtlasIntentAuthorization: [
    { name: "user", type: "address" },
    { name: "intentId", type: "bytes32" },
    { name: "stockId", type: "bytes32" },
    { name: "maxSpendUSDT", type: "uint256" },
    { name: "maxSlippageBps", type: "uint256" },
    { name: "takeProfitBps", type: "uint256" },
    { name: "stopLossBps", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "strategyHash", type: "bytes32" },
  ],
} as const;

export interface IntentDomainConfig {
  chainId: number;
  verifyingContract: string;
}
export const intentDomain = (c: IntentDomainConfig) => ({
  name: "AtlasIntentManager",
  version: "1",
  chainId: c.chainId,
  verifyingContract: c.verifyingContract,
});

export interface AuthorizationMessage {
  user: string;
  intentId: string;
  stockId: string;
  maxSpendUSDT: string;
  maxSlippageBps: string;
  takeProfitBps: string;
  stopLossBps: string;
  validAfter: string;
  validUntil: string;
  nonce: string;
  strategyHash: string;
}

/** Build the EIP-712 message. `maxSpendUSDT` is the resolved, frozen spend cap (6-dec micro-units). */
export function buildAuthorization(
  intent: AtlasTradeIntent,
  opts: {
    maxSpendUSDT: bigint;
    nonce: number;
    now: number;
    defaultValidityS?: number;
  },
): AuthorizationMessage {
  const c = intent.constraints;
  const tp = intent.exitConditions.find((e) => e.type === "TAKE_PROFIT_BPS");
  const sl = intent.exitConditions.find((e) => e.type === "STOP_LOSS_BPS");
  const validAfter = c.validAfter ?? opts.now;
  const validUntil =
    c.validUntil ?? validAfter + (opts.defaultValidityS ?? 86_400);
  return {
    user: getAddress(intent.userAddress),
    intentId: intent.id,
    stockId: intent.asset.stockId,
    maxSpendUSDT: opts.maxSpendUSDT.toString(),
    maxSlippageBps: String(c.maxSlippageBps ?? 0),
    takeProfitBps: String(tp?.type === "TAKE_PROFIT_BPS" ? tp.value : 0),
    stopLossBps: String(sl?.type === "STOP_LOSS_BPS" ? sl.value : 0),
    validAfter: String(validAfter),
    validUntil: String(validUntil),
    nonce: String(opts.nonce),
    strategyHash: strategyHash(strategyBody(intent)),
  };
}

export function typedData(
  msg: AuthorizationMessage,
  domain: IntentDomainConfig,
) {
  return {
    domain: intentDomain(domain),
    types: EIP712_TYPES as unknown as Record<
      string,
      { name: string; type: string }[]
    >,
    primaryType: "AtlasIntentAuthorization" as const,
    message: msg,
  };
}

export function recoverSigner(
  msg: AuthorizationMessage,
  signature: string,
  domain: IntentDomainConfig,
): string {
  return verifyTypedData(
    intentDomain(domain),
    EIP712_TYPES as unknown as Record<string, { name: string; type: string }[]>,
    msg,
    signature,
  );
}

export const newIntentId = () => keccak256(toUtf8Bytes(crypto.randomUUID()));
export { idHash, parseUSDT };
