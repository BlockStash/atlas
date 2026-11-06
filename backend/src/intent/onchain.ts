/**
 * Live Sepolia execution for Atlas AI strategies, funded by an ERC-7715 permission.
 *
 * When a user confirms a strategy, MetaMask grants the Atlas executor an aUSDT (vault share)
 * allowance capped at the strategy's maximum spend, valid until the strategy expires. MetaMask
 * only grants token permissions (it refuses dapp-signed delegations for arbitrary calls), so:
 *
 *   entry: redeem the permission to pull aUSDT from the user → executor buys on the trading engine
 *          → any unspent aUSDT goes straight back to the user
 *   exit:  executor sells on the trading engine → the returned aUSDT is sent to the user
 *
 * The stock is held by the executor for the life of the trade and is tracked per user in the
 * intent ledger. Every step is a real Sepolia transaction, recorded before it is awaited so a
 * retry never resends a transfer.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  maxUint256,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { erc7710WalletActions } from "@metamask/smart-accounts-kit/actions";
import { decodeDelegations } from "@metamask/smart-accounts-kit/utils";
import abiJson from "../protocol/abis.json" with { type: "json" };
import { readCountryManifest } from "../protocol/country-catalog.js";
import { assetByStockId } from "./assets.js";
import { parsePrice, valueOf } from "./math.js";
import type { IntentRepository } from "./repository.js";
import type {
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
  PriceSource,
} from "./adapters.js";
import { IntentError, type PortfolioView } from "./types.js";

const ENGINE = abiJson.AtlasCountryTradingEngine as Abi;
const VAULT = abiJson.AtlasVault as Abi;
const MARKET = abiJson.AtlasCountryMarket as Abi;
const ERC20 = abiJson.AtlasUSDT as Abi;
const BPS = 10_000n;
const DEFAULT_SLIPPAGE_BPS = 100n;
/** Below this the executor cannot reliably pay for a buy (3–4 transactions). */
const MIN_GAS_WEI = 2_000_000_000_000_000n; // 0.002 ETH
const SEPOLIA = 11155111;
/** Fallbacks after PROTOCOL_RPC_URL; override with INTENT_EXECUTOR_RPC_URLS (comma separated). */
const PUBLIC_SEPOLIA_RPCS =
  "https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.drpc.org,https://1rpc.io/sepolia";

export const delegationManagerAddress = () =>
  getAddress(getSmartAccountsEnvironment(SEPOLIA).DelegationManager);

type Manifest = Awaited<ReturnType<typeof readCountryManifest>>;

export class OnchainExecutor implements ExecutionAdapter {
  readonly kind = "ONCHAIN" as const;
  readonly address: Address;
  private pub;
  private wallet;
  private manifest?: Promise<Manifest>;
  private approved = new Set<string>();
  private plain = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private repo: IntentRepository,
    privateKey: string,
    rpcUrl = process.env.PROTOCOL_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com",
    private now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    // Nonces are tracked locally so a lagging RPC node cannot hand out a used one.
    const account = privateKeyToAccount(
      (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex,
      { nonceManager },
    );
    this.address = account.address;
    // Rate-limited (429) or failing RPCs fall through to the next one; a signed transaction is
    // the same on every node, so resending it elsewhere cannot double-spend.
    const urls = [
      rpcUrl,
      ...(process.env.INTENT_EXECUTOR_RPC_URLS || PUBLIC_SEPOLIA_RPCS)
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ].filter((u, i, all) => all.indexOf(u) === i);
    const transport = fallback(
      urls.map((u) =>
        http(u, {
          batch: false,
          retryCount: 3,
          retryDelay: 1_500,
          timeout: 20_000,
        }),
      ),
      { retryCount: 2 },
    );
    this.pub = createPublicClient({ chain: sepolia, transport });
    this.wallet = createWalletClient({
      account,
      chain: sepolia,
      transport,
    }).extend(erc7710WalletActions());
  }

  private deployment() {
    this.manifest ??= readCountryManifest();
    return this.manifest;
  }
  async contracts() {
    const m = await this.deployment();
    return {
      vault: getAddress(m.atlasVault),
      usdt: getAddress(m.atlasUSDT),
      engine: getAddress(m.tradingEngine),
    };
  }
  private async countryOf(stockId: string): Promise<Address> {
    const asset = assetByStockId(stockId);
    const m = await this.deployment();
    const c = m.countries.find((x) => x.region === asset?.region);
    if (!asset || !c)
      throw new IntentError(
        "INVALID_INTENT",
        "This stock has no Sepolia market.",
        422,
      );
    return getAddress(c.address);
  }
  private read<T>(
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
  ) {
    return this.pub.readContract({
      address,
      abi,
      functionName,
      args,
    }) as Promise<T>;
  }

