import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
} from "@arkiv-network/sdk";
import { defineSchema, str, bytes } from "@arkiv-network/sdk/schema";
import { and, eq } from "@arkiv-network/sdk/query";
import { hexToBytes, type Hex } from "viem";
import { arkivConnection } from "./arkiv-connection.js";
import { arkivGasGuard, ArkivGasGuardError } from "./arkiv-gas.js";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeProfile } from "./profile-migrations.js";
import { readFile } from "node:fs/promises";
import type { ArkivActivity, ProfileRepository } from "./profile-repository.js";
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
  accessKey?: string;
  chainId: number;
  privateKey: string;
  signerAddress?: string;
  encryptionKey: string;
  namespace: string;
  claimsFile: string;
  legacyFile?: string;
  /** Maximum fee (wei) one profile write may cost. Defaults to 0.02 tGLM. */
  maxFeeWei?: bigint;
}
export class ArkivProfileStore implements ProfileRepository {
  private publicClient;
  private walletClient;
  private crypto;
  private gas;
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
      connection = arkivConnection(options);
    if (
      options.signerAddress &&
      account.address.toLowerCase() !== options.signerAddress.toLowerCase()
    )
      throw new Error("ARKIV_PRIVATE_KEY must match ARKIV_SIGNER_ADDRESS.");
    this.publicClient = createPublicClient({
      ...connection,
    });
    this.walletClient = createWalletClient({
      account,
      ...connection,
    });
    this.gas = arkivGasGuard({
      chain: connection.chain,
      transport: connection.transport,
      account,
      publicClient: this.publicClient,
      maxFeeWei: options.maxFeeWei,
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
  /** Everything Atlas keeps in Arkiv for this wallet: the entity, its lifetime and a safe view of its contents. */
  async activity(address: string): Promise<ArkivActivity> {
    try {
      await this.ensureChain();
      const chainId = this.options.chainId;
      const found = await this.publicClient
        .select({
          $key: true,
          $owner: true,
          $creator: true,
          $createdAt: true,
          $updatedAt: true,
          $expiresAt: true,
          payload: true,
        } as never)
        .from(Profiles, { onMismatch: "throw" })
        .where(
          and(
            eq("namespace", this.options.namespace),
            eq("wallet_tag", this.crypto.walletTag(address)),
          ),
        )
        .ownedBy(this.walletClient.account.address)
        .createdBy(this.walletClient.account.address)
        .limit(1)
        .fetch();
      const base = {
        driver: "arkiv",
        ready: true,
        signerAddress: this.walletClient.account.address,
      };
      const currentBlock = await this.publicClient.getBlockNumber();
      const network = {
        name: "Arkiv Rabdi",
        chainId,
        currentBlock: currentBlock.toString(),
      };
      const row = found.entities[0] as unknown as
        | {
            $key: string;
            $owner: string;
            $creator: string;
            $createdAt: bigint | string | number;
            $updatedAt: bigint | string | number;
            $expiresAt: bigint | string | number;
            payload: { value: Hex };
          }
        | undefined;
      if (!row)
        return {
          ...base,
          network,
          message:
            "Nothing is stored in Arkiv for this wallet yet. Your profile is saved on your first update.",
        };
      const created = BigInt(row.$createdAt),
        updated = BigInt(row.$updatedAt),
        expires = BigInt(row.$expiresAt);
      const tsOf = async (n: bigint) => {
        try {
          const b = await this.publicClient.getBlock({ blockNumber: n });
          return Number(b.timestamp);
        } catch {
          return null;
        }
      };
      const [createdTs, updatedTs] = await Promise.all([
        tsOf(created),
        tsOf(updated),
      ]);
      const nowTs = Math.floor(Date.now() / 1000);
      // Rabdi block time from the entity's own age; used only to date the future expiry block.
      const span = Number(currentBlock - created);
      const blockSeconds =
        createdTs && span > 0 ? (nowTs - createdTs) / span : null;
      const expiresTs = blockSeconds
        ? Math.round(nowTs + Number(expires - currentBlock) * blockSeconds)
        : null;
      const iso = (t: number | null) =>
        t ? new Date(t * 1000).toISOString() : null;
      const payload = hexToBytes(row.payload.value);
      const profile = this.decode(address, row.payload.value);
      const yes = (b: boolean | undefined) => (b ? "Yes" : "No");
      const stored = [
        { label: "Wallet", value: profile.walletAddress },
        { label: "ENS name", value: profile.ensName ?? "Not linked" },
        {
          label: "Selected markets",
          value: profile.selectedMarkets.join(", ") || "None",
        },
        { label: "Preferred asset", value: profile.preferredAsset },
        { label: "Experience level", value: profile.experienceLevel },
        { label: "Onboarding step", value: String(profile.currentStep) },
        {
          label: "Onboarding complete",
          value: yes(profile.onboardingComplete),
        },
        {
          label: "Product tour complete",
          value: yes(profile.productTourComplete),
        },
        { label: "World ID verified", value: yes(profile.worldIdVerified) },
        { label: "Passkey verified", value: yes(profile.passkeyVerified) },
        {
          label: "Crypto account",
          value: profile.cryptoAccount ? "Linked" : "Not linked",
        },
        { label: "Last profile update", value: profile.updatedAt },
      ];
      const events: NonNullable<ArkivActivity["events"]> = [
        {
          at: iso(createdTs),
          block: created.toString(),
          title: "Profile created in Arkiv",
          detail: "An encrypted entity was written for your wallet.",
        },
      ];
      if (updated !== created)
        events.push({
          at: iso(updatedTs),
          block: updated.toString(),
          title: "Profile last updated",
          detail:
            "Your preferences or verification state changed and the entity was rewritten with a longer lifetime.",
        });
      events.push({
        at: iso(expiresTs),
        block: expires.toString(),
        title:
          expires > currentBlock
            ? "Entity expires (estimated)"
            : "Entity expired",
        detail: "Any profile update extends this automatically.",
      });
      return {
        ...base,
        network,
        entity: {
          key: row.$key,
          schema: "atlas.profiles.v1",
          namespace: this.options.namespace,
          owner: row.$owner,
          creator: row.$creator,
          payloadBytes: payload.length,
          encrypted: true,
          createdBlock: created.toString(),
          updatedBlock: updated.toString(),
          expiresBlock: expires.toString(),
          createdAt: iso(createdTs),
          updatedAt: iso(updatedTs),
          expiresAt: iso(expiresTs),
          daysLeft: expiresTs
            ? Math.max(0, Math.floor((expiresTs - nowTs) / 86400))
            : null,
        },
        stored,
        events,
      };
    } catch (error) {
      throw this.failure(error);
    }
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
      // Gas is bounded by the Rabdi guard (floor, 2× estimate, half block limit, fee cap).
      // Never resent automatically: a failed or uncertain write surfaces as an error.
      if (row)
        await this.gas.send(2, this.walletClient, (client, txParams) =>
          client.executeBatch(
            {
              patches: [
                {
                  schema: Profiles,
                  entityKey: row.$key,
                  set: { payload, ...identity },
                },
              ],
              extensions: [
                { entityKey: row.$key, expiration: ExpirationTime.max() },
              ],
            },
            txParams,
          ),
        );
      else
        await this.gas.send(1, this.walletClient, (client, txParams) =>
          client.createEntity(
            Profiles,
            {
              namespace: this.options.namespace,
              wallet_tag: this.crypto.walletTag(address),
              payload,
              ...identity,
            },
            { expiration: ExpirationTime.max() },
            txParams,
          ),
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
      // SDK messages can contain the keyed RPC URL. Keep access keys and
      // encrypted request payloads out of the application log. Gas guard
      // messages are fixed strings and safe to log.
      error instanceof ArkivGasGuardError
        ? `${error.name}: ${error.message}`
        : error instanceof Error
          ? error.name
          : "Unknown error",
    );
    return new VerificationError(
      "ARKIV_UNAVAILABLE",
      "Atlas could not save or load your Arkiv profile. Check the Rabdi connection and ARKIV_ACCESS_KEY, signer funding and encryption configuration, then connect again.",
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
  async activity(): Promise<ArkivActivity> {
    return { driver: "arkiv", ready: false, message: this.message };
  }
}
