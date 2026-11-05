import { createEVMClient } from "@metamask/connect-evm";
import { SEPOLIA_CHAIN_ID, sepoliaRpc } from "./chain";
let client: Awaited<ReturnType<typeof createEVMClient>> | undefined;
export async function walletClient() {
  if (!client)
    client = await createEVMClient({
      dapp: { name: "Atlas", url: window.location.origin },
      api: { supportedNetworks: { [SEPOLIA_CHAIN_ID]: sepoliaRpc } },
    });
  return client;
}
export async function connectMetaMask(onApproval: () => void) {
  const sdk = await walletClient();
  onApproval();
  const { accounts, chainId } = await sdk.connect({
    chainIds: [SEPOLIA_CHAIN_ID],
  });
  if (!accounts[0])
    throw new Error("No wallet account was selected. Please try again.");
  if (chainId !== SEPOLIA_CHAIN_ID)
    await sdk.switchChain({ chainId: SEPOLIA_CHAIN_ID });
  const provider = sdk.getProvider();
  if ((await provider.request({ method: "eth_chainId" })) !== SEPOLIA_CHAIN_ID)
    throw new Error("Switch MetaMask to Sepolia to continue.");
  return { address: accounts[0], provider };
}
