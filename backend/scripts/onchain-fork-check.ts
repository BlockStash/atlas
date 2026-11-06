/**
 * End-to-end check of live Atlas AI execution against a LOCAL Sepolia fork (anvil). Nothing is
 * sent to Sepolia itself.
 *
 *   anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --port 8547
 *   FORK_RPC=http://127.0.0.1:8547 npx tsx scripts/onchain-fork-check.ts
 *
 * It upgrades a test account to MetaMask's EIP-7702 delegator, funds it with USDT → aUSDT, signs
 * the same aUSDT allowance delegation MetaMask grants via ERC-7715, then runs the executor's buy
 * and sell and checks every balance.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  type Abi,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  createDelegation,
  getSmartAccountsEnvironment,
  signDelegation,
} from "@metamask/smart-accounts-kit";
import { encodeDelegations } from "@metamask/smart-accounts-kit/utils";
import abis from "../src/protocol/abis.json" with { type: "json" };
import { IntentRepository } from "../src/intent/repository.js";
import { OnchainExecutor } from "../src/intent/onchain.js";
import { resolveAsset } from "../src/intent/assets.js";

const RPC = process.env.FORK_RPC || "http://127.0.0.1:8547";
// anvil's well-known dev keys: test user and executor. Fork-only, never funded on Sepolia.
const USER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
// A fresh executor every run: well-known dev keys may carry code on Sepolia.
const EXECUTOR_KEY = generatePrivateKey();

const m = JSON.parse(
  readFileSync("../contracts/deployments/sepolia-v2.json", "utf8"),
);
const chain = { ...sepolia, rpcUrls: { default: { http: [RPC] } } };
const transport = http(RPC);
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });
const user = privateKeyToAccount(USER_KEY);
const userWallet = createWalletClient({ account: user, chain, transport });
const env = getSmartAccountsEnvironment(sepolia.id);
const VAULT = abis.AtlasVault as Abi,
  USDT = abis.AtlasUSDT as Abi,
  MARKET = abis.AtlasCountryMarket as Abi;
const vault = getAddress(m.atlasVault),
  usdt = getAddress(m.atlasUSDT);

const read = <T>(address: Hex, abi: Abi, functionName: string, args: unknown[]) =>
  pub.readContract({ address, abi, functionName, args }) as Promise<T>;
const send = async (hash: Promise<Hex>) =>
  assert.equal(
    (await pub.waitForTransactionReceipt({ hash: await hash })).status,
    "success",
  );

// 1. Upgrade the test user to MetaMask's EIP-7702 stateless delegator (what MetaMask does).
const auth = await userWallet.signAuthorization({
  contractAddress: env.implementations.EIP7702StatelessDeleGatorImpl,
  executor: "self",
});
await send(
  userWallet.sendTransaction({ to: user.address, authorizationList: [auth] }),
);
console.log("user upgraded to 7702 delegator:", user.address);

// 2. Mint USDT as the deployer (impersonated on the fork) and deposit 1,500 into the vault.
const deployer = getAddress(m.settings.deployer);
await test.impersonateAccount({ address: deployer });
await test.setBalance({ address: deployer, value: 10n ** 18n });
const deployerWallet = createWalletClient({ account: deployer, chain, transport });
await send(
  deployerWallet.writeContract({
    address: usdt,
    abi: USDT,
    functionName: "mint",
    args: [user.address, parseUnits("2000", 6)],
  }),
);
await send(
  userWallet.writeContract({
    address: usdt,
    abi: USDT,
    functionName: "approve",
    args: [vault, parseUnits("1500", 6)],
  }),
);
await send(
  userWallet.writeContract({
    address: vault,
    abi: VAULT,
    functionName: "deposit",
    args: [parseUnits("1500", 6), user.address],
  }),
);

// 3. The executor and the permission MetaMask would grant: an aUSDT allowance to the executor.
const repo = new IntentRepository(":memory:");
const executor = new OnchainExecutor(repo, EXECUTOR_KEY, RPC);
await test.setBalance({ address: executor.address, value: 10n ** 18n });
const spend = parseUnits("1000", 6);
const req = await executor.permissionRequest(spend, 100);
const delegation = createDelegation({
  environment: env,
  from: user.address,
  to: executor.address,
  scope: {
    type: "erc20TransferAmount",
    tokenAddress: req.tokenAddress,
    maxAmount: req.allowanceShares,
  },
});
const signature = await signDelegation({
  privateKey: USER_KEY,
  delegation,
  delegationManager: env.DelegationManager,
  chainId: sepolia.id,
});
const context = encodeDelegations([{ ...delegation, signature }]);
executor.verifyPermission(
  { context, delegationManager: env.DelegationManager },
  user.address,
);
const intentId = "0x" + "ab".repeat(32);
repo.savePermission({
  intent_id: intentId,
  context,
  delegation_manager: env.DelegationManager,
  token: req.tokenAddress,
  allowance: req.allowanceShares.toString(),
  expiry: null,
  created_at: Math.floor(Date.now() / 1000),
});

// 4. Buy 1,000 USDT of Apple, then sell it.
const aapl = resolveAsset("AAPL")!;
const usa = getAddress(m.countries.find((c: { region: string }) => c.region === aapl.region).address);
const before = await executor.balances(user.address);
const buy = await executor.execute({
  executionId: `${intentId}:ENTRY`,
  intentId,
  kind: "ENTRY",
  side: "BUY",
  user: user.address,
  stockId: aapl.stockId,
  exchange: aapl.exchange,
  referencePrice: 0n,
  notionalUSDT: spend,
  maxSlippageBps: 100,
  now: Math.floor(Date.now() / 1000),
});
const held = await read<bigint>(usa, MARKET, "balanceOf", [executor.address, BigInt(aapl.stockId)]);
const mid = await executor.balances(user.address);
console.log("buy", {
  tx: buy.txHash,
  quantity: buy.quantity.toString(),
  costUSDT: Number(buy.notionalUSDT + buy.feeUSDT) / 1e6,
  userVaultUSDT: [Number(before.vaultAssets) / 1e6, Number(mid.vaultAssets) / 1e6],
  executorHolds: held.toString(),
});
assert.equal(held, buy.quantity);
assert.ok(buy.notionalUSDT + buy.feeUSDT <= spend);
const spentByUser = before.vaultAssets - mid.vaultAssets;
assert.ok(
  spentByUser >= buy.notionalUSDT && spentByUser <= buy.notionalUSDT + buy.feeUSDT + 2n,
  `user paid ${spentByUser}`,
);
// A retried entry is idempotent: steps are not resent.
const steps = repo.steps(intentId).length;

const sell = await executor.execute({
  executionId: `${intentId}:EXIT`,
  intentId,
  kind: "EXIT",
  side: "SELL",
  user: user.address,
  stockId: aapl.stockId,
  exchange: aapl.exchange,
  referencePrice: 0n,
  quantity: buy.quantity,
  maxSlippageBps: 100,
  now: Math.floor(Date.now() / 1000),
});
const after = await executor.balances(user.address);
const left = await read<bigint>(usa, MARKET, "balanceOf", [executor.address, BigInt(aapl.stockId)]);
console.log("sell", {
  tx: sell.txHash,
  proceedsUSDT: Number(sell.notionalUSDT - sell.feeUSDT) / 1e6,
  userVaultUSDT: Number(after.vaultAssets) / 1e6,
  executorHolds: left.toString(),
});
assert.equal(left, 0n);
assert.ok(after.vaultAssets > mid.vaultAssets);
console.log(
  "steps:",
  repo.steps(intentId).map((s) => `${s.step} ${s.tx_hash.slice(0, 12)}…`),
  `(entry used ${steps})`,
);
console.log("OK: delegated buy and sell executed on the fork");
process.exit(0);
