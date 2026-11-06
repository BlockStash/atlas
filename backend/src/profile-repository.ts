import type { Profile } from "./types.js";
export interface ArkivActivity {
  driver: string;
  ready: boolean;
  message?: string;
  network?: { name: string; chainId: number; currentBlock: string };
  signerAddress?: string;
  entity?: {
    key: string;
    schema: string;
    namespace: string;
    owner: string;
    creator: string;
    payloadBytes: number;
    encrypted: true;
    createdBlock: string;
    updatedBlock: string;
    expiresBlock: string;
    createdAt: string | null;
    updatedAt: string | null;
    expiresAt: string | null;
    daysLeft: number | null;
  };
  /** What is stored, with secrets (nullifier, passkey keys, crypto account) left out. */
  stored?: { label: string; value: string }[];
  events?: {
    at: string | null;
    block: string;
    title: string;
    detail: string;
  }[];
}
export interface ProfileRepository {
  activity?(address: string): Promise<ArkivActivity>;
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
