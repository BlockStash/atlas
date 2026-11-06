import { api } from "../api";
import { walletClient } from "../wallet";

export type Side = "BUY" | "SELL";
export type EntryCondition =
  | { type: "MARKET_OPEN" }
  | { type: "PRICE_BELOW" | "PRICE_ABOVE"; priceUSDT: string }
  | { type: "AT_TIME" | "AFTER_TIME" | "BEFORE_TIME"; timestamp: number };
export type ExitCondition =
  | { type: "TAKE_PROFIT_BPS" | "STOP_LOSS_BPS"; value: number }
  | { type: "PRICE_ABOVE" | "PRICE_BELOW"; priceUSDT: string }
  | { type: "TIME_EXIT"; timestamp: number };
export interface Allocation {
  type: "FIXED_USDT" | "PORTFOLIO_PERCENT" | "VAULT_PERCENT";
  value: string;
}
export interface Intent {
  id: string;
  version: "1";
  userAddress: string;
  asset: {
    stockId: string;
    symbol: string;
    companyName: string;
    market: string;
    country: string;
    currency: string;
  };
  side: Side;
  allocation: Allocation;
  entryConditions: EntryCondition[];
  exitConditions: ExitCondition[];
  constraints: {
    maxSlippageBps?: number;
    maxExecutionPriceUSDT?: string;
    minExecutionPriceUSDT?: string;
    validAfter?: number;
    validUntil?: number;
  };
  metadata: {
    originalPrompt: string;
    createdAt: number;
    defaultsApplied: string[];
    parser: "ai" | "rules" | "manual";
  };
}
export interface Warning {
  severity: "LOW" | "MEDIUM" | "HIGH";
  code: string;
  message: string;
}
export interface Issue {
  code: string;
  message: string;
  path?: string;
}
export interface Simulation {
  estimatedEntryPrice: string;
  estimatedQuantity: string;
  estimatedNotionalUSDT: string;
  estimatedFeesUSDT: string;
  estimatedSlippageUSDT: string;
  estimatedSlippageBps: number;
  estimatedTakeProfitPrice?: string;
  estimatedStopLossPrice?: string;
  estimatedProfitAtTargetUSDT?: string;
  estimatedLossAtStopUSDT?: string;
  marketStatus: string;
  exposureAfterTradePercent: string;
  warnings: Warning[];
  disclaimer: string;
}
export interface Evaluation {
  intent: Intent;
  valid: boolean;
  issues: Issue[];
  blockingRisk: Issue[];
  strategyHash: string;
  summary: string;
  simulation: Simulation | null;
  risk: {
    estimatedMaxLossUSDT: string | null;
    portfolioPercent: string;
  } | null;
  price: {
    priceUSDT: string;
    updatedAt: number;
    isStale: boolean;
    source?: string;
  } | null;
  market: {
    open: boolean;
    exchange: string;
    reason: string;
    nextOpen: number | null;
  } | null;
  maxSpendUSDT: string | null;
  /** Live Sepolia mode: vault funding needed and the MetaMask permission to request. */
  funding?: Funding;
}
export interface Funding {
  requiredUSDT: string;
  vaultUSDT: string;
  walletUSDT: string;
  shortfallUSDT: string;
  permission: {
    tokenAddress: string;
    allowanceShares: string;
    delegate: string;
    delegationManager: string;
  };
}
/** ERC-7715 grant returned by MetaMask, forwarded to the backend at activation. */
export interface GrantedPermission {
  context: string;
  delegationManager: string;
  allowanceShares: string;
}
export interface AssetSelection {
  note: string;
  symbol: string;
  priceUSDT: number;
  rank: "highest" | "lowest";
  capUSDT: number | null;
}
export type ParseResult =
  | {
      status: "OK";
      intent: Intent;
      parser: string;
      evaluation: Evaluation;
      parseHash: string;
      /** Set when Atlas picked the asset from a price rule ("highest-priced stock within 1000 USDT"). */
      selection?: AssetSelection;
    }
  | {
      status: "CLARIFICATION_NEEDED";
      question: string;
      field: string;
      options: {
        label: string;
        append: string;
        needsInput?: "price" | "time";
      }[];
    }
  | { status: "UNSUPPORTED_INTENT"; reason: string }
  /** Multi-asset or crypto request: built in the strategy studio instead. */
  | { status: "PORTFOLIO_STRATEGY"; reason: string };
