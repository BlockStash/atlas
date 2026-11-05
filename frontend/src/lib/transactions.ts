import {
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hash,
} from "viem";
import { sepolia, sepoliaClient } from "./chain";
import { walletClient } from "./wallet";
import { assertSepoliaWallet, parseTestAmount } from "./transaction-validation";
export { parseTestAmount } from "./transaction-validation";
export async function prepareTransfer(
  account: string,
  to: string,
  amount: string,
) {
  if (!isAddress(account) || !isAddress(to) || to === zeroAddress)
    throw new Error("Enter a valid recipient address.");
  const sdk = await walletClient(),
    provider = sdk.getProvider();
  // Check rather than auto-switch during a transfer: the user must reconnect on Sepolia first.
  const chain = await provider.request({ method: "eth_chainId" });
  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as string[];
  assertSepoliaWallet(chain, accounts, account);
  if ((await sepoliaClient.getChainId()) !== sepolia.id)
    throw new Error("The configured RPC is not Sepolia.");
  const value = parseTestAmount(amount),
    address = getAddress(account),
    recipient = getAddress(to);
  const [gas, fees, balance] = await Promise.all([
    sepoliaClient.estimateGas({ account: address, to: recipient, value }),
    sepoliaClient.estimateFeesPerGas(),
    sepoliaClient.getBalance({ address }),
  ]);
  const gasLimit = (gas * 120n + 99n) / 100n;
  const fee = gasLimit * fees.maxFeePerGas;
  if (balance < value + fee)
    throw new Error(
      "Not enough Sepolia ETH for the amount and estimated network fee.",
    );
  return {
    account: address,
    to: recipient,
    value,
    gas: gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    fee,
  };
}
export type TransferPreview = Awaited<ReturnType<typeof prepareTransfer>>;
export async function sendTestTransfer(
  preview: TransferPreview,
): Promise<Hash> {
  const sdk = await walletClient(),
    provider = sdk.getProvider();
  const chain = await provider.request({ method: "eth_chainId" });
  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as Address[];
  assertSepoliaWallet(chain, accounts, preview.account);
  const client = createWalletClient({
    chain: sepolia,
    transport: custom(provider),
  });
  const { account, to, value, gas, maxFeePerGas, maxPriorityFeePerGas } =
    preview;
  const transaction = {
    account,
    to,
    value,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
  return client.sendTransaction({ ...transaction, chain: sepolia, data: "0x" });
}
export function transactionMessage(error: unknown) {
  const value = error as {
    code?: number;
    message?: string;
    shortMessage?: string;
    cause?: { code?: number };
  };
  if (
    value?.code === 4001 ||
    value?.cause?.code === 4001 ||
    /rejected|denied/i.test(value?.message || "")
  )
    return "You rejected the wallet request. No transfer was submitted.";
  if (/insufficient funds/i.test(value?.message || ""))
    return "Not enough Sepolia ETH for this transfer and gas.";
  return (
    value?.shortMessage ||
    value?.message ||
    "The Sepolia request could not be completed. Please try again."
  );
}
