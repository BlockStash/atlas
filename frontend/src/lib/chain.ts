import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { addEnsContracts } from "@ensdomains/ensjs";
export const SEPOLIA_CHAIN_ID = "0xaa36a7";
export const sepoliaRpc =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ||
  "https://ethereum-sepolia-rpc.publicnode.com";
export const sepoliaClient = createPublicClient({
  chain: addEnsContracts(sepolia),
  transport: http(sepoliaRpc, { timeout: 15000, retryCount: 1 }),
});
export { sepolia };