  /** aUSDT shares to request in MetaMask for a strategy spending up to `maxSpend` USDT. */
  async permissionRequest(maxSpendUSDT: bigint, slippageBps?: number) {
    const { vault, engine } = await this.contracts();
    const fee = await this.read<bigint>(engine, ENGINE, "tradingFeeBps");
    const slip = BigInt(slippageBps ?? Number(DEFAULT_SLIPPAGE_BPS));
    const assets = (maxSpendUSDT * (BPS + fee + slip)) / BPS + 1n;
    const shares = await this.read<bigint>(vault, VAULT, "previewWithdraw", [
      assets,
    ]);
    // 2% headroom for share-price drift between granting and executing.
    return {
      tokenAddress: vault,
      allowanceShares: (shares * 102n) / 100n,
      requiredAssetsUSDT: assets,
      delegate: this.address,
      delegationManager: delegationManagerAddress(),
    };
  }

  /** The user's wallet USDT and vault (aUSDT) claim, read from Sepolia. */
  async balances(user: string) {
    const { vault, usdt } = await this.contracts();
    const who = getAddress(user);
    const [shares, walletUSDT] = await Promise.all([
      this.read<bigint>(vault, VAULT, "balanceOf", [who]),
      this.read<bigint>(usdt, ERC20, "balanceOf", [who]),
    ]);
    const vaultAssets = shares
      ? await this.read<bigint>(vault, VAULT, "convertToAssets", [shares])
      : 0n;
    return { shares, vaultAssets, walletUSDT };
  }

  /** The granted context must delegate from this user to this executor, through MetaMask's manager. */
  verifyPermission(
    p: { context: string; delegationManager: string },
    user: string,
  ) {
    if (getAddress(p.delegationManager) !== delegationManagerAddress())
      throw new IntentError(
        "USER_REJECTED_SIGNATURE",
        "The permission was not issued through MetaMask's delegation manager.",
        422,
      );
    let chain;
    try {
      chain = decodeDelegations(p.context as Hex);
    } catch {
      throw new IntentError(
        "USER_REJECTED_SIGNATURE",
        "The MetaMask permission could not be read.",
        422,
      );
    }
    if (!chain.length)
      throw new IntentError(
        "USER_REJECTED_SIGNATURE",
        "The MetaMask permission is empty.",
        422,
      );
    const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
    const me = getAddress(user);
    const first = chain[0]!,
      last = chain[chain.length - 1]!;
    // The leaf (redeemed by the executor) and the root (signed by the user) sit at the two ends
    // of the chain; accept either encoding order.
    const ok = (leaf: typeof first, root: typeof first) =>
      getAddress(leaf.delegate) === this.address &&
      getAddress(root.delegator) === me;
    if (ok(first, last) || ok(last, first)) return;
    const links = chain.map(
      (d) =>
        `${short(getAddress(d.delegator))} → ${short(getAddress(d.delegate))}`,
    );
    console.warn("[atlas] rejected MetaMask permission", {
      user: me,
      executor: this.address,
      chain: links,
    });
    const fromOther = ![first, last].some(
      (d) => getAddress(d.delegator) === me,
    );
    throw new IntentError(
      "USER_REJECTED_SIGNATURE",
      fromOther
        ? `MetaMask granted the permission from ${short(getAddress(last.delegator))}, but you are signed in as ${short(me)}. Select ${short(me)} in MetaMask and try again.`
        : `The MetaMask permission goes to ${short(getAddress(first.delegate))}, not the Atlas executor ${short(this.address)}. Reload the page and try again.`,
      422,
      { chain: links, executor: this.address },
    );
  }

  async gas() {
    return this.pub.getBalance({ address: this.address });
  }

