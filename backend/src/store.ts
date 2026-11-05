import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { IdentityClaims } from "./identity-claims.js";
import { VerificationError } from "./world-id.js";
import { dirname } from "node:path";
import { defaultProfile, type Profile } from "./types.js";

/** Single-process profile store: writes are serialized and committed by atomic rename. */
export class ProfileStore {
  private claims: IdentityClaims;
  private profiles: Record<string, Profile> = {};
  private pending: Promise<void> = Promise.resolve();
  private ready: Promise<void>;
  constructor(private file: string) {
    this.claims = new IdentityClaims(`${file}.claims.sqlite`);
    this.ready = this.load();
  }
  private async load() {
    try {
      this.profiles = JSON.parse(await readFile(this.file, "utf8")) as Record<
        string,
        Profile
      >;
      for (const profile of Object.values(this.profiles))
        if (profile.worldIdNullifier)
          this.claims.claim(profile.worldIdNullifier, profile.walletAddress);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async status() {
    return { driver: "local", ready: true };
  }
  async get(address: string): Promise<Profile> {
    await this.ready;
    return structuredClone({
      ...defaultProfile(address),
      ...this.profiles[address.toLowerCase()],
    });
  }
  async update(address: string, patch: Partial<Profile>): Promise<Profile> {
    let result: Profile | undefined;
    const operation = this.pending.then(async () => {
      await this.ready;
      const key = address.toLowerCase();
      if (
        patch.worldIdNullifier &&
        Object.entries(this.profiles).some(
          ([other, profile]) =>
            other !== key &&
            profile.worldIdNullifier === patch.worldIdNullifier,
        )
      )
        throw new VerificationError(
          "WORLD_ID_ALREADY_LINKED",
          "This World ID is already linked to a different Atlas wallet.",
          409,
        );
      if (patch.worldIdNullifier)
        this.claims.claim(patch.worldIdNullifier, address);
      result = {
        ...defaultProfile(address),
        ...this.profiles[key],
        ...patch,
        walletAddress: address,
        updatedAt: new Date().toISOString(),
      };
      const next = { ...this.profiles, [key]: result };
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2), {
        mode: 0o600,
      });
      await rename(`${this.file}.tmp`, this.file);
      this.profiles = next;
    });
    this.pending = operation.catch(() => {});
    await operation;
    return structuredClone(result!);
  }
}
