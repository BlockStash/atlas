import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AtlasIntentStatus, AtlasTradeIntent } from "./types.js";

export interface IntentRow {
  id: string;
  user_address: string;
  original_prompt: string;
  normalized_intent_json: string;
  strategy_hash: string;
  status: AtlasIntentStatus;
  created_at: number;
  updated_at: number;
  valid_after: number | null;
  valid_until: number | null;
  nonce: number;
  signature: string | null;
  signature_type: string | null;
  max_spend_usdt: string;
  version: number;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  next_attempt_at: number;
  lease_until: number;
  close_requested: number;
  last_block: string | null;
  demo: number;
  onchain_tx: string | null;
}
export interface PositionRow {
  id: string;
  intent_id: string;
  user_address: string;
  stock_id: string;
  quantity: string;
  entry_price_usdt: string;
  current_price_usdt: string;
  status: "OPEN" | "CLOSED";
  source: "ENTRY_TRADE" | "REFERENCE";
  opened_at: number;
  closed_at: number | null;
  exit_reason: string | null;
}
export interface ExecutionRow {
  id: string;
  intent_id: string;
  kind: "ENTRY" | "EXIT";
  side: "BUY" | "SELL";
  user_address: string;
  stock_id: string;
  quantity: string;
  price_usdt: string;
  notional_usdt: string;
  slippage_bps: number;
  fee_usdt: string;
  tx_hash: string | null;
  executed_at: number;
}
export interface EventRow {
  id: number;
  intent_id: string;
  event_type: string;
  payload: string;
  timestamp: number;
}
export interface NotificationRow {
  id: number;
  user_address: string;
  intent_id: string;
  kind: string;
  message: string;
  created_at: number;
  read: number;
}

export const TERMINAL: AtlasIntentStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "INVALID",
];
/** Statuses the worker acts on. */
export const WORKABLE: AtlasIntentStatus[] = [
  "ACTIVE",
  "WAITING_FOR_ENTRY",
  "EXECUTING",
  "POSITION_OPEN",
  "MONITORING",
  "EXIT_TRIGGERED",
];
const q = (n: number) => Array(n).fill("?").join(",");