  /** Executions share one sender, so they run one at a time to keep nonces in order. */
  execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const run = this.queue.then(() => this.executeNow(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async executeNow(r: ExecutionRequest): Promise<ExecutionResult> {
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
    // Stock is minted to the executor (ERC-1155), so it must be a plain account with no code.
    if (!this.plain) {
      const code = await this.pub.getCode({ address: this.address });
      if (code && code !== "0x")
        throw new IntentError(
          "RPC_ERROR",
          `The Atlas executor ${this.address} has contract code; use a fresh key for INTENT_EXECUTOR_PRIVATE_KEY.`,
          503,
        );
      this.plain = true;
    }
    if ((await this.gas()) < MIN_GAS_WEI)
      throw new IntentError(
        "RPC_ERROR",
        `The Atlas executor ${this.address} needs Sepolia ETH for gas.`,
        503,
        undefined,
        true,
      );
    return r.side === "BUY" ? this.buy(r) : this.sell(r);
  }

  /** Send once per (execution, step); on retry, wait on the hash already sent. */
  private async step(
    executionId: string,
    name: string,
    send: () => Promise<Hex>,
  ): Promise<TransactionReceipt> {
    const prior = this.repo.step(executionId, name);
    const hash = (prior?.tx_hash as Hex | undefined) ?? (await send());
    if (!prior) this.repo.saveStep(executionId, name, hash, null, this.now());
    const receipt = await this.pub.waitForTransactionReceipt({
      hash,
      timeout: 180_000,
    });
    if (receipt.status !== "success") {
      const tx = await this.pub.getTransaction({ hash }).catch(() => null);
      const outOfGas = !!tx && receipt.gasUsed * 100n >= tx.gas * 98n;
      // Out of gas is transient for every step; a reverted exit-side transfer or sell is retried
      // too. Forget the failed hash so the next attempt sends a fresh transaction.
      if (outOfGas || !["pull", "buy"].includes(name)) {
        this.repo.deleteStep(executionId, name);
        throw new IntentError(
          "RPC_ERROR",
          `The ${name} transaction ${outOfGas ? "ran out of gas" : "reverted"} on Sepolia (${hash}); Atlas will resend it.`,
          503,
          { txHash: hash },
          true,
        );
      }
      throw new IntentError(
        "TRADE_REVERTED",
        `The ${name} transaction reverted on Sepolia (${hash}).`,
        422,
        { txHash: hash },
      );
    }
    return receipt;
  }

  /** Contract write with 30% gas headroom over the estimate (state can shift before inclusion). */
  private async write(p: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }): Promise<Hex> {
    const estimate = await this.pub.estimateContractGas({
      ...p,
      account: this.wallet.account,
    });
    return this.wallet.writeContract({
      ...p,
      gas: (estimate * 13n) / 10n + 20_000n,
    } as Parameters<typeof this.wallet.writeContract>[0]);
  }
  private transfer(
    executionId: string,
    name: string,
    to: Address,
    shares: bigint,
  ) {
    return this.contracts().then(({ vault }) =>
      this.step(executionId, name, () =>
        this.write({
          address: vault,
          abi: VAULT,
          functionName: "transfer",
          args: [to, shares],
        }),
      ),
    );
  }

  /** One-time approvals so the engine can take the executor's aUSDT and burn its stock on sells. */
  private async approvals(country: Address) {
    const { vault, engine } = await this.contracts();
    if (!this.approved.has("vault")) {
      const allowance = await this.read<bigint>(vault, VAULT, "allowance", [
        this.address,
        engine,
      ]);
      if (allowance < maxUint256 / 2n)
        await this.step(`executor:${this.address}`, "approve-vault", () =>
          this.write({
            address: vault,
            abi: VAULT,
            functionName: "approve",
            args: [engine, maxUint256],
          }),
        );
      this.approved.add("vault");
    }
    if (!this.approved.has(country)) {
      const ok = await this.read<boolean>(country, MARKET, "isApprovedForAll", [
        this.address,
        engine,
      ]);
      if (!ok)
        await this.step(`executor:${this.address}`, `approve-${country}`, () =>
          this.write({
            address: country,
            abi: MARKET,
            functionName: "setApprovalForAll",
            args: [engine, true],
          }),
        );
      this.approved.add(country);
    }
  }

  /** Send change recorded as owed for an execution, once. */
  private async settleOwed(executionId: string, user: Address) {
    const owed = this.repo.step(executionId, "change-owed");
    if (!owed?.data) return;
    const amount = BigInt(JSON.parse(owed.data) as string);
    if (amount > 0n) await this.transfer(executionId, "change", user, amount);
  }

  /**
   * A strategy failed for good. If its aUSDT was pulled but no buy was ever sent, return it.
   * Never refunds once a buy transaction exists, since that buy may have spent the aUSDT.
   */
  async abandon(intentId: string, user: string) {
    const id = `${intentId}:ENTRY`;
    const pull = this.repo.step(id, "pull");
    if (!pull || this.repo.step(id, "buy") || this.repo.step(id, "refund"))
      return null;
    const receipt = await this.pub
      .getTransactionReceipt({ hash: pull.tx_hash as Hex })
      .catch(() => null);
    if (receipt?.status !== "success") return null;
    const perm = this.repo.permission(intentId);
    const { vault } = await this.contracts();
    const logs = parseEventLogs({
      abi: VAULT,
      logs: receipt.logs,
      eventName: "Transfer",
    }) as unknown as {
      args: { from: Address; to: Address; value: bigint };
    }[];
    const moved = logs.find(
      (l) =>
        getAddress(l.args.to) === this.address &&
        getAddress(l.args.from) === getAddress(user),
    )?.args.value;
    if (!moved || !perm || getAddress(perm.token) !== vault) return null;
    const r = await this.transfer(id, "refund", getAddress(user), moved);
    return r.transactionHash;
  }

  private deadline() {
    return BigInt(this.now() + 600);
  }

  private async buy(r: ExecutionRequest): Promise<ExecutionResult> {
    const perm = this.repo.permission(r.intentId);
    if (!perm)
      throw new IntentError(
        "INSUFFICIENT_BALANCE",
        "This strategy has no MetaMask aUSDT permission. Deploy it again to grant one.",
        422,
      );
    if (perm.expiry && this.now() > perm.expiry)
      throw new IntentError(
        "INTENT_EXPIRED",
        "The MetaMask aUSDT permission for this strategy has expired.",
        410,
      );
    const user = getAddress(r.user);
    const country = await this.countryOf(r.stockId);
    const { vault, engine } = await this.contracts();
    const id = r.stockId as Hex;
    const [price] = await this.read<readonly [bigint, bigint, bigint, bigint]>(
      country,
      MARKET,
      "getStockPriceUSDT",
      [id],
    );
    const feeBps = await this.read<bigint>(engine, ENGINE, "tradingFeeBps");
    const spend = r.notionalUSDT ?? 0n;
    // Size so that cost + fee stays within the strategy's spend.
    let quantity = (spend * 10n ** 20n * BPS) / (price * (BPS + feeBps));
    let shares = 0n;
    // The engine rounds cost and fee up; trim until cost + fee fits the spend exactly.
    for (let i = 0; i < 4; i++) {
      if (quantity <= 0n)
        throw new IntentError(
          "TRADE_REVERTED",
          "Order size rounds to zero.",
          422,
        );
      const [assets, fee, s] = await this.read<
        readonly [bigint, bigint, bigint]
      >(engine, ENGINE, "quoteBuy", [country, id, quantity]);
      shares = s;
      if (assets + fee <= spend) break;
      quantity -= quantity / 1_000_000n + 1n;
    }
    const slip = BigInt(r.maxSlippageBps ?? Number(DEFAULT_SLIPPAGE_BPS));
    let pull = (shares * (BPS + slip)) / BPS;
    if (pull > BigInt(perm.allowance)) pull = BigInt(perm.allowance);
    const owned = await this.read<bigint>(vault, VAULT, "balanceOf", [user]);
    if (!this.repo.step(r.executionId, "pull") && owned < pull)
      throw new IntentError(
        "INSUFFICIENT_BALANCE",
        "Your aUSDT balance is below this trade. Convert USDT to aUSDT and it will retry.",
        422,
        undefined,
        true,
      );

    // 1. Pull aUSDT from the user's smart account through the granted permission.
    await this.step(r.executionId, "pull", () =>
      this.wallet.sendTransactionWithDelegation({
        to: vault,
        data: encodeFunctionData({
          abi: VAULT,
          functionName: "transfer",
          args: [this.address, pull],
        }),
        permissionContext: perm.context as Hex,
        delegationManager: perm.delegation_manager as Hex,
        chain: sepolia,
        account: this.wallet.account,
      }),
    );

    // 2. Buy. A deterministic revert returns the pulled aUSDT before failing.
    let receipt: TransactionReceipt;
    try {
      await this.approvals(country);
      receipt = await this.step(r.executionId, "buy", () =>
        this.write({
          address: engine,
          abi: ENGINE,
          functionName: "buy",
          args: [country, id, quantity, pull, this.deadline()],
        }),
      );
    } catch (e) {
      if (e instanceof IntentError && e.code === "TRADE_REVERTED") {
        await this.transfer(r.executionId, "refund", user, pull).catch(
          () => undefined,
        );
        throw new IntentError(
          "TRADE_REVERTED",
          `${e.message} Your aUSDT was returned.`,
          422,
        );
      }
      throw e;
    }
    const [ev] = parseEventLogs({
      abi: ENGINE,
      logs: receipt.logs,
      eventName: "StockPurchased",
    });
    const a = (
      ev as
        { args?: { assets: bigint; fee: bigint; shares: bigint } } | undefined
    )?.args;
    if (!a)
      throw new IntentError(
        "TRADE_REVERTED",
        "Buy confirmed without a purchase event.",
        500,
      );

    // 3. Return any aUSDT the buy did not use. The buy is final, so a failure here must not fail
    //    the trade: the change is recorded as owed and sent with the next payout instead.
    if (pull > a.shares) {
      this.repo.saveStep(
        r.executionId,
        "change-owed",
        "",
        (pull - a.shares).toString(),
        this.now(),
      );
      await this.settleOwed(r.executionId, user).catch(() => undefined);
    }

    return {
      txHash: receipt.transactionHash,
      fillPrice: price,
      quantity,
      notionalUSDT: a.assets,
      feeUSDT: a.fee,
      slippageBps: 0,
    };
  }

  private async sell(r: ExecutionRequest): Promise<ExecutionResult> {
    const user = getAddress(r.user);
    const country = await this.countryOf(r.stockId);
    const { engine } = await this.contracts();
    const id = r.stockId as Hex;
    const quantity = r.quantity ?? 0n;
    const [price] = await this.read<readonly [bigint, bigint, bigint, bigint]>(
      country,
      MARKET,
      "getStockPriceUSDT",
      [id],
    );
    const [, , shares] = await this.read<readonly [bigint, bigint, bigint]>(
      engine,
      ENGINE,
      "quoteSell",
      [country, id, quantity],
    );
    const slip = BigInt(r.maxSlippageBps ?? Number(DEFAULT_SLIPPAGE_BPS));
    await this.approvals(country);
    const receipt = await this.step(r.executionId, "sell", () =>
      this.write({
        address: engine,
        abi: ENGINE,
        functionName: "sell",
        args: [
          country,
          id,
          quantity,
          (shares * (BPS - slip)) / BPS,
          this.deadline(),
        ],
      }),
    );
    const [ev] = parseEventLogs({
      abi: ENGINE,
      logs: receipt.logs,
      eventName: "StockSold",
    });
    const a = (
      ev as
        { args?: { assets: bigint; fee: bigint; shares: bigint } } | undefined
    )?.args;
    if (!a)
      throw new IntentError(
        "TRADE_REVERTED",
        "Sell confirmed without a sale event.",
        500,
      );
    // Proceeds belong to the user: send them straight back, with any change still owed from entry.
    await this.transfer(r.executionId, "payout", user, a.shares);
    await this.settleOwed(`${r.intentId}:ENTRY`, user);
    return {
      txHash: receipt.transactionHash,
      fillPrice: price,
      quantity,
      notionalUSDT: a.assets,
      feeUSDT: a.fee,
      slippageBps: 0,
    };
  }
}

/**
 * Live portfolio for on-chain strategies: wallet USDT and vault claim from Sepolia, plus the
 * stock the executor holds for this user's open Atlas AI trades.
 */
export async function onchainPortfolio(
  executor: OnchainExecutor,
  repo: IntentRepository,
  prices: PriceSource,
  user: string,
  now: number,
): Promise<PortfolioView> {
  const { vaultAssets, walletUSDT } = await executor.balances(user);
  const { qty } = repo.ledger(user);
  const positions: PortfolioView["positions"] = [];
  let stockValue = 0n;
  for (const [stockId, q] of qty) {
    if (q <= 0n) continue;
    const quote = await prices.quote(stockId, now);
    const v = quote ? valueOf(q, parsePrice(quote.priceUSDT)) : 0n;
    stockValue += v;
    positions.push({
      stockId,
      country: assetByStockId(stockId)?.country ?? "??",
      valueUSDT: v,
      quantity: q,
    });
  }
  return {
    totalValueUSDT: vaultAssets + walletUSDT + stockValue,
    vaultAssetsUSDT: vaultAssets,
    walletUSDT,
    positions,
    activeIntents: repo.countActive(user),
  };
}