export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, string>;
}
export interface CreateResult {
  id: string;
  evaluation: Evaluation;
  typedData: TypedData;
  demoSignatureAllowed: boolean;
}
export interface Position {
  quantity: string;
  entry_price_usdt: string;
  current_price_usdt: string;
  status: "OPEN" | "CLOSED";
  pnlBps: number;
  exit_reason: string | null;
}
export interface IntentView {
  id: string;
  status: string;
  intent: Intent;
  strategyHash: string;
  createdAt: number;
  validUntil: number | null;
  summary: string;
  position: Position | null;
  executions: {
    kind: string;
    side: string;
    price_usdt: string;
    quantity: string;
    slippage_bps: number;
    fee_usdt: string;
    notional_usdt?: string;
    tx_hash: string | null;
  }[];
  error: { code: string; message: string } | null;
  blocked: string | null;
  closeRequested: boolean;
  demo: boolean;
  executionMode: "SIMULATED" | "ONCHAIN";
  signatureType: string | null;
}
export interface IntentEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}
export interface Notification {
  id: number;
  intent_id: string;
  kind: string;
  message: string;
  created_at: number;
  read: number;
}
export interface IntentConfig {
  demoMode: boolean;
  executionMode: "SIMULATED" | "ONCHAIN";
  aiParser: "ai" | "rules";
  demoControls: boolean;
  onchain: { executor: string; chainId: number } | null;
}

export type BacktestDays = 30 | 90 | 180;
export type BacktestExit =
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "PRICE_EXIT"
  | "TIME_EXIT"
  | "OPEN"
  | "NOT_TRIGGERED";
export interface Backtest {
  days: number;
  runs: number;
  annualVolatility: number;
  band: { day: number; p10: number; p50: number; p90: number }[];
  sample: {
    path: { day: number; price: number }[];
    entry: { day: number; price: number } | null;
    exit: { day: number; price: number; reason: BacktestExit } | null;
    pnlUSDT: number;
  };
  levels: {
    current: number;
    entryTrigger: number | null;
    takeProfit: number | null;
    stopLoss: number | null;
  };
  stats: {
    triggeredPct: number;
    takeProfitPct: number;
    stopLossPct: number;
    otherExitPct: number;
    stillOpenPct: number;
    winRatePct: number;
    expectedPnlUSDT: number;
    medianPnlUSDT: number;
    p10PnlUSDT: number;
    p90PnlUSDT: number;
    avgHoldDays: number | null;
  };
  disclaimer: string;
}
export interface PaperPreview {
  order: {
    id: string;
    quantity: string;
    draft: {
      symbol: string;
      takeProfitBps: number;
      stopLossBps: number;
      maxSlippageBps: number;
    };
  };
  confirmationToken: string;
  estimatedFill: string | null;
  defaults: string[];
}
/** Paper Trading bridge: an Atlas AI plan becomes a paper order, then is explicitly confirmed. */
export const paperBridge = {
  preview: (body: {
    symbol: string;
    notionalUSDT: number;
    maxSlippageBps?: number;
    takeProfitBps?: number;
    stopLossBps?: number;
  }) => api<PaperPreview>("/paper/from-intent", body),
  confirm: (id: string, confirmationToken: string) =>
    api<unknown>(`/paper/${id}/confirm`, {
      confirmed: true,
      confirmationToken,
    }),
};

export interface AtlasTrade {
  id: string;
  intentId: string;
  kind: "ENTRY" | "EXIT";
  side: "BUY" | "SELL";
  symbol: string;
  companyName: string;
  market: string;
  quantity: string;
  priceUSDT: string;
  notionalUSDT: string;
  feeUSDT: string;
  slippageBps: number;
  executedAt: number;
  txHash: string | null;
  mode: string;
  /** Sepolia transactions behind this fill: pull, buy, change / sell, payout. */
  transactions?: { step: string; txHash: string }[];
  prompt: string;
  exitReason: string | null;
  realizedPnlUSDT: string | null;
}
export interface TradeHistory {
  trades: AtlasTrade[];
  summary: {
    count: number;
    openPositions: number;
    volumeUSDT: string;
    feesUSDT: string;
    realizedPnlUSDT: string;
  };
}

