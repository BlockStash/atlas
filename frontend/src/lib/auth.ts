import { api } from "./api";
import { connectMetaMask } from "./wallet";
import type { UserOnboardingState, WalletState } from "./types";
export type AtlasSession = {
  wallet: WalletState;
  profile: UserOnboardingState;
};
export async function signInWallet(
  onApproval: () => void,
  ensName?: string,
): Promise<AtlasSession> {
  const resolved = ensName
    ? await api<{ name: string; address: string }>(
        `/ens/resolve?name=${encodeURIComponent(ensName)}`,
      )
    : null;
  const result = await connectMetaMask(onApproval);
  if (
    resolved &&
    resolved.address.toLowerCase() !== result.address.toLowerCase()
  )
    throw new Error(
      "Connect the wallet that this Sepolia ENS name resolves to.",
    );
  const { message } = await api<{ message: string }>("/auth/challenge", {
    address: result.address,
    ...(resolved ? { ensName: resolved.name } : {}),
  });
  const signature = await result.provider.request({
    method: "personal_sign",
    params: [
      `0x${Array.from(new TextEncoder().encode(message))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`,
      result.address,
    ],
  });
  return api<AtlasSession>("/auth/verify", {
    address: result.address,
    signature,
  });
}
