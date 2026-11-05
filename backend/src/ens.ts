import {
  createPublicClient,
  http,
  getAddress,
  isAddress,
  zeroAddress,
} from "viem";
import { sepolia } from "viem/chains";
import { addEnsContracts } from "@ensdomains/ensjs";
import { getAddressRecord } from "@ensdomains/ensjs/public";
import { normalize } from "@ensdomains/ensjs/utils";
import { VerificationError } from "./world-id.js";
export function normalizedEnsName(input: string) {
  try {
    const name = normalize(input.trim());
    if (!name.includes(".") || name.length > 255) throw new Error();
    return name;
  } catch {
    throw new VerificationError(
      "ENS_INVALID",
      "Enter a valid ENS name, such as your-name.eth.",
      400,
    );
  }
}
export function createEnsResolver(rpcUrl: string) {
  const client = createPublicClient({
    chain: addEnsContracts(sepolia),
    transport: http(rpcUrl, { timeout: 12000, retryCount: 1 }),
  });
  return async (name: string): Promise<string | null> => {
    try {
      if ((await client.getChainId()) !== sepolia.id)
        throw new Error("Wrong ENS chain");
      const record = await getAddressRecord(client, {
        name: normalizedEnsName(name),
        coin: "ETH",
      });
      return record?.value &&
        isAddress(record.value) &&
        record.value !== zeroAddress
        ? getAddress(record.value)
        : null;
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      throw new VerificationError(
        "ENS_UNAVAILABLE",
        "ENS lookup is unavailable. Check the Sepolia connection and try again.",
        503,
      );
    }
  };
}
