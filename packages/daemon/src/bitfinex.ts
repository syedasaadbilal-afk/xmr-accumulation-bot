import { createHmac } from "node:crypto";
import type { DailyCandle } from "./larsson.js";

export type RunMode = "DRY_RUN" | "LIVE";

export interface WalletBalance {
  currency: string;
  balance: number;
  availableBalance: number;
}

export interface Ticker {
  bid: number;
  ask: number;
  last: number;
}

export interface OrderFill {
  active: boolean;
  filled: number;
  original: number;
  avgPrice: number;
}

export interface SubmitResult {
  submitted: boolean;
  dryRun: boolean;
  orderId?: string;
}

/** The exchange surface the bot needs. Tests provide a fake implementation. */
export interface Exchange {
  readonly runMode: RunMode;
  getDailyCandles(symbol: string, limit: number): Promise<DailyCandle[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getMinOrderSize(symbol: string): Promise<number>;
  getWallets(): Promise<WalletBalance[]>;
  /** Diagnostics: every wallet row on the account, any wallet type (exchange, margin, funding). */
  getAllWallets?(): Promise<Array<WalletBalance & { type: string }>>;
  submitOrder(order: { symbol: string; amount: number; price: string }): Promise<SubmitResult>;
  getOrderFill(symbol: string, orderId: string): Promise<OrderFill>;
  cancelOrder(orderId: string): Promise<void>;
}

const CANDLE_CACHE = new Map<string, { at: number; rows: DailyCandle[] }>();
const CANDLE_CACHE_MS = 120_000;

export const BASE_URL = "https://api.bitfinex.com";
export const PUBLIC_URL = "https://api-pub.bitfinex.com";

/** Strictly increasing nonce shared by every authenticated call in the process. */
class MonotonicNonce {
  private last = 0;
  next(): string {
    const now = Date.now() * 1000;
    this.last = now > this.last ? now : this.last + 1;
    return String(this.last);
  }
}
const NONCE = new MonotonicNonce();

/** All authenticated calls run one at a time so nonces always arrive in order. */
let authChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = authChain.then(fn, fn);
  authChain = run.catch(() => undefined);
  return run;
}
async function withNonceRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await serialized(fn);
  } catch (err) {
    if (err instanceof Error && /10114|nonce: small/i.test(err.message)) {
      await new Promise((r) => setTimeout(r, 50));
      return serialized(fn);
    }
    throw err;
  }
}

