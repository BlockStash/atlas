/**
 * Strategy subnames on ENSv2 (Sepolia).
 *
 * We use the "subnames as resolver records" model from the ENSv2 docs: the creator's root name
 * (e.g. `meera.eth`) points at a Permissioned Resolver they control, and we write records for full
 * names such as `global-growth.meera.eth` on that same resolver. The Universal Resolver finds the
 * parent's resolver and passes it the full name (ENSIP-10 wildcard), so no subregistry or token is
 * needed. Each subname's ETH address is the creator's own address, i.e. it resolves to the root.
 *
 * https://docs.ens.domains/ensv2/subnames · https://docs.ens.domains/ensv2/permissioned-resolver
 */
import { getAddressRecord, getResolver } from "@ensdomains/ensjs/public";
import { getOwner, hasRoles } from "@ensdomains/ensjs/public/v2";
import {
  deployVerifiableProxy,
  setResolver,
} from "@ensdomains/ensjs/wallet/v2";
import { RESOLVER_ALL_ROLES } from "@ensdomains/ensjs/utils/v2";
import {
  permissionedResolverInitializeSnippet,
  permissionedResolverMulticallSnippet,
  permissionedResolverSetAddressSnippet,
  permissionedResolverSetTextSnippet,
} from "@ensdomains/ensjs-abi/v2/permissionedResolver";
import {
  proxyDeployedEventSnippet,
  verifiableFactoryVerifyContractSnippet,
} from "@ensdomains/ensjs-abi/v2/verifiableFactory";
import { universalHelperFindParentRegistrySnippet } from "@ensdomains/ensjs-abi/v2/universalHelper";
import { getChainContractAddress } from "@ensdomains/ensjs/chain";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseEventLogs,
  toHex,
  zeroAddress,
  type Address,
  type Hash,
} from "viem";
import { normalize, packetToBytes } from "viem/ens";
import { sepoliaClient } from "./chain";
import { walletClient } from "./wallet";
import { assertSepoliaWallet } from "./transaction-validation";

export const ENS_APP = "https://sepolia.app.ens.domains";
export const ensAppUrl = (name: string) =>
  `${ENS_APP}/${encodeURIComponent(name)}`;

const dns = (name: string) => toHex(packetToBytes(normalize(name)));
const contract = (
  name:
    | "ensUniversalHelper"
    | "ensVerifiableFactory"
    | "ensPermissionedResolverImpl",
) => getChainContractAddress({ chain: sepoliaClient.chain, contract: name });

/** What the creator's root name needs before strategy subnames can be written under it. */
export type ParentStatus =
  /** The name uses an ENSv2 Permissioned Resolver this wallet may write address + text records on. */
  | { kind: "ready"; name: string; resolver: Address }
  /** Owned in ENSv2, but its resolver isn't a Permissioned Resolver this wallet controls. */
  | {
      kind: "needs-resolver";
      name: string;
      current: Address | null;
      registry: Address;
      label: string;
    }
  /** Not owned by this wallet in the ENSv2 registry (unmigrated v1 name, expired, or someone else's). */
  | { kind: "unavailable"; name: string; reason: string };

async function isPermissionedResolver(resolver: Address) {
  try {
    const impl = await sepoliaClient.readContract({
      address: contract("ensVerifiableFactory"),
      abi: verifiableFactoryVerifyContractSnippet,
      functionName: "verifyContract",
      args: [resolver],
    });
    return (
      getAddress(impl) === getAddress(contract("ensPermissionedResolverImpl"))
    );
  } catch {
    return false; // Not a factory proxy (e.g. a v1 Public Resolver).
  }
}

export async function inspectParent(
  input: string,
  account: string,
): Promise<ParentStatus> {
  const name = normalize(input);
  const me = getAddress(account);
  const resolver = await getResolver(sepoliaClient, { name });
  if (
    resolver &&
    (await isPermissionedResolver(resolver)) &&
    (await hasRoles(sepoliaClient, {
      resolverAddress: resolver,
      roles: ["ROLE_SET_ADDRESS", "ROLE_SET_TEXT"],
      account: me,
    }))
  )
    return { kind: "ready", name, resolver };

  const owner = await getOwner(sepoliaClient, { name }).catch(
    () => zeroAddress,
  );
  if (owner === zeroAddress)
    return {
      kind: "unavailable",
      name,
      reason: `${name} isn't registered to a wallet in the ENSv2 registry. If it's an ENSv1 name, migrate it in the ENS app first.`,
    };
  if (getAddress(owner) !== me)
    return {
      kind: "unavailable",
      name,
      reason: `${name} is owned by ${owner.slice(0, 6)}…${owner.slice(-4)}, not this wallet.`,
    };
  const registry = await sepoliaClient.readContract({
    address: contract("ensUniversalHelper"),
    abi: universalHelperFindParentRegistrySnippet,
    functionName: "findParentRegistry",
    args: [dns(name)],
  });
  const label = name.split(".")[0]!;
  const canSetResolver =
    registry !== zeroAddress &&
    (await hasRoles(sepoliaClient, {
      registryAddress: registry,
      label,
      roles: ["ROLE_SET_RESOLVER"],
      account: me,
    }).catch(() => false));
  if (!canSetResolver)
    return {
      kind: "unavailable",
      name,
      reason: `This wallet owns ${name} but can't change its resolver.`,
    };
  return { kind: "needs-resolver", name, current: resolver, registry, label };
}

