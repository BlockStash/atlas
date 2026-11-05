export type MarketId = "india" | "usa" | "uk" | "china" | "europe";
export type PaymentAssetPreference = "USDT" | "ATLAS";
export type InvestorExperience = "beginner" | "intermediate" | "advanced";
export type MarketPreference = {
  id: MarketId;
  name: string;
  flag: string;
  exchange: string;
  currency: string;
  zone: string;
  index: string;
  value: string;
  change: string;
  open: boolean;
};
export type WalletState = { address: string; network: string; demo: boolean };
export type WorldIDVerificationState =
  | "idle"
  | "waiting"
  | "verifying"
  | "verified"
  | "cancelled"
  | "failed"
  | "unavailable";
export type UserOnboardingState = {
  ensName: string | null;
  ensChainId: number | null;
  ensVerifiedAt: string | null;
  worldIdVerified: boolean;
  worldIdVerifiedDemo: boolean;
  worldIdEnvironment: "production" | "staging" | null;
  selectedMarkets: MarketId[];
  preferredAsset: PaymentAssetPreference;
  experienceLevel: InvestorExperience;
  currentStep: number;
  onboardingComplete: boolean;
  productTourComplete: boolean;
};
