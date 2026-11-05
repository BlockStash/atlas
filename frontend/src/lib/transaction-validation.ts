import { parseEther } from "viem";
export function parseTestAmount(amount: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(amount))
    throw new Error(
      "Enter a positive ETH amount with up to 18 decimal places.",
    );
  const value = parseEther(amount);
  if (value <= 0n) throw new Error("Enter an amount greater than zero.");
  return value;
}
export function assertSepoliaWallet(
  chain: unknown,
  accounts: string[],
  account: string,
) {
  if (chain !== "0xaa36a7")
    throw new Error("Switch to Sepolia and reconnect before sending.");
  if (accounts[0]?.toLowerCase() !== account.toLowerCase())
    throw new Error("Your wallet account changed. Reconnect before sending.");
}
