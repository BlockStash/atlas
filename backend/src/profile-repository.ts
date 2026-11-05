import type { Profile } from "./types.js";
export interface ProfileRepository {
  get(address: string): Promise<Profile>;
  update(address: string, patch: Partial<Profile>): Promise<Profile>;
  status?(): Promise<{
    driver: string;
    ready: boolean;
    message?: string;
    chainId?: number;
    signerAddress?: string;
  }>;
}
