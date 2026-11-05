import { getAddressRecord, getName } from "@ensdomains/ensjs/public";
import { normalize } from "@ensdomains/ensjs/utils";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { sepoliaClient } from "./chain";
export async function resolveRecipient(
  input: string,
): Promise<{ address: Address; name: string | null }> {
  const value = input.trim();
  if (isAddress(value)) {
    const address = getAddress(value);
    if (address === zeroAddress)
      throw new Error("Enter a recipient other than the zero address.");
    return { address, name: null };
  }
  if (!value.includes("."))
    throw new Error("Enter an Ethereum address or ENS name.");
  const name = normalize(value);
  const record = await getAddressRecord(sepoliaClient, { name, coin: "ETH" });
  if (
    !record?.value ||
    !isAddress(record.value) ||
    record.value === zeroAddress
  )
    throw new Error("This name has no Ethereum address record on Sepolia.");
  return { address: getAddress(record.value), name };
}
export async function lookupPrimaryName(address: Address) {
  const result = await getName(sepoliaClient, { address });
  return result?.match && result.normalized ? result.name : null;
}
