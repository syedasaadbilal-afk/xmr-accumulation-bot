import { priceString, type Exchange } from "./bitfinex.js";

export const XMR_UST = "tXMRUST";
export const BTC_UST = "tBTCUST";
export const XMR_BTC = "tXMRBTC";

/** How far through the book a "marketable" limit order reaches. */
const LIMIT_BUFFER = 0.005;
/** Safety margin when estimating USDT proceeds of a sell. Bitfinex spot trading fees are currently zero (maker and taker). */
const FEE_ALLOWANCE = 0.0005;
/** Unspent USDT below this share of a chunk's proceeds is rounding dust, not a failed buy leg. */
const DUST_FRACTION = 0.015;

export interface FillRecord {
  symbol: string;
  side: "buy" | "sell";
  /** Base-currency amount filled. */
  base: number;
  /** Average fill price in USDT. */
  price: number;
}

export interface RotateResult {
  /** Units of the sold asset actually sold (XMR for xmr_to_btc, BTC for btc_to_xmr). */
  sold: number;
  /** Units of the bought asset actually bought. */
  bought: number;
  /** USDT proceeds not yet spent on the buy leg (to be swept next tick). */
  strandedUst: number;
  interrupted: string | null;
  fills: FillRecord[];
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const floor8 = (n: number) => Math.floor(n * 1e8 + 1e-6) / 1e8;

/** Places ONE limit order and waits for it; cancels the remainder on timeout. Never throws. */
export async function placeLimitAndWait(
  ex: Exchange,
  symbol: string,
  side: "buy" | "sell",
  base: number,
  limitPx: number,
  fillTimeoutMs: number,
  pollMs: number,
  log: (m: string) => void
): Promise<{ filled: number; avgPrice: number; error?: string }> {
  let id: string | undefined;
  try {
    const r = await ex.submitOrder({ symbol, amount: side === "buy" ? base : -base, price: priceString(limitPx) });
    if (r.dryRun) return { filled: base, avgPrice: limitPx };
    id = r.orderId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${symbol} ${side} order failed: ${msg}`);
    return { filled: 0, avgPrice: 0, error: msg };
  }
  if (!id) {
    log(`${symbol} order submitted but no order id returned - stopping for safety.`);
    return { filled: 0, avgPrice: 0, error: "no order id returned" };
  }
  const deadline = Date.now() + fillTimeoutMs;
  let state = { active: true, filled: 0, original: 0, avgPrice: 0 };
  const px = () => (state.avgPrice > 0 ? state.avgPrice : limitPx);
  for (;;) {
    await sleep(pollMs);
    try {
      state = await ex.getOrderFill(symbol, id);
    } catch (err) {
      log(`order status read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!state.active) return { filled: state.filled, avgPrice: px() };
    if (Date.now() >= deadline) break;
  }
  try {
    await ex.cancelOrder(id);
    await sleep(pollMs);
    state = await ex.getOrderFill(symbol, id);
  } catch (err) {
    log(`cancel/final-fill read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  log(`${symbol} order not fully filled in time: ${state.filled.toFixed(8)} filled, remainder cancelled.`);
  return { filled: state.filled, avgPrice: px() };
}

export interface RotateParams {
  ex: Exchange;
  direction: "xmr_to_btc" | "btc_to_xmr";
  /** Amount of the asset being SOLD (XMR for xmr_to_btc, BTC for btc_to_xmr). */
  amount: number;
  /** USD size of each limit order. */
  chunkUsd: number;
  fillTimeoutMs?: number;
  pollMs?: number;
  onFill?: (f: FillRecord) => void;
  log?: (m: string) => void;
  /** Checked before every new order; true = stop (run mode changed to PAUSED / DRY_RUN). */
  shouldStop?: () => boolean;
}

/**
 * Rotates one asset into the other through the USDT pairs, in USD-sized chunks:
 * sell a chunk for USDT, then spend exactly those proceeds on the other asset,
 * one limit order open at a time. Stops on the first incomplete step and reports
 * any unspent USDT so the next tick can sweep it. Never throws.
 */
export async function rotate(p: RotateParams): Promise<RotateResult> {
  const { ex, direction } = p;
  const log = p.log ?? ((m: string) => console.log(`[xmr] ${m}`));
  const fillTimeoutMs = p.fillTimeoutMs ?? 5 * 60_000;
  const pollMs = p.pollMs ?? 4_000;
  const sellSym = direction === "xmr_to_btc" ? XMR_UST : BTC_UST;
  const buySym = direction === "xmr_to_btc" ? BTC_UST : XMR_UST;
  const result: RotateResult = { sold: 0, bought: 0, strandedUst: 0, interrupted: null, fills: [] };
  const record = (f: FillRecord) => {
    result.fills.push(f);
    try {
      p.onFill?.(f);
    } catch (err) {
      log(`fill logging failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    const [minSell, minBuy] = await Promise.all([ex.getMinOrderSize(sellSym), ex.getMinOrderSize(buySym)]);
    let remaining = p.amount;
    let stranded = 0;
    let lastDust = 2;
    while (remaining > 0) {
      if (p.shouldStop?.()) {
        result.interrupted = "stopped: bot was paused";
        break;
      }
      const sellT = await ex.getTicker(sellSym);
      if (!(sellT.bid > 0)) {
        result.interrupted = `no bid on ${sellSym}`;
        break;
      }
      const chunkBase = floor8(Math.min(remaining, p.chunkUsd / sellT.bid));
      if (chunkBase <= 0 || chunkBase < minSell || chunkBase * sellT.bid < 1) break; // dust left
      const sellPx = sellT.bid * (1 - LIMIT_BUFFER);
      const s = await placeLimitAndWait(ex, sellSym, "sell", chunkBase, sellPx, fillTimeoutMs, pollMs, log);
      if (s.filled > 0) {
        record({ symbol: sellSym, side: "sell", base: s.filled, price: s.avgPrice });
        result.sold += s.filled;
        remaining -= s.filled;
        stranded += s.filled * s.avgPrice * (1 - FEE_ALLOWANCE);
      }
      if (s.filled <= 0) {
        result.interrupted = s.error ? `sell leg failed: ${s.error}` : "sell order did not fill";
        break;
      }
      // Spend the proceeds on the other asset (up to 3 orders for any unfilled remainder).
      // Dust: the marketable-limit buffer and fee allowance always leave ~0.5-1% of the
      // chunk unspent; that is not a failed leg and rolls into the next chunk.
      const dust = Math.max(2, stranded * DUST_FRACTION);
      lastDust = dust;
      for (let attempt = 0; attempt < 3 && stranded > dust; attempt++) {
        const buyT = await ex.getTicker(buySym);
        if (!(buyT.ask > 0)) break;
        const buyPx = buyT.ask * (1 + LIMIT_BUFFER);
        const buyBase = floor8((stranded * 0.9995) / buyPx);
        if (buyBase <= 0 || buyBase < minBuy) break;
        const b = await placeLimitAndWait(ex, buySym, "buy", buyBase, buyPx, fillTimeoutMs, pollMs, log);
        if (b.filled > 0) {
          record({ symbol: buySym, side: "buy", base: b.filled, price: b.avgPrice });
          result.bought += b.filled;
          stranded -= b.filled * b.avgPrice;
        }
        if (b.filled >= buyBase * 0.999) break;
        if (b.error) break;
      }
      if (stranded > dust) {
        result.interrupted = "buy leg incomplete; USDT left for the next sweep";
        break;
      }
      if (s.filled < chunkBase * 0.999) {
        result.interrupted = "sell order only partly filled";
        break;
      }
    }
    result.strandedUst = stranded > lastDust ? stranded : 0;
  } catch (err) {
    result.interrupted = err instanceof Error ? err.message : String(err);
    log(`rotation interrupted: ${result.interrupted}`);
  }
  return result;
}

/** Spends already-held USDT on one asset (used to finish a rotation that stopped half-way). Never throws. */
export async function sweepUst(p: {
  ex: Exchange;
  into: "btc" | "xmr";
  ust: number;
  chunkUsd: number;
  fillTimeoutMs?: number;
  pollMs?: number;
  onFill?: (f: FillRecord) => void;
  log?: (m: string) => void;
  shouldStop?: () => boolean;
}): Promise<{ bought: number; spentUst: number; strandedUst: number; interrupted: string | null }> {
  const log = p.log ?? ((m: string) => console.log(`[xmr] ${m}`));
  const sym = p.into === "btc" ? BTC_UST : XMR_UST;
  let left = p.ust;
  let bought = 0;
  let interrupted: string | null = null;
  try {
    const min = await p.ex.getMinOrderSize(sym);
    for (let i = 0; i < 20 && left > Math.max(2, p.ust * DUST_FRACTION); i++) {
      if (p.shouldStop?.()) {
        interrupted = "stopped: bot was paused";
        break;
      }
      const t = await p.ex.getTicker(sym);
      if (!(t.ask > 0)) break;
      const px = t.ask * (1 + LIMIT_BUFFER);
      const base = floor8((Math.min(left, p.chunkUsd) * 0.9995) / px);
      if (base <= 0 || base < min) break;
      const r = await placeLimitAndWait(p.ex, sym, "buy", base, px, p.fillTimeoutMs ?? 5 * 60_000, p.pollMs ?? 4_000, log);
      if (r.filled > 0) {
        bought += r.filled;
        left -= r.filled * r.avgPrice;
        p.onFill?.({ symbol: sym, side: "buy", base: r.filled, price: r.avgPrice });
      }
      if (r.filled < base * 0.999) {
        interrupted = r.error ? `buy failed: ${r.error}` : "buy order only partly filled";
        break;
      }
    }
  } catch (err) {
    interrupted = err instanceof Error ? err.message : String(err);
  }
  const stranded = left > Math.max(2, p.ust * DUST_FRACTION) ? left : 0;
  return { bought, spentUst: p.ust - left, strandedUst: stranded, interrupted };
}

/**
 * Sells part of one asset for USDT (to build the USDT reserve), in USD-sized limit orders,
 * one at a time. Stops once `usd` is raised, `maxBase` is used up, or an order fails. Never throws.
 */
export async function raiseUst(p: {
  ex: Exchange;
  from: "btc" | "xmr";
  /** USDT to raise. */
  usd: number;
  /** Most of the asset that may be sold. */
  maxBase: number;
  chunkUsd: number;
  fillTimeoutMs?: number;
  pollMs?: number;
  onFill?: (f: FillRecord) => void;
  log?: (m: string) => void;
  shouldStop?: () => boolean;
}): Promise<{ sold: number; proceeds: number; interrupted: string | null }> {
  const log = p.log ?? ((m: string) => console.log(`[xmr] ${m}`));
  const sym = p.from === "btc" ? BTC_UST : XMR_UST;
  let left = p.usd;
  let baseLeft = p.maxBase;
  let sold = 0;
  let proceeds = 0;
  let interrupted: string | null = null;
  try {
    const min = await p.ex.getMinOrderSize(sym);
    for (let i = 0; i < 200 && left >= 2 && baseLeft > 0; i++) {
      if (p.shouldStop?.()) {
        interrupted = "stopped: bot was paused";
        break;
      }
      const t = await p.ex.getTicker(sym);
      if (!(t.bid > 0)) {
        interrupted = `no bid on ${sym}`;
        break;
      }
      const base = floor8(Math.min(baseLeft, Math.min(left, p.chunkUsd) / t.bid));
      if (base <= 0 || base < min || base * t.bid < 1) break;
      const r = await placeLimitAndWait(p.ex, sym, "sell", base, t.bid * (1 - LIMIT_BUFFER), p.fillTimeoutMs ?? 5 * 60_000, p.pollMs ?? 4_000, log);
      if (r.filled > 0) {
        sold += r.filled;
        baseLeft -= r.filled;
        proceeds += r.filled * r.avgPrice;
        left -= r.filled * r.avgPrice;
        p.onFill?.({ symbol: sym, side: "sell", base: r.filled, price: r.avgPrice });
      }
      if (r.filled < base * 0.999) {
        interrupted = r.error ? `sell failed: ${r.error}` : r.filled > 0 ? "sell order only partly filled" : "sell order did not fill";
        break;
      }
    }
  } catch (err) {
    interrupted = err instanceof Error ? err.message : String(err);
  }
  return { sold, proceeds, interrupted };
}

/** USDT trading symbol for another coin on Bitfinex ("ETH" -> tETHUST, longer tickers use a colon). */
export function otherSymbol(currency: string): string {
  return currency.length <= 3 ? `t${currency}UST` : `t${currency}:UST`;
}

export const UST_USD = "tUSTUSD";

/**
 * Turns an "other" balance into USDT so the idle-USDT sweep can move it into the strategy:
 * USD is swapped for USDT on tUSTUSD, any other coin is sold on its USDT pair.
 * Order-size chunks, one order at a time. Never throws.
 */
export async function convertToUst(p: {
  ex: Exchange;
  currency: string;
  amount: number;
  chunkUsd: number;
  fillTimeoutMs?: number;
  pollMs?: number;
  onFill?: (f: FillRecord) => void;
  log?: (m: string) => void;
  shouldStop?: () => boolean;
}): Promise<{ spent: number; gotUst: number; interrupted: string | null }> {
  const log = p.log ?? ((m: string) => console.log(`[xmr] ${m}`));
  const timeout = p.fillTimeoutMs ?? 5 * 60_000;
  const poll = p.pollMs ?? 4_000;
  let spent = 0;
  let gotUst = 0;
  let interrupted: string | null = null;
  try {
    if (p.currency === "USD") {
      const min = await p.ex.getMinOrderSize(UST_USD);
      let left = p.amount;
      for (let i = 0; i < 50 && left > 0; i++) {
        if (p.shouldStop?.()) {
          interrupted = "stopped: bot was paused";
          break;
        }
        const t = await p.ex.getTicker(UST_USD);
        if (!(t.ask > 0)) {
          interrupted = `no ask on ${UST_USD}`;
          break;
        }
        const px = t.ask * (1 + LIMIT_BUFFER);
        const base = floor8((Math.min(left, p.chunkUsd) * 0.9995) / px);
        if (base <= 0 || base < min) {
          if (spent <= 0) interrupted = `USD balance is below the minimum order (${min} USDT)`;
          break;
        }
        const r = await placeLimitAndWait(p.ex, UST_USD, "buy", base, px, timeout, poll, log);
        if (r.filled > 0) {
          spent += r.filled * r.avgPrice;
          gotUst += r.filled;
          left -= r.filled * r.avgPrice;
          p.onFill?.({ symbol: UST_USD, side: "buy", base: r.filled, price: r.avgPrice });
        }
        if (r.filled < base * 0.999) {
          interrupted = r.error ? `buy failed: ${r.error}` : r.filled > 0 ? "order only partly filled" : "order did not fill";
          break;
        }
      }
    } else {
      const sym = otherSymbol(p.currency);
      const min = await p.ex.getMinOrderSize(sym);
      let left = p.amount;
      for (let i = 0; i < 50 && left > 0; i++) {
        if (p.shouldStop?.()) {
          interrupted = "stopped: bot was paused";
          break;
        }
        const t = await p.ex.getTicker(sym);
        if (!(t.bid > 0)) {
          interrupted = `no bid on ${sym}`;
          break;
        }
        const base = floor8(Math.min(left, p.chunkUsd / t.bid));
        if (base <= 0 || base < min || base * t.bid < 1) {
          if (spent <= 0) interrupted = `${p.currency} balance is below the minimum order`;
          break;
        }
        const r = await placeLimitAndWait(p.ex, sym, "sell", base, t.bid * (1 - LIMIT_BUFFER), timeout, poll, log);
        if (r.filled > 0) {
          spent += r.filled;
          gotUst += r.filled * r.avgPrice;
          left -= r.filled;
          p.onFill?.({ symbol: sym, side: "sell", base: r.filled, price: r.avgPrice });
        }
        if (r.filled < base * 0.999) {
          interrupted = r.error ? `sell failed: ${r.error}` : r.filled > 0 ? "order only partly filled" : "order did not fill";
          break;
        }
      }
    }
  } catch (err) {
    interrupted = err instanceof Error ? err.message : String(err);
  }
  return { spent, gotUst, interrupted };
}
