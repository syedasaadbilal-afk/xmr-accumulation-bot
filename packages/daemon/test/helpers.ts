import type { Exchange, OrderFill, SubmitResult, Ticker, WalletBalance } from "../src/bitfinex.js";
import type { DailyCandle } from "../src/larsson.js";

export const DAY = 86_400;
export const T0 = 1_700_000_000 - (1_700_000_000 % DAY);

/** Daily XMR/BTC candles (BTC per XMR) from a close path, high/low +-1%. */
export function xmrBtcPath(closes: number[]): DailyCandle[] {
  return closes.map((c, i) => ({ time: T0 + i * DAY, open: i === 0 ? c : closes[i - 1]!, high: c * 1.01, low: c * 0.99, close: c }));
}
/** "now" = 1h into the day after bar n-1, so bars 0..n-1 are confirmed. */
export const nowAfter = (n: number) => (T0 + n * DAY + 3600) * 1000;

// BTC trending UP against XMR = XMR/BTC falling. 40 flat bars, then 30 bars of XMR/BTC falling 2% a day.
export const FLAT = Array.from({ length: 40 }, () => 0.04);
export const BTC_RALLY = Array.from({ length: 30 }, (_, i) => 0.04 * Math.pow(0.98, i + 1));
// then BTC collapsing against XMR = XMR/BTC rising fast
export const BTC_CRASH = Array.from({ length: 30 }, (_, i) => BTC_RALLY[BTC_RALLY.length - 1]! * Math.pow(1.04, i + 1));

export const UP_CLOSES = [...FLAT, ...BTC_RALLY]; // strategy should want BTC
export const DOWN_CLOSES = [...FLAT, ...BTC_RALLY, ...BTC_CRASH]; // strategy should want XMR again

export interface FakeOpts {
  closes: number[];
  xmr?: number;
  btc?: number;
  ust?: number;
  usd?: number;
  prices?: Record<string, number>;
  /** Minimum order size per symbol (default tiny). */
  mins?: Record<string, number>;
  xmrUst?: number;
  btcUst?: number;
  mode?: "DRY_RUN" | "LIVE";
}

/** Exchange double: orders fill instantly at the current ticker price. */
export class FakeExchange implements Exchange {
  runMode: "DRY_RUN" | "LIVE";
  wallets: Record<string, number>;
  orders: Array<{ symbol: string; amount: number; price: string }> = [];
  private nextId = 1;
  private filled = new Map<string, OrderFill>();
  xmrUst: number;
  btcUst: number;
  closes: number[];
  prices: Record<string, number>;
  mins: Record<string, number>;

  constructor(o: FakeOpts) {
    this.runMode = o.mode ?? "LIVE";
    this.wallets = { XMR: o.xmr ?? 0, BTC: o.btc ?? 0, UST: o.ust ?? 0, ...(o.usd !== undefined ? { USD: o.usd } : {}) };
    this.prices = o.prices ?? {};
    this.mins = o.mins ?? {};
    this.xmrUst = o.xmrUst ?? 4000;
    this.btcUst = o.btcUst ?? 100000;
    this.closes = o.closes;
  }

  async getDailyCandles(): Promise<DailyCandle[]> {
    return xmrBtcPath(this.closes);
  }
  async getTicker(symbol: string): Promise<Ticker> {
    const p = this.priceOf(symbol);
    return { bid: p * 0.9999, ask: p * 1.0001, last: p };
  }
  async getMinOrderSize(symbol: string): Promise<number> {
    return this.mins[symbol] ?? (symbol === "tUSTUSD" ? 2 : 0.00001);
  }
  private priceOf(symbol: string): number {
    if (symbol === "tXMRUST") return this.xmrUst;
    if (symbol === "tBTCUST") return this.btcUst;
    if (symbol === "tUSTUSD") return 1.0006;
    if (symbol === "tXMRBTC") return this.xmrUst / this.btcUst;
    const m = /^t([A-Z]{2,10}):?UST$/.exec(symbol);
    const px = m ? this.prices[m[1]!] : undefined;
    if (px === undefined) throw new Error(`unknown symbol ${symbol}`);
    return px;
  }
  async getWallets(): Promise<WalletBalance[]> {
    return Object.entries(this.wallets).map(([currency, balance]) => ({ currency, balance, availableBalance: balance }));
  }
  async submitOrder(order: { symbol: string; amount: number; price: string }): Promise<SubmitResult> {
    if (this.runMode === "DRY_RUN") return { submitted: false, dryRun: true };
    this.orders.push(order);
    const px = this.priceOf(order.symbol);
    const base = order.symbol === "tXMRUST" ? "XMR" : order.symbol === "tBTCUST" ? "BTC" : order.symbol === "tUSTUSD" ? "UST" : /^t([A-Z]{2,10}):?UST$/.exec(order.symbol)![1]!;
    const quote = order.symbol === "tUSTUSD" ? "USD" : "UST";
    this.wallets[base] = (this.wallets[base] ?? 0) + order.amount;
    this.wallets[quote] = (this.wallets[quote] ?? 0) - order.amount * px;
    const id = String(this.nextId++);
    this.filled.set(id, { active: false, filled: Math.abs(order.amount), original: Math.abs(order.amount), avgPrice: px });
    return { submitted: true, dryRun: false, orderId: id };
  }
  async getOrderFill(_symbol: string, id: string): Promise<OrderFill> {
    return this.filled.get(id) ?? { active: false, filled: 0, original: 0, avgPrice: 0 };
  }
  async cancelOrder(): Promise<void> {}
}
