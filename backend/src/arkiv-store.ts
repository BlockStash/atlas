import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
} from "@arkiv-network/sdk";
import { defineSchema, str, bytes } from "@arkiv-network/sdk/schema";
import { and, eq } from "@arkiv-network/sdk/query";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeProfile } from "./profile-migrations.js";
import { readFile } from "node:fs/promises";
import type { ProfileRepository } from "./profile-repository.js";
import { defaultProfile, type Profile } from "./types.js";
import { profileCrypto } from "./profile-crypto.js";
import { IdentityClaims } from "./identity-claims.js";
import { VerificationError } from "./world-id.js";
const Profiles = defineSchema("atlas.profiles.v1", {
  namespace: str().indexed(),
  wallet_tag: str().indexed(),
  identity_tag: str().indexed().optional(),
  payload: bytes(),
});
export interface ArkivStoreOptions {
  rpcUrl: string;
  chainId: number;
  privateKey: string;
  signerAddress?: string;
  encryptionKey: string;
  namespace: string;
  claimsFile: string;
  legacyFile?: string;
}
export class ArkivProfileStore implements ProfileRepository {
  private publicClient;
  private walletClient;
  private crypto;
  private claims: IdentityClaims;
  private pending: Promise<void> = Promise.resolve();
  private chainChecked = false;
  constructor(private options: ArkivStoreOptions) {
    if (options.chainId !== 7794095)
      throw new Error("This Arkiv SDK adapter supports Rabdi chain 7794095.");
    if (!/^(0x)?[a-fA-F0-9]{64}$/.test(options.privateKey))
      throw new Error(
        "Set ARKIV_PRIVATE_KEY to a dedicated funded Rabdi signer in backend/.env.",
      );
    const account = privateKeyToAccount(
        (options.privateKey.startsWith("0x")
          ? options.privateKey
          : `0x${options.privateKey}`) as Hex,
      ),
      chain = rabdi({ accessKey: "" });
    if (
      options.signerAddress &&
      account.address.toLowerCase() !== options.signerAddress.toLowerCase()
    )
      throw new Error("ARKIV_PRIVATE_KEY must match ARKIV_SIGNER_ADDRESS.");
    this.publicClient = createPublicClient({
      chain,
      transport: http(options.rpcUrl, { timeout: 15000, retryCount: 1 }),
    });
    this.walletClient = createWalletClient({
      account,
      chain,
      transport: http(options.rpcUrl, { timeout: 15000, retryCount: 1 }),
    });
    this.crypto = profileCrypto(options.encryptionKey, options.namespace);
    this.claims = new IdentityClaims(options.claimsFile);
  }
  private async ensureChain() {
    if (!this.chainChecked) {
      if ((await this.publicClient.getChainId()) !== this.options.chainId)
        throw new Error(
          "Arkiv RPC chain does not match the configured network.",
        );
      this.chainChecked = true;
    }
  }
  async status() {
    await this.ensureChain();
    const balance = await this.publicClient.getBalance({
      address: this.walletClient.account.address,
    });
    return {
      driver: "arkiv",
      ready: balance > 0n,
      chainId: this.options.chainId,
      signerAddress: this.walletClient.account.address,
      message:
        balance === 0n
          ? "Fund the Arkiv signer with Rabdi test tGLM before saving profiles."
          : undefined,
    };
  }
  private async row(address: string) {
    await this.ensureChain();
    const result = await this.publicClient
      .select({ $key: true, payload: true })
      .from(Profiles, { onMismatch: "throw" })
      .where(
        and(
          eq("namespace", this.options.namespace),
          eq("wallet_tag", this.crypto.walletTag(address)),
        ),
      )
      .ownedBy(this.walletClient.account.address)
      .createdBy(this.walletClient.account.address)
      .limit(2)
      .fetch();
    if (result.entities.length > 1)
      throw new Error("Duplicate Arkiv profile entities require repair.");
    return result.entities[0];
  }
  private decode(address: string, payload: Hex) {
    const profile = this.crypto.decrypt<Profile>(address, hexToBytes(payload));
    if (profile.walletAddress.toLowerCase() !== address.toLowerCase())
      throw new Error("Profile wallet mismatch");
    return normalizeProfile(address, profile);
  }
  private async legacy(address: string) {
    if (!this.options.legacyFile) return defaultProfile(address);
    try {
      const profiles = JSON.parse(
        await readFile(this.options.legacyFile, "utf8"),
      ) as Record<string, Profile>;
      // Import legacy identity claims before accepting any new claim.
      for (const profile of Object.values(profiles))
        if (profile.worldIdNullifier)
          this.claims.claim(profile.worldIdNullifier, profile.walletAddress);
      return normalizeProfile(address, profiles[address.toLowerCase()]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return defaultProfile(address);
      throw error;
    }
  }
  async get(address: string) {
    try {
      const row = await this.row(address);
      return row
        ? this.decode(address, row.payload.value)
        : await this.legacy(address);
    } catch (error) {
      throw this.failure(error);
    }
  }
  async update(address: string, patch: Partial<Profile>) {
    let result: Profile | undefined;
    const operation = this.pending.then(async () => {
      const row = await this.row(address),
        previous = row
          ? this.decode(address, row.payload.value)
          : await this.legacy(address);
      const next = { ...previous, ...patch, walletAddress: address };
      if (row && JSON.stringify(next) === JSON.stringify(previous)) {
        result = previous;
        return;
      }
      if (patch.worldIdNullifier) {
        const matches = await this.publicClient
          .select({ wallet_tag: true })
          .from(Profiles)
          .where(
            and(
              eq("namespace", this.options.namespace),
              eq(
                "identity_tag",
                this.crypto.walletTag(`identity:${patch.worldIdNullifier}`),
              ),
            ),
          )
          .ownedBy(this.walletClient.account.address)
          .createdBy(this.walletClient.account.address)
          .limit(2)
          .fetch();
        if (
          matches.entities.some(
            (row) => row.wallet_tag.value !== this.crypto.walletTag(address),
          )
        )
          throw new VerificationError(
            "WORLD_ID_ALREADY_LINKED",
            "This World ID is already linked to a different Atlas wallet.",
            409,
          );
        this.claims.claim(patch.worldIdNullifier, address);
      }
      next.updatedAt = new Date().toISOString();
      const payload = this.crypto.encrypt(address, next);
      const identity = next.worldIdNullifier
        ? {
            identity_tag: this.crypto.walletTag(
              `identity:${next.worldIdNullifier}`,
            ),
          }
        : {};
      if (row)
        await this.walletClient.executeBatch({
          patches: [
            {
              schema: Profiles,
              entityKey: row.$key,
              set: { payload, ...identity },
            },
          ],
          extensions: [
            { entityKey: row.$key, expiration: ExpirationTime.fromDays(30) },
          ],
        });
      else
        await this.walletClient.createEntity(
          Profiles,
          {
            namespace: this.options.namespace,
            wallet_tag: this.crypto.walletTag(address),
            payload,
            ...identity,
          },
          { expiration: ExpirationTime.fromDays(30) },
        );
      result = next;
    });
    this.pending = operation.catch(() => {});
    try {
      await operation;
      return structuredClone(result!);
    } catch (error) {
      throw this.failure(error);
    }
  }
  private failure(error: unknown) {
    if (error instanceof VerificationError) return error;
    console.error(
      "[arkiv] profile operation failed:",
      error instanceof Error ? error.message : error,
    );
    return new VerificationError(
      "ARKIV_UNAVAILABLE",
      "Atlas could not save or load your Arkiv profile. Check the Rabdi connection, signer funding and encryption configuration.",
      503,
    );
  }
}
/** Fail closed when Arkiv is selected but runtime configuration is incomplete. */
export class UnavailableProfileStore implements ProfileRepository {
  constructor(private message: string) {}
  async get(_address: string): Promise<Profile> {
    throw new VerificationError("ARKIV_SETUP_REQUIRED", this.message, 503);
  }
  async update(_address: string, _patch: Partial<Profile>): Promise<Profile> {
    throw new VerificationError("ARKIV_SETUP_REQUIRED", this.message, 503);
  }
  async status() {
    return { driver: "arkiv", ready: false, message: this.message };
  }
}