export class IntentRepository {
  readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    this.db.exec(`
CREATE TABLE IF NOT EXISTS trade_intents (
  id TEXT PRIMARY KEY, user_address TEXT NOT NULL, original_prompt TEXT NOT NULL,
  normalized_intent_json TEXT NOT NULL, strategy_hash TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, valid_after INTEGER, valid_until INTEGER,
  nonce INTEGER NOT NULL, signature TEXT, signature_type TEXT, max_spend_usdt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0, close_requested INTEGER NOT NULL DEFAULT 0,
  last_block TEXT, demo INTEGER NOT NULL DEFAULT 0, onchain_tx TEXT,
  UNIQUE(user_address, nonce)
) STRICT;
CREATE INDEX IF NOT EXISTS trade_intents_user ON trade_intents(user_address, created_at);
CREATE INDEX IF NOT EXISTS trade_intents_status ON trade_intents(status);
CREATE TABLE IF NOT EXISTS intent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL, event_type TEXT NOT NULL,
  payload TEXT NOT NULL, timestamp INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS intent_events_intent ON intent_events(intent_id, id);
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE, user_address TEXT NOT NULL, stock_id TEXT NOT NULL,
  quantity TEXT NOT NULL, entry_price_usdt TEXT NOT NULL, current_price_usdt TEXT NOT NULL,
  status TEXT NOT NULL, source TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER, exit_reason TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS trade_executions (
  id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, kind TEXT NOT NULL, side TEXT NOT NULL,
  user_address TEXT NOT NULL, stock_id TEXT NOT NULL, quantity TEXT NOT NULL, price_usdt TEXT NOT NULL,
  notional_usdt TEXT NOT NULL, slippage_bps INTEGER NOT NULL, fee_usdt TEXT NOT NULL, tx_hash TEXT,
  executed_at INTEGER NOT NULL, UNIQUE(intent_id, kind)
) STRICT;
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_address TEXT NOT NULL, intent_id TEXT NOT NULL,
  kind TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_address, id);`);
  }
  close() {
    this.db.close();
  }
  private all<T>(sql: string, ...p: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...p) as unknown as T[];
  }
  private one<T>(sql: string, ...p: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...p) as unknown as T | undefined;
  }
  /** Serializable write section; a thrown error rolls everything back. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  nextNonce(user: string): number {
    const r = this.one<{ n: number | null }>(
      "SELECT MAX(nonce) n FROM trade_intents WHERE user_address=?",
      user.toLowerCase(),
    );
    return (r?.n ?? 0) + 1;
  }
  insertIntent(i: {
    intent: AtlasTradeIntent;
    hash: string;
    status: AtlasIntentStatus;
    nonce: number;
    maxSpend: string;
    now: number;
    demo: boolean;
  }) {
    const c = i.intent.constraints;
    this.db
      .prepare(
        `INSERT INTO trade_intents(id,user_address,original_prompt,normalized_intent_json,strategy_hash,status,created_at,updated_at,valid_after,valid_until,nonce,max_spend_usdt,demo)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        i.intent.id,
        i.intent.userAddress.toLowerCase(),
        i.intent.metadata.originalPrompt,
        JSON.stringify(i.intent),
        i.hash,
        i.status,
        i.now,
        i.now,
        c.validAfter ?? null,
        c.validUntil ?? null,
        i.nonce,
        i.maxSpend,
        i.demo ? 1 : 0,
      );
  }
  get(id: string) {
    return this.one<IntentRow>("SELECT * FROM trade_intents WHERE id=?", id);
  }
  list(user: string) {
    return this.all<IntentRow>(
      "SELECT * FROM trade_intents WHERE user_address=? ORDER BY created_at DESC LIMIT 200",
      user.toLowerCase(),
    );
  }
  countActive(user: string) {
    return this.one<{ n: number }>(
      `SELECT COUNT(*) n FROM trade_intents WHERE user_address=? AND status IN (${q(WORKABLE.length)})`,
      user.toLowerCase(),
      ...WORKABLE,
    )!.n;
  }
  workable(now: number, limit = 100) {
    return this.all<IntentRow>(
      `SELECT * FROM trade_intents WHERE status IN (${q(WORKABLE.length)}) AND next_attempt_at<=? AND lease_until<=? ORDER BY updated_at LIMIT ?`,
      ...WORKABLE,
      now,
      now,
      limit,
    );
  }
  /** Compare-and-set transition. Returns false if another actor changed the row first. */
  transition(
    id: string,
    from: AtlasIntentStatus[],
    to: AtlasIntentStatus,
    now: number,
    patch: Partial<
      Pick<
        IntentRow,
        | "signature"
        | "signature_type"
        | "error_code"
        | "error_message"
        | "retry_count"
        | "next_attempt_at"
        | "last_block"
        | "onchain_tx"
        | "close_requested"
      >
    > = {},
  ): boolean {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    const sets = [
      "status=?",
      "updated_at=?",
      "version=version+1",
      "lease_until=0",
      ...keys.map((k) => `${k}=?`),
    ];
    const r = this.db
      .prepare(
        `UPDATE trade_intents SET ${sets.join(",")} WHERE id=? AND status IN (${q(from.length)})`,
      )
      .run(to, now, ...keys.map((k) => patch[k] as SQLInputValue), id, ...from);
    return Number(r.changes) === 1;
  }
  patch(
    id: string,
    now: number,
    patch: Partial<
      Pick<
        IntentRow,
        | "retry_count"
        | "next_attempt_at"
        | "last_block"
        | "close_requested"
        | "error_code"
        | "error_message"
      >
    >,
  ) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    this.db
      .prepare(
        `UPDATE trade_intents SET updated_at=?,${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
      )
      .run(now, ...keys.map((k) => patch[k] as SQLInputValue), id);
  }
  /** Lease so only one worker processes an intent at a time. Atomic: exactly one caller gets true. */
  lease(id: string, now: number, ttl = 60): boolean {
    const r = this.db
      .prepare(
        "UPDATE trade_intents SET lease_until=? WHERE id=? AND lease_until<=?",
      )
      .run(now + ttl, id, now);
    return Number(r.changes) === 1;
  }
  release(id: string) {
    this.db
      .prepare("UPDATE trade_intents SET lease_until=0 WHERE id=?")
      .run(id);
  }

  addEvent(intentId: string, type: string, payload: unknown, now: number) {
    this.db
      .prepare(
        "INSERT INTO intent_events(intent_id,event_type,payload,timestamp) VALUES(?,?,?,?)",
      )
      .run(intentId, type, JSON.stringify(payload ?? {}), now);
  }
  events(intentId: string) {
    return this.all<EventRow>(
      "SELECT * FROM intent_events WHERE intent_id=? ORDER BY id",
      intentId,
    );
  }
  notify(
    user: string,
    intentId: string,
    kind: string,
    message: string,
    now: number,
  ) {
    this.db
      .prepare(
        "INSERT INTO notifications(user_address,intent_id,kind,message,created_at) VALUES(?,?,?,?,?)",
      )
      .run(user.toLowerCase(), intentId, kind, message, now);
  }
  notifications(user: string, limit = 50) {
    return this.all<NotificationRow>(
      "SELECT * FROM notifications WHERE user_address=? ORDER BY id DESC LIMIT ?",
      user.toLowerCase(),
      limit,
    );
  }
  markNotificationsRead(user: string) {
    this.db
      .prepare("UPDATE notifications SET read=1 WHERE user_address=?")
      .run(user.toLowerCase());
  }

  position(intentId: string) {
    return this.one<PositionRow>(
      "SELECT * FROM positions WHERE intent_id=?",
      intentId,
    );
  }
  positionsFor(user: string) {
    return this.all<PositionRow>(
      "SELECT * FROM positions WHERE user_address=? ORDER BY opened_at DESC",
      user.toLowerCase(),
    );
  }
  updatePositionPrice(intentId: string, price: string) {
    this.db
      .prepare(
        "UPDATE positions SET current_price_usdt=? WHERE intent_id=? AND status='OPEN'",
      )
      .run(price, intentId);
  }
  execution(intentId: string, kind: "ENTRY" | "EXIT") {
    return this.one<ExecutionRow>(
      "SELECT * FROM trade_executions WHERE intent_id=? AND kind=?",
      intentId,
      kind,
    );
  }
  executions(intentId: string) {
    return this.all<ExecutionRow>(
      "SELECT * FROM trade_executions WHERE intent_id=? ORDER BY executed_at",
      intentId,
    );
  }
  /** Demo ledger: net quantity and cash per user, derived from executions only. */
  ledger(user: string) {
    const rows = this.all<ExecutionRow>(
      "SELECT * FROM trade_executions WHERE user_address=?",
      user.toLowerCase(),
    );
    let cash = 0n;
    const qty = new Map<string, bigint>();
    for (const e of rows) {
      const n = BigInt(e.notional_usdt),
        f = BigInt(e.fee_usdt),
        k = BigInt(e.quantity);
      if (e.side === "BUY") {
        cash -= n + f;
        qty.set(e.stock_id, (qty.get(e.stock_id) ?? 0n) + k);
      } else {
        cash += n - f;
        qty.set(e.stock_id, (qty.get(e.stock_id) ?? 0n) - k);
      }
    }
    return { cash, qty };
  }

  /** Atomically: insert the entry execution, open the position, and move EXECUTING -> POSITION_OPEN. */
  recordEntry(a: {
    exec: ExecutionRow;
    position: PositionRow;
    now: number;
  }): boolean {
    return this.tx(() => {
      if (
        !this.transition(
          a.exec.intent_id,
          ["EXECUTING"],
          "POSITION_OPEN",
          a.now,
        )
      )
        return false;
      this.db
        .prepare(
          `INSERT INTO trade_executions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          a.exec.id,
          a.exec.intent_id,
          a.exec.kind,
          a.exec.side,
          a.exec.user_address,
          a.exec.stock_id,
          a.exec.quantity,
          a.exec.price_usdt,
          a.exec.notional_usdt,
          a.exec.slippage_bps,
          a.exec.fee_usdt,
          a.exec.tx_hash,
          a.exec.executed_at,
        );
      const p = a.position;
      this.db
        .prepare(`INSERT INTO positions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          p.id,
          p.intent_id,
          p.user_address,
          p.stock_id,
          p.quantity,
          p.entry_price_usdt,
          p.current_price_usdt,
          p.status,
          p.source,
          p.opened_at,
          p.closed_at,
          p.exit_reason,
        );
      return true;
    });
  }
  /** Reference-price position (SELL strategies): no trade, no execution row. */
  armReference(p: PositionRow, now: number): boolean {
    return this.tx(() => {
      if (
        !this.transition(
          p.intent_id,
          ["ACTIVE", "WAITING_FOR_ENTRY"],
          "MONITORING",
          now,
        )
      )
        return false;
      this.db
        .prepare(`INSERT INTO positions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          p.id,
          p.intent_id,
          p.user_address,
          p.stock_id,
          p.quantity,
          p.entry_price_usdt,
          p.current_price_usdt,
          p.status,
          p.source,
          p.opened_at,
          p.closed_at,
          p.exit_reason,
        );
      return true;
    });
  }
  /** Atomically: insert the exit execution, close the position, move EXIT_TRIGGERED -> COMPLETED. */
  recordExit(a: { exec: ExecutionRow; reason: string; now: number }): boolean {
    return this.tx(() => {
      if (
        !this.transition(
          a.exec.intent_id,
          ["EXIT_TRIGGERED"],
          "COMPLETED",
          a.now,
        )
      )
        return false;
      const e = a.exec;
      this.db
        .prepare(
          `INSERT INTO trade_executions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          e.id,
          e.intent_id,
          e.kind,
          e.side,
          e.user_address,
          e.stock_id,
          e.quantity,
          e.price_usdt,
          e.notional_usdt,
          e.slippage_bps,
          e.fee_usdt,
          e.tx_hash,
          e.executed_at,
        );
      this.db
        .prepare(
          "UPDATE positions SET status='CLOSED',closed_at=?,current_price_usdt=?,exit_reason=? WHERE intent_id=?",
        )
        .run(a.now, e.price_usdt, a.reason, e.intent_id);
      return true;
    });
  }
}
