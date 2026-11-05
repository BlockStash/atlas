import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { VerificationError } from "./world-id.js";
/** Arkiv has no unique constraints; this single-writer POC keeps the identity replay ledger transactional. */
export class IdentityClaims {
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS world_id_claims (scope TEXT NOT NULL, nullifier TEXT NOT NULL CHECK(length(nullifier) BETWEEN 1 AND 78 AND nullifier NOT GLOB '*[^0-9]*'), wallet TEXT NOT NULL, PRIMARY KEY(scope,nullifier)) STRICT;`,
    );
  }
  claim(value: string, address: string) {
    const split = value.lastIndexOf(":");
    if (split < 1) throw new Error("Invalid identity claim scope");
    const scope = value.slice(0, split),
      nullifier = BigInt(value.slice(split + 1)).toString(10),
      wallet = address.toLowerCase();
    if (BigInt(nullifier) < 0n || BigInt(nullifier) >= 1n << 256n)
      throw new Error("Invalid identity nullifier");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare(
          "SELECT wallet FROM world_id_claims WHERE scope=? AND nullifier=?",
        )
        .get(scope, nullifier);
      if (previous && previous.wallet !== wallet)
        throw new VerificationError(
          "WORLD_ID_ALREADY_LINKED",
          "This World ID is already linked to a different Atlas wallet.",
          409,
        );
      if (!previous)
        this.db
          .prepare(
            "INSERT INTO world_id_claims(scope,nullifier,wallet) VALUES(?,?,?)",
          )
          .run(scope, nullifier, wallet);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