export const intentApi = {
  trades: () => api<TradeHistory>("/intents/trades"),
  backtest: (intent: Intent, days: BacktestDays) =>
    api<{ backtest: Backtest }>("/intents/backtest", { intent, days }),
  config: () => api<IntentConfig>("/intents/config"),
  parse: (prompt: string) => api<ParseResult>("/intents/parse", { prompt }),
  evaluate: (intent: Intent) =>
    api<Evaluation>("/intents/simulate", { intent }),
  create: (intent: Intent, parseHash?: string) =>
    api<CreateResult>("/intents", { intent, parseHash }),
  activate: (id: string, signature: string, permission?: GrantedPermission) =>
    api<IntentView>(`/intents/${id}/activate`, {
      signature,
      ...(permission ? { permission } : {}),
    }),
  cancel: (id: string) => api<IntentView>(`/intents/${id}/cancel`, {}),
  close: (id: string) => api<IntentView>(`/intents/${id}/close`, {}),
  list: () => api<{ intents: IntentView[] }>("/intents"),
  events: (id: string) =>
    api<{ events: IntentEvent[] }>(`/intents/${id}/events`),
  notifications: (markRead = false) =>
    api<{ notifications: Notification[] }>(
      `/intents/notifications${markRead ? "?markRead=1" : ""}`,
    ),
  demoPrice: (stockId: string, multiplierBps: number) =>
    api<{ ok: true }>("/intents/demo/price", { stockId, multiplierBps }),
  demoMarket: (open: boolean) =>
    api<{ ok: true }>("/intents/demo/market", { open }),
  demoTick: () => api<{ processed: number }>("/intents/demo/tick", {}),
};

/**
 * Ask MetaMask (13.23+, smart account) to grant the Atlas executor an aUSDT allowance via
 * ERC-7715. MetaMask shows the token, amount, recipient and expiry; nothing else is delegated.
 */
export async function requestAusdtPermission(
  account: string,
  funding: Funding,
  expiry: number,
  symbol: string,
): Promise<GrantedPermission> {
  const [{ createWalletClient, custom }, { erc7715ProviderActions }] =
    await Promise.all([
      import("viem"),
      import("@metamask/smart-accounts-kit/actions"),
    ]);
  const provider = (await walletClient()).getProvider();
  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as string[];
  if (!accounts.some((a) => a.toLowerCase() === account.toLowerCase()))
    throw new Error(
      `Select ${account.slice(0, 6)}…${account.slice(-4)} in MetaMask (the account you signed in with) and try again.`,
    );
  const client = createWalletClient({
    transport: custom(provider as Parameters<typeof custom>[0]),
  }).extend(erc7715ProviderActions());
  const p = funding.permission;
  try {
    const [granted] = await client.requestExecutionPermissions([
      {
        chainId: 11155111,
        from: account as `0x${string}`,
        expiry,
        to: p.delegate as `0x${string}`,
        permission: {
          type: "erc20-token-allowance",
          isAdjustmentAllowed: false,
          data: {
            tokenAddress: p.tokenAddress as `0x${string}`,
            allowanceAmount: BigInt(p.allowanceShares),
            justification: `Atlas AI: buy ${symbol} for up to ${funding.requiredUSDT} USDT with your aUSDT, then return the proceeds.`,
          },
        },
      },
    ]);
    if (!granted?.context)
      throw new Error("MetaMask did not grant the aUSDT permission.");
    const data = granted.permission.data as {
      allowanceAmount?: bigint | string;
    };
    return {
      context: granted.context,
      delegationManager: granted.delegationManager,
      allowanceShares: String(data.allowanceAmount ?? p.allowanceShares),
    };
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err.code === 4001)
      throw new Error(
        "You declined the aUSDT permission. Your strategy was not activated.",
      );
    if (
      err.code === -32601 ||
      err.code === 4200 ||
      /not (supported|found)|does not exist/i.test(err.message ?? "")
    )
      throw new Error(
        "Your MetaMask does not support Advanced Permissions yet. Update MetaMask to 13.23 or later and use a MetaMask smart account.",
      );
    throw e;
  }
}

/** Ask the wallet for an EIP-712 signature. The user sees every field of the authorization. */
export async function signAuthorization(
  account: string,
  td: TypedData,
): Promise<string> {
  const provider = (await walletClient()).getProvider();
  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as string[];
  if (!accounts.some((a) => a.toLowerCase() === account.toLowerCase()))
    throw new Error("Your wallet account changed. Reconnect and try again.");
  const payload = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...td.types,
    },
    primaryType: td.primaryType,
    domain: td.domain,
    message: td.message,
  });
  try {
    return (await provider.request({
      method: "eth_signTypedData_v4",
      params: [account, payload],
    })) as string;
  } catch (e) {
    if ((e as { code?: number }).code === 4001)
      throw new Error(
        "You declined the signature. Your strategy was not activated.",
      );
    throw e;
  }
}

