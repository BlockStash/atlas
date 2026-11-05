import { getAvailable, getRegisterPrice } from "@ensdomains/ensjs/public";
import { commitName, registerName } from "@ensdomains/ensjs/wallet";
import { deployVerifiableProxy } from "@ensdomains/ensjs/wallet/v2";
import { getChainContractAddress } from "@ensdomains/ensjs/chain";
import { randomSecret } from "@ensdomains/ensjs/utils";
import { RESOLVER_ALL_ROLES } from "@ensdomains/ensjs/utils/v2";
import { proxyDeployedEventSnippet } from "@ensdomains/ensjs-abi/v2/verifiableFactory";
import {
  permissionedResolverInitializeSnippet,
  permissionedResolverSetAddressSnippet,
} from "@ensdomains/ensjs-abi/v2/permissionedResolver";
import {
  ethRegistrarCommitmentsSnippet,
  ethRegistrarMakeCommitmentSnippet,
} from "@ensdomains/ensjs-abi/v2/ethRegistrar";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  zeroAddress,
  zeroHash,
  parseAbi,
  parseEventLogs,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { packetToBytes } from "viem/ens";
import { sepoliaClient } from "./chain";
import { walletClient } from "./wallet";
import { assertSepoliaWallet } from "./transaction-validation";
export type RegistrationAction =
  "resolver" | "commit" | "fund" | "approve" | "register";
