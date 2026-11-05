export type MarketId = "india" | "usa" | "uk" | "singapore" | "europe";
export interface Profile {
  walletAddress: string;
  ensName: string | null;
  ensChainId: number | null;
  ensVerifiedAt: string | null;
  selectedMarkets: MarketId[];
  preferredAsset: "USDT" | "ATLAS";
  experienceLevel: "beginner" | "intermediate" | "advanced";
  currentStep: number;
  worldIdVerified: boolean;
  worldIdVerifiedDemo: boolean;
  worldIdEnvironment?: "production" | "staging" | null;
  worldIdNullifier?: string;
  onboardingComplete: boolean;
  productTourComplete: boolean;
  updatedAt: string;
}
export interface WalletSession {
  address: string;
  network: string;
  demo: boolean;
}
export const defaultProfile = (address: string): Profile => ({
  walletAddress: address,
  ensName: null,
  ensChainId: null,
  ensVerifiedAt: null,
  selectedMarkets: ["india"],
  preferredAsset: "USDT",
  experienceLevel: "beginner",
  currentStep: 0,
  worldIdVerified: false,
  worldIdVerifiedDemo: false,
  worldIdEnvironment: null,
  onboardingComplete: false,
  productTourComplete: false,
  updatedAt: new Date().toISOString(),
});