// ---- formatting helpers (display only; all financial logic lives on the server) ----
export const bpsPct = (bps: number, sign = false) =>
  `${sign && bps > 0 ? "+" : ""}${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
export const num = (s: string | undefined | null, digits = 2) =>
  s === undefined || s === null || s === ""
    ? "—"
    : Number(s).toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: 0,
      });
export const usd = (s: string | undefined | null, digits = 2) =>
  s === undefined || s === null || s === ""
    ? "—"
    : `$${Number(s).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export function timeLeft(
  until: number | null | undefined,
  now = Date.now() / 1000,
) {
  if (!until) return "No expiry";
  const s = Math.floor(until - now);
  if (s <= 0) return "Expired";
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export function describeEntry(c: EntryCondition, market: string) {
  switch (c.type) {
    case "MARKET_OPEN":
      return "immediately (Atlas markets are open 24/7)";
    case "PRICE_BELOW":
      return `Price below ${usd(c.priceUSDT)}`;
    case "PRICE_ABOVE":
      return `Price above ${usd(c.priceUSDT)}`;
    case "AT_TIME":
      return `At ${new Date(c.timestamp * 1000).toLocaleString()}`;
    case "AFTER_TIME":
      return `After ${new Date(c.timestamp * 1000).toLocaleString()}`;
    case "BEFORE_TIME":
      return `Before ${new Date(c.timestamp * 1000).toLocaleString()}`;
  }
}
export function describeExit(c: ExitCondition) {
  switch (c.type) {
    case "TAKE_PROFIT_BPS":
      return `Take profit ${bpsPct(c.value, true)}`;
    case "STOP_LOSS_BPS":
      return `Stop loss -${bpsPct(c.value)}`;
    case "PRICE_ABOVE":
      return `Price reaches ${usd(c.priceUSDT)}`;
    case "PRICE_BELOW":
      return `Price falls to ${usd(c.priceUSDT)}`;
    case "TIME_EXIT":
      return `Exit at ${new Date(c.timestamp * 1000).toLocaleString()}`;
  }
}
export const describeAllocation = (a: Allocation, side: Side) =>
  a.type === "FIXED_USDT"
    ? `${num(a.value)} USDT`
    : a.type === "VAULT_PERCENT"
      ? `${a.value}% of vault`
      : side === "SELL"
        ? `${a.value}% of position`
        : `${a.value}% of portfolio`;

export const TIMELINE: { type: string; label: string }[] = [
  { type: "PROMPT_RECEIVED", label: "Prompt received" },
  { type: "INTENT_PARSED", label: "Intent parsed" },
  { type: "RISK_CHECKED", label: "Risk checked" },
  { type: "SIMULATION_COMPLETE", label: "Simulation complete" },
  { type: "USER_SIGNED", label: "User signed" },
  { type: "STRATEGY_ACTIVATED", label: "Strategy activated" },
  { type: "ENTRY_CONDITION_MET", label: "Entry condition met" },
  { type: "TRADE_SUBMITTED", label: "Trade submitted" },
  { type: "TRADE_CONFIRMED", label: "Trade confirmed" },
  { type: "POSITION_MONITORING", label: "Position monitoring" },
  { type: "EXIT_CONDITION_MET", label: "Exit condition met" },
  { type: "POSITION_CLOSED", label: "Position closed" },
];
export const DEMO_UI = process.env.NEXT_PUBLIC_INTENT_DEMO_MODE === "true";

/**
 * Execution rows come straight from the database as fixed-point integers: quantity has 18
 * decimals and USDT amounts have 6. Prices are already decimal strings.
 */
export const fromUnits = (raw: string | undefined | null, decimals: number) =>
  raw ? Number(raw) / 10 ** decimals : 0;
export const execQty = (e: IntentView["executions"][number]) =>
  fromUnits(e.quantity, 18);
export const execFee = (e: IntentView["executions"][number]) =>
  fromUnits(e.fee_usdt, 6);
export const execValue = (e: IntentView["executions"][number]) =>
  e.notional_usdt !== undefined
    ? fromUnits(e.notional_usdt, 6)
    : execQty(e) * Number(e.price_usdt);