export type ENSRegistration = {
  name: string;
  label: string;
  owner: Address;
  duration: number;
  secret: Hex;
  resolverAddress?: Address;
  commitHash?: Hash;
  registerHash?: Hash;
  pending?: { kind: RegistrationAction; hash: Hash };
};
import { registrationName } from "./ens-validation";
export { registrationName } from "./ens-validation";
export const ensContracts = () => ({
  registrar: getChainContractAddress({
    chain: sepoliaClient.chain,
    contract: "ensEthRegistrar",
  }),
  token: getChainContractAddress({
    chain: sepoliaClient.chain,
    contract: "usdc",
  }),
  factory: getChainContractAddress({
    chain: sepoliaClient.chain,
    contract: "ensVerifiableFactory",
  }),
  resolverImpl: getChainContractAddress({
    chain: sepoliaClient.chain,
    contract: "ensPermissionedResolverImpl",
  }),
});
async function checkedWallet(account: string) {
  const provider = (await walletClient()).getProvider();
  assertSepoliaWallet(
    await provider.request({ method: "eth_chainId" }),
    (await provider.request({ method: "eth_accounts" })) as string[],
    account,
  );
  if ((await sepoliaClient.getChainId()) !== 11155111)
    throw new Error("The RPC must point to Sepolia.");
  return createWalletClient({
    chain: sepoliaClient.chain,
    account: getAddress(account),
    transport: custom(provider),
  });
}
export async function registrationQuote(input: string, owner: string) {
  const name = registrationName(input),
    label = name.slice(0, -4),
    { token, registrar } = ensContracts();
  if (!(await getAvailable(sepoliaClient, { name })))
    throw new Error("This Sepolia ENS name is already registered or reserved.");
  const price = await getRegisterPrice(sepoliaClient, {
    label,
    duration: 31536000n,
    paymentToken: token,
  });
  const [balance, allowance, decimals, symbol] = await Promise.all([
    sepoliaClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(owner)],
    }),
    sepoliaClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [getAddress(owner), registrar],
    }),
    sepoliaClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    sepoliaClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
    }),
  ]);
  return {
    name,
    price: price.base + price.premium,
    balance,
    allowance,
    decimals,
    symbol,
    token,
    registrar,
  };
}
export function newRegistration(input: string, owner: string): ENSRegistration {
  const name = registrationName(input);
  return {
    name,
    label: name.slice(0, -4),
    owner: getAddress(owner),
    duration: 31536000,
    secret: randomSecret(),
  };
}
export async function registrationTiming(reg: ENSRegistration) {
  const { registrar } = ensContracts();
  const commitment = await sepoliaClient.readContract({
    address: registrar,
    abi: ethRegistrarMakeCommitmentSnippet,
    functionName: "makeCommitment",
    args: [
      reg.label,
      reg.owner,
      reg.secret,
      zeroAddress,
      reg.resolverAddress || zeroAddress,
      BigInt(reg.duration),
      zeroHash,
    ],
  });
  const [at, min, max, block] = await Promise.all([
    sepoliaClient.readContract({
      address: registrar,
      abi: ethRegistrarCommitmentsSnippet,
      functionName: "commitmentAt",
      args: [commitment],
    }),
    sepoliaClient.readContract({
      address: registrar,
      abi: parseAbi(["function MIN_COMMITMENT_AGE() view returns (uint64)"]),
      functionName: "MIN_COMMITMENT_AGE",
    }),
    sepoliaClient.readContract({
      address: registrar,
      abi: parseAbi(["function MAX_COMMITMENT_AGE() view returns (uint64)"]),
      functionName: "MAX_COMMITMENT_AGE",
    }),
    sepoliaClient.getBlock(),
  ]);
  if (at === 0n) return { seconds: 0, expired: true };
  return {
    seconds: Math.max(0, Number(at + min - block.timestamp)),
    expired: block.timestamp >= at + max,
  };
}
export async function sendRegistrationStep(
  reg: ENSRegistration,
  kind: RegistrationAction,
): Promise<Hash> {
  const wallet = await checkedWallet(reg.owner),
    { token, registrar, factory, resolverImpl } = ensContracts();
  if (kind === "resolver") {
    const setAddress = encodeFunctionData({
      abi: permissionedResolverSetAddressSnippet,
      functionName: "setAddress",
      args: [toHex(packetToBytes(reg.name)), 60n, reg.owner],
    });
    const callData = encodeFunctionData({
      abi: permissionedResolverInitializeSnippet,
      functionName: "initialize",
      args: [
        [{ account: reg.owner, roleBitmap: RESOLVER_ALL_ROLES }],
        [setAddress],
      ],
    });
    return deployVerifiableProxy(wallet, {
      factoryAddress: factory,
      implAddress: resolverImpl,
      callData,
    });
  }
  if (kind === "commit") {
    if (!reg.resolverAddress) throw new Error("Create the resolver first.");
    return commitName(wallet, reg);
  }
  const quote = await registrationQuote(reg.name, reg.owner);
  if (kind === "fund")
    return wallet.writeContract({
      address: token,
      abi: parseAbi(["function mint(address to,uint256 amount)"]),
      functionName: "mint",
      args: [reg.owner, quote.price + 100n * 10n ** BigInt(quote.decimals)],
    });
  if (kind === "approve")
    return wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [registrar, quote.price],
    });
  if (!reg.resolverAddress || !reg.commitHash)
    throw new Error("Complete the resolver and commitment steps first.");
  const timing = await registrationTiming(reg);
  if (timing.expired)
    throw new Error("The commitment expired. Start a new registration.");
  if (timing.seconds > 0)
    throw new Error(`Wait ${timing.seconds} more seconds for the commitment.`);
  if (quote.balance < quote.price)
    throw new Error("Get Sepolia test payment tokens first.");
  if (quote.allowance < quote.price)
    throw new Error("Approve the current registration price first.");
  return registerName(wallet, reg);
}
export function completeRegistrationStep(
  reg: ENSRegistration,
  receipt: TransactionReceipt,
): ENSRegistration {
  if (!reg.pending) throw new Error("No pending registration transaction.");
  if (receipt.status !== "success")
    throw new Error("The registration transaction reverted.");
  const next = { ...reg, pending: undefined };
  if (reg.pending.kind === "resolver") {
    const { factory, resolverImpl } = ensContracts();
    const events = parseEventLogs({
      abi: proxyDeployedEventSnippet,
      eventName: "ProxyDeployed",
      logs: receipt.logs.filter(
        (log) => log.address.toLowerCase() === factory.toLowerCase(),
      ),
    });
    const event = events.find(
      (e) =>
        e.args.sender.toLowerCase() === reg.owner.toLowerCase() &&
        e.args.implementation.toLowerCase() === resolverImpl.toLowerCase(),
    );
    if (!event) throw new Error("Could not confirm your resolver deployment.");
    next.resolverAddress = event.args.proxyAddress;
  }
  if (reg.pending.kind === "commit") next.commitHash = receipt.transactionHash;
  if (reg.pending.kind === "register")
    next.registerHash = receipt.transactionHash;
  return next;
}
