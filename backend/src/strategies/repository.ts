import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { seedStrategies, type Position, type Strategy } from "./core.js";

/**
 * SQLite store for the strategy marketplace. Every strategy is one JSON document keyed by id, with
 * the columns needed for access control (owner, visibility) pulled out. The process is the only
 * writer and node:sqlite is synchronous, so each service call runs as one atomic transaction.
 */
const SEED_VERSION = "2";

export class StrategyRepository {
  readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
        seed INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS strategies_owner ON strategies(owner);
      CREATE INDEX IF NOT EXISTS strategies_visibility ON strategies(visibility);
      CREATE TABLE IF NOT EXISTS strategy_positions (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS strategy_positions_owner ON strategy_positions(owner);
      CREATE TABLE IF NOT EXISTS strategy_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.seed();
  }

  /** Seeds the public marketplace once; re-seeding is explicit via restoreSeeds(). */
  private seed() {
    this.migrateSeeds();
    const seeded = this.db
      .prepare("SELECT value FROM strategy_meta WHERE key = 'seeded'")
      .get();
    if (seeded) return;
    this.transaction(() => {
      this.restoreSeeds();
      this.db
        .prepare(
          "INSERT INTO strategy_meta (key, value) VALUES ('seeded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(new Date().toISOString());
    });
  }

  /**
   * v2: Atlas trades listed tokenized stocks only. Replace the demo seeds (v1 included crypto)
   * and drop positions left pointing at removed seeds. Users' own strategies are kept; any that
   * hold unlisted assets are refused by the service when cloned, backtested or deployed.
   */
  private migrateSeeds() {
    const row = this.db
      .prepare("SELECT value FROM strategy_meta WHERE key = 'seed_version'")
      .get();
    if (row && String(row.value) === SEED_VERSION) return;
    this.transaction(() => {
      if (
        this.db
          .prepare("SELECT value FROM strategy_meta WHERE key = 'seeded'")
          .get()
      ) {
        this.db.prepare("DELETE FROM strategies WHERE seed = 1").run();
        this.restoreSeeds();
        this.db
          .prepare(
            "DELETE FROM strategy_positions WHERE strategy_id NOT IN (SELECT id FROM strategies)",
          )
          .run();
      }
      this.db
        .prepare(
          "INSERT INTO strategy_meta (key, value) VALUES ('seed_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(SEED_VERSION);
    });
  }

  /** Re-inserts any seed strategy that is missing; existing seeds keep their live stats. */
  restoreSeeds() {
    for (const s of seedStrategies())
      this.db
        .prepare(
          "INSERT OR IGNORE INTO strategies (id, owner, visibility, seed, data, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
        )
        .run(
          s.id,
          s.creator.address.toLowerCase(),
          s.visibility,
          JSON.stringify(s),
          Date.parse(s.updatedAt),
        );
  }

  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Public strategies plus the viewer's own private ones, newest first. */
  visible(viewer?: string): Strategy[] {
    const rows = viewer
      ? this.db
          .prepare(
            "SELECT data FROM strategies WHERE visibility = 'public' OR owner = ? ORDER BY updated_at DESC",
          )
          .all(viewer.toLowerCase())
      : this.db
          .prepare(
            "SELECT data FROM strategies WHERE visibility = 'public' ORDER BY updated_at DESC",
          )
          .all();
    return rows.map((r) => JSON.parse(String(r.data)) as Strategy);
  }

  all(): Strategy[] {
    return this.db
      .prepare("SELECT data FROM strategies")
      .all()
      .map((r) => JSON.parse(String(r.data)) as Strategy);
  }

  get(id: string): Strategy | undefined {
    const row = this.db
      .prepare("SELECT data FROM strategies WHERE id = ?")
      .get(id);
    return row ? (JSON.parse(String(row.data)) as Strategy) : undefined;
  }

  save(s: Strategy) {
    this.db
      .prepare(
        `INSERT INTO strategies (id, owner, visibility, data, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, visibility = excluded.visibility,
           data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(
        s.id,
        s.creator.address.toLowerCase(),
        s.visibility,
        JSON.stringify(s),
        Date.parse(s.updatedAt),
      );
  }

  delete(id: string) {
    this.db
      .prepare("DELETE FROM strategy_positions WHERE strategy_id = ?")
      .run(id);
    this.db.prepare("DELETE FROM strategies WHERE id = ?").run(id);
  }

  positions(owner: string): Position[] {
    return this.db
      .prepare(
        "SELECT data FROM strategy_positions WHERE owner = ? ORDER BY created_at DESC",
      )
      .all(owner.toLowerCase())
      .map((r) => JSON.parse(String(r.data)) as Position);
  }

  position(id: string): (Position & { owner: string }) | undefined {
    const row = this.db
      .prepare("SELECT owner, data FROM strategy_positions WHERE id = ?")
      .get(id);
    return row
      ? {
          ...(JSON.parse(String(row.data)) as Position),
          owner: String(row.owner),
        }
      : undefined;
  }

  addPosition(owner: string, p: Position) {
    this.db
      .prepare(
        "INSERT INTO strategy_positions (id, owner, strategy_id, data, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        p.id,
        owner.toLowerCase(),
        p.strategyId,
        JSON.stringify(p),
        Date.parse(p.startedAt),
      );
  }

  deletePosition(id: string) {
    this.db.prepare("DELETE FROM strategy_positions WHERE id = ?").run(id);
  }

  /** Demo reset: drop the wallet's positions and the strategies it created that nobody else holds. */
  resetOwner(owner: string) {
    const key = owner.toLowerCase();
    this.db.prepare("DELETE FROM strategy_positions WHERE owner = ?").run(key);
    this.db
      .prepare(
        "DELETE FROM strategies WHERE owner = ? AND seed = 0 AND id NOT IN (SELECT strategy_id FROM strategy_positions)",
      )
      .run(key);
  }

  close() {
    this.db.close();
  }
}