async function signer(account: string) {
  const provider = (await walletClient()).getProvider();
  assertSepoliaWallet(
    await provider.request({ method: "eth_chainId" }),
    (await provider.request({ method: "eth_accounts" })) as string[],
    account,
  );
  return createWalletClient({
    chain: sepoliaClient.chain,
    account: getAddress(account),
    transport: custom(provider),
  });
}

async function confirmed(hash: Hash) {
  const receipt = await sepoliaClient.waitForTransactionReceipt({
    hash,
    timeout: 180_000,
  });
  if (receipt.status !== "success")
    throw new Error("The transaction reverted onchain.");
  return receipt;
}

/**
 * Gives the root name its own ENSv2 Permissioned Resolver (two transactions): deploy a proxy
 * through the Verifiable Factory, granting this wallet every resolver role and carrying over the
 * root's current ETH address, then point the name at it with `setResolver` on its registry.
 * Other records on the old resolver (avatar, texts) are not copied.
 */
export async function setupParentResolver(
  status: Extract<ParentStatus, { kind: "needs-resolver" }>,
  account: string,
  onStep: (step: "deploy" | "set-resolver", hash?: Hash) => void,
): Promise<Address> {
  const wallet = await signer(account);
  const me = getAddress(account);
  const existing = await getAddressRecord(sepoliaClient, {
    name: status.name,
    coin: "ETH",
  }).catch(() => null);
  const keep =
    existing?.value &&
    isAddress(existing.value) &&
    existing.value !== zeroAddress
      ? getAddress(existing.value)
      : me;
  const callData = encodeFunctionData({
    abi: permissionedResolverInitializeSnippet,
    functionName: "initialize",
    args: [
      [{ account: me, roleBitmap: RESOLVER_ALL_ROLES }],
      [
        encodeFunctionData({
          abi: permissionedResolverSetAddressSnippet,
          functionName: "setAddress",
          args: [dns(status.name), 60n, keep],
        }),
      ],
    ],
  });
  onStep("deploy");
  const deployHash = await deployVerifiableProxy(wallet, {
    factoryAddress: contract("ensVerifiableFactory"),
    implAddress: contract("ensPermissionedResolverImpl"),
    callData,
  });
  onStep("deploy", deployHash);
  const receipt = await confirmed(deployHash);
  const factory = contract("ensVerifiableFactory").toLowerCase();
  const deployed = parseEventLogs({
    abi: proxyDeployedEventSnippet,
    eventName: "ProxyDeployed",
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === factory),
  }).find((e) => getAddress(e.args.sender) === me);
  if (!deployed) throw new Error("Could not confirm the resolver deployment.");
  const resolver = getAddress(deployed.args.proxyAddress);

  onStep("set-resolver");
  const setHash = await setResolver(wallet, {
    registryAddress: status.registry,
    label: status.label,
    resolverAddress: resolver,
  });
  onStep("set-resolver", setHash);
  await confirmed(setHash);
  return resolver;
}

export interface SubnameEntry {
  /** Full subname, e.g. `global-growth.meera.eth`. */
  name: string;
  /** Public page for the strategy, stored as the `url` text record. */
  url: string;
  description: string;
}

/**
 * Writes every subname in one transaction: `multicall` of `setAddress(name, 60, account)` plus
 * `url` / `description` text records, on the root name's Permissioned Resolver.
 */
export async function publishSubnames(
  resolver: Address,
  account: string,
  entries: SubnameEntry[],
  onSent: (hash: Hash) => void,
): Promise<Hash> {
  if (!entries.length) throw new Error("Nothing to publish.");
  const wallet = await signer(account);
  const me = getAddress(account);
  const calls = entries.flatMap((e) => {
    const name = dns(e.name);
    return [
      encodeFunctionData({
        abi: permissionedResolverSetAddressSnippet,
        functionName: "setAddress",
        args: [name, 60n, me],
      }),
      encodeFunctionData({
        abi: permissionedResolverSetTextSnippet,
        functionName: "setText",
        args: [name, "url", e.url],
      }),
      ...(e.description
        ? [
            encodeFunctionData({
              abi: permissionedResolverSetTextSnippet,
              functionName: "setText",
              args: [name, "description", e.description.slice(0, 240)],
            }),
          ]
        : []),
    ];
  });
  const hash = await wallet.writeContract({
    address: resolver,
    abi: permissionedResolverMulticallSnippet,
    functionName: "multicall",
    args: [calls],
  });
  onSent(hash);
  await confirmed(hash);
  return hash;
}