/** Token bucket, ~30 requests a minute, shared by all calls. */
class RateLimiter {
  private tokens = 30;
  private last = Date.now();
  private take(): number {
    const now = Date.now();
    this.tokens = Math.min(30, this.tokens + ((now - this.last) * 30) / 60_000);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) * 60_000) / 30);
  }
  async wait(): Promise<void> {
    for (;;) {
      const ms = this.take();
      if (ms === 0) return;
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

type FetchLike = typeof fetch;

/** Marketable limit price string, in the format Bitfinex accepts. */
export function priceString(px: number): string {
  // Bitfinex allows 5 significant digits: 2 decimals from 10 up, 4 decimals for 1-10 (stablecoin pairs), 8 below.
  return px >= 10 ? px.toFixed(2) : px >= 1 ? px.toFixed(4) : px.toFixed(8);
}

export class BitfinexExchange implements Exchange {
  private readonly limiter = new RateLimiter();
  private pairMin: { at: number; bySymbol: Map<string, number> } | null = null;

  constructor(
    private readonly cfg: { apiKey: string; apiSecret: string; runMode: RunMode },
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  get runMode(): RunMode {
    return this.cfg.runMode;
  }

  // ---- public ----

  async getDailyCandles(symbol: string, limit: number): Promise<DailyCandle[]> {
    // Long history is a big download; reuse it for a couple of minutes (signals only use confirmed daily closes).
    const key = `${symbol}:${limit}`;
    const hit = CANDLE_CACHE.get(key);
    if (hit && Date.now() - hit.at < CANDLE_CACHE_MS) return hit.rows;
    const rows = await this.fetchDailyCandles(symbol, limit);
    CANDLE_CACHE.set(key, { at: Date.now(), rows });
    return rows;
  }

  private async fetchDailyCandles(symbol: string, limit: number): Promise<DailyCandle[]> {
    await this.limiter.wait();
    const res = await this.fetchImpl(`${PUBLIC_URL}/v2/candles/trade:1D:${symbol}/hist?limit=${limit}`);
    if (!res.ok) throw new Error(`candles ${symbol} failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as number[][];
    // Default order is newest first, so `limit` returns the LATEST bars (sort=1 without a start returns the OLDEST).
    // [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
    return rows
      .map((r) => ({ time: Math.floor(r[0]! / 1000), open: r[1]!, close: r[2]!, high: r[3]!, low: r[4]! }))
      .sort((a, b) => a.time - b.time);
  }

  async getTicker(symbol: string): Promise<Ticker> {
    await this.limiter.wait();
    const res = await this.fetchImpl(`${PUBLIC_URL}/v2/ticker/${symbol}`);
    if (!res.ok) throw new Error(`ticker ${symbol} failed: ${res.status} ${await res.text()}`);
    const r = (await res.json()) as number[];
    // [BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_RELATIVE, LAST_PRICE, ...]
    return { bid: r[0]!, ask: r[2]!, last: r[6]! };
  }

  async getMinOrderSize(symbol: string): Promise<number> {
    const now = Date.now();
    if (!this.pairMin || now - this.pairMin.at > 3_600_000) {
      await this.limiter.wait();
      const res = await this.fetchImpl(`${PUBLIC_URL}/v2/conf/pub:info:pair`);
      if (!res.ok) throw new Error(`pair info failed: ${res.status} ${await res.text()}`);
      const raw = (await res.json()) as [[string, (string | number | null)[]][]];
      const bySymbol = new Map<string, number>();
      for (const [pair, info] of raw[0] ?? []) {
        const min = info[3];
        if (min !== null && min !== undefined) bySymbol.set(pair, Number(min));
      }
      this.pairMin = { at: now, bySymbol };
    }
    return this.pairMin.bySymbol.get(symbol.startsWith("t") ? symbol.slice(1) : symbol) ?? 0;
  }

  // ---- authenticated ----

  private authPost(path: string, bodyObj: Record<string, unknown> = {}): Promise<unknown> {
    return withNonceRetry(async () => {
      await this.limiter.wait();
      const body = JSON.stringify(bodyObj);
      const nonce = NONCE.next();
      const signature = createHmac("sha384", this.cfg.apiSecret).update(`/api/${path}${nonce}${body}`).digest("hex");
      const res = await this.fetchImpl(`${BASE_URL}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "bfx-nonce": nonce,
          "bfx-apikey": this.cfg.apiKey,
          "bfx-signature": signature,
        },
        body,
      });
      if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
      return res.json();
    });
  }

  async getWallets(): Promise<WalletBalance[]> {
    const rows = (await this.authPost("v2/auth/r/wallets")) as Array<[string, string, number, number, number | null]>;
    return rows
      .filter((r) => r[0] === "exchange")
      .map((r) => ({ currency: r[1], balance: r[2], availableBalance: r[4] ?? r[2] }));
  }

  async getAllWallets(): Promise<Array<WalletBalance & { type: string }>> {
    const rows = (await this.authPost("v2/auth/r/wallets")) as Array<[string, string, number, number, number | null]>;
    return rows.map((r) => ({ type: r[0], currency: r[1], balance: r[2], availableBalance: r[4] ?? r[2] }));
  }

  async submitOrder(order: { symbol: string; amount: number; price: string }): Promise<SubmitResult> {
    // Defence in depth: the client itself refuses to trade in DRY_RUN.
    if (this.cfg.runMode === "DRY_RUN") {
      console.log("[xmr][DRY_RUN] would submit order:", order);
      return { submitted: false, dryRun: true };
    }
    const raw = (await this.authPost("v2/auth/w/order/submit", {
      type: "EXCHANGE LIMIT",
      symbol: order.symbol,
      amount: order.amount.toFixed(8),
      price: order.price,
    })) as unknown[];
    // Notification: [MTS, TYPE, MSG_ID, null, [[ID, ...]], CODE, STATUS, TEXT]
    if (Array.isArray(raw) && raw[6] === "ERROR") throw new Error(`order rejected: ${String(raw[7])}`);
    const row = Array.isArray(raw) && Array.isArray(raw[4]) ? (raw[4] as unknown[])[0] : undefined;
    const id = Array.isArray(row) ? row[0] : undefined;
    return id !== undefined && id !== null ? { submitted: true, dryRun: false, orderId: String(id) } : { submitted: true, dryRun: false };
  }

  async getOrderFill(symbol: string, orderId: string): Promise<OrderFill> {
    const idNum = Number(orderId);
    const find = (rows: unknown): unknown[] | undefined =>
      Array.isArray(rows) ? (rows as unknown[][]).find((r) => Array.isArray(r) && Number(r[0]) === idNum) : undefined;
    const read = (row: unknown[], active: boolean): OrderFill => {
      const rem = Math.abs(Number(row[6]));
      const orig = Math.abs(Number(row[7]));
      return { active, filled: Math.max(0, orig - rem), original: orig, avgPrice: Number(row[17]) || 0 };
    };
    const activeRow = find(await this.authPost("v2/auth/r/orders"));
    if (activeRow) return read(activeRow, true);
    const histRow = find(await this.authPost(`v2/auth/r/orders/${symbol}/hist`, { id: [idNum] }));
    if (histRow) return read(histRow, false);
    // Not visible yet (propagation lag): report as still active with nothing filled.
    return { active: true, filled: 0, original: 0, avgPrice: 0 };
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (this.cfg.runMode === "DRY_RUN") return;
    await this.authPost("v2/auth/w/order/cancel", { id: Number(orderId) });
  }
}
