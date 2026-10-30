import type { DatabaseSyncLike } from "./db/types.js";
import { DEFAULT_CONFIG, DEFAULT_STATE, type BotConfig, type BotState } from "./config.js";

export interface EventRow {
  id: number;
  ts: number;
  kind: string;
  summary: string;
  detail: string | null;
}

export interface DepositRow {
  id: number;
  ts: number;
  asset: string;
  amount: number;
  valueXmr: number;
  dist: number | null;
  action: string;
}

export interface SnapshotRow {
  ts: number;
  xmr: number;
  btc: number;
  price: number;
  equityXmr: number;
}

export interface FillRow {
  id: number;
  ts: number;
  rotationId: string;
  symbol: string;
  side: "buy" | "sell";
  base: number;
  price: number;
}

export class Store {
  constructor(private readonly db: DatabaseSyncLike) {}

  getConfig(): BotConfig {
    const r = this.db.prepare("SELECT json FROM bot_config WHERE id = 1").get() as { json: string } | undefined;
    if (!r) return structuredClone(DEFAULT_CONFIG);
    const saved = JSON.parse(r.json) as Partial<BotConfig>;
    // Fill anything added in later versions from the defaults.
    return {
      ...DEFAULT_CONFIG,
      ...saved,
      strategyCap: { ...DEFAULT_CONFIG.strategyCap, ...(saved.strategyCap ?? {}) },
      newMoneyCap: { ...DEFAULT_CONFIG.newMoneyCap, ...(saved.newMoneyCap ?? {}) },
    };
  }

  setConfig(c: BotConfig): void {
    this.db
      .prepare(
        `INSERT INTO bot_config (id, json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(c), Date.now());
  }

  getState(): BotState {
    const r = this.db.prepare("SELECT json FROM bot_state WHERE id = 1").get() as { json: string } | undefined;
    return r ? { ...DEFAULT_STATE, ...(JSON.parse(r.json) as Partial<BotState>) } : { ...DEFAULT_STATE };
  }

  setState(s: BotState): void {
    this.db
      .prepare(
        `INSERT INTO bot_state (id, json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(s), Date.now());
  }

  addEvent(kind: string, summary: string, detail?: unknown, ts = Date.now()): void {
    this.db
      .prepare("INSERT INTO events (ts, kind, summary, detail) VALUES (?, ?, ?, ?)")
      .run(ts, kind, summary, detail === undefined ? null : JSON.stringify(detail));
  }

  events(limit = 100): EventRow[] {
    return this.db.prepare("SELECT id, ts, kind, summary, detail FROM events ORDER BY id DESC LIMIT ?").all(limit) as EventRow[];
  }

  addFill(f: { ts: number; rotationId: string; symbol: string; side: "buy" | "sell"; base: number; price: number }): void {
    this.db
      .prepare("INSERT INTO fills (ts, rotation_id, symbol, side, base, price) VALUES (?, ?, ?, ?, ?, ?)")
      .run(f.ts, f.rotationId, f.symbol, f.side, f.base, f.price);
  }

  /** Every fill, oldest first (the timeline groups them into rotations and trades). */
  allFills(): FillRow[] {
    return this.fills(100000).reverse();
  }

  fills(limit = 100): FillRow[] {
    return (
      this.db.prepare("SELECT id, ts, rotation_id, symbol, side, base, price FROM fills ORDER BY id DESC LIMIT ?").all(limit) as Array<{
        id: number;
        ts: number;
        rotation_id: string;
        symbol: string;
        side: "buy" | "sell";
        base: number;
        price: number;
      }>
    ).map((r) => ({ id: r.id, ts: r.ts, rotationId: r.rotation_id, symbol: r.symbol, side: r.side, base: r.base, price: r.price }));
  }

  addDeposit(d: { ts: number; asset: string; amount: number; valueXmr: number; dist: number | null; action: string }): void {
    this.db
      .prepare("INSERT INTO deposits (ts, asset, amount, value_xmr, dist, action) VALUES (?, ?, ?, ?, ?, ?)")
      .run(d.ts, d.asset, d.amount, d.valueXmr, d.dist, d.action);
  }

  deposits(limit = 50): DepositRow[] {
    return (
      this.db.prepare("SELECT id, ts, asset, amount, value_xmr, dist, action FROM deposits ORDER BY id DESC LIMIT ?").all(limit) as Array<{
        id: number;
        ts: number;
        asset: string;
        amount: number;
        value_xmr: number;
        dist: number | null;
        action: string;
      }>
    ).map((r) => ({ id: r.id, ts: r.ts, asset: r.asset, amount: r.amount, valueXmr: r.value_xmr, dist: r.dist, action: r.action }));
  }

  /** Stores at most one snapshot per 10 minutes. */
  addSnapshot(s: SnapshotRow): void {
    const last = this.db.prepare("SELECT MAX(ts) AS ts FROM snapshots").get() as { ts: number | null } | undefined;
    if (last?.ts && s.ts - last.ts < 600_000) return;
    this.db
      .prepare("INSERT OR REPLACE INTO snapshots (ts, xmr, btc, price, equity_xmr) VALUES (?, ?, ?, ?, ?)")
      .run(s.ts, s.xmr, s.btc, s.price, s.equityXmr);
  }

  snapshots(limit = 500): SnapshotRow[] {
    return (
      this.db.prepare("SELECT ts, xmr, btc, price, equity_xmr FROM snapshots ORDER BY ts DESC LIMIT ?").all(limit) as Array<{
        ts: number;
        xmr: number;
        btc: number;
        price: number;
        equity_xmr: number;
      }>
    )
      .map((r) => ({ ts: r.ts, xmr: r.xmr, btc: r.btc, price: r.price, equityXmr: r.equity_xmr }))
      .reverse();
  }
}
