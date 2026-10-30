import type { MirrorTrade } from "./larsson.js";
import type { FillRow } from "./store.js";

const XMR_SYM = "tXMRUST";
const BTC_SYM = "tBTCUST";

export interface Execution {
  rotationId: string;
  ts: number;
  kind: "to_btc" | "to_xmr" | "sweep_btc" | "sweep_xmr";
  /** Asset amounts that left / arrived in this rotation. */
  soldAsset: "XMR" | "BTC" | null;
  sold: number;
  boughtAsset: "XMR" | "BTC";
  bought: number;
  /** Average fill prices in USDT, when that leg filled. */
  xmrUsd: number | null;
  btcUsd: number | null;
  orders: number;
  /** XMR per BTC implied by this rotation's own fills, when both legs filled. */
  ratio: number | null;
}

interface Legs {
  buy: { base: number; usd: number; n: number };
  sell: { base: number; usd: number; n: number };
}

function legsOf(fills: FillRow[], sym: string): Legs {
  const l: Legs = { buy: { base: 0, usd: 0, n: 0 }, sell: { base: 0, usd: 0, n: 0 } };
  for (const f of fills) {
    if (f.symbol !== sym) continue;
    const t = f.side === "buy" ? l.buy : l.sell;
    t.base += f.base;
    t.usd += f.base * f.price;
    t.n += 1;
  }
  return l;
}

/** Groups order fills into one row per rotation (newest first). */
export function buildExecutions(fills: FillRow[]): Execution[] {
  const by = new Map<string, FillRow[]>();
  for (const f of fills) {
    const a = by.get(f.rotationId) ?? [];
    a.push(f);
    by.set(f.rotationId, a);
  }
  const out: Execution[] = [];
  for (const [rotationId, fs] of by) {
    const x = legsOf(fs, XMR_SYM);
    const b = legsOf(fs, BTC_SYM);
    const ts = Math.min(...fs.map((f) => f.ts));
    let kind: Execution["kind"];
    let soldAsset: Execution["soldAsset"] = null;
    let sold = 0;
    let boughtAsset: Execution["boughtAsset"];
    let bought = 0;
    if (x.sell.base > 0) {
      kind = "to_btc";
      soldAsset = "XMR";
      sold = x.sell.base;
      boughtAsset = "BTC";
      bought = b.buy.base;
    } else if (b.sell.base > 0) {
      kind = "to_xmr";
      soldAsset = "BTC";
      sold = b.sell.base;
      boughtAsset = "XMR";
      bought = x.buy.base;
    } else if (b.buy.base > 0) {
      kind = "sweep_btc";
      boughtAsset = "BTC";
      bought = b.buy.base;
    } else {
      kind = "sweep_xmr";
      boughtAsset = "XMR";
      bought = x.buy.base;
    }
    const xmrUsd = x.sell.base > 0 ? x.sell.usd / x.sell.base : x.buy.base > 0 ? x.buy.usd / x.buy.base : null;
    const btcUsd = b.sell.base > 0 ? b.sell.usd / b.sell.base : b.buy.base > 0 ? b.buy.usd / b.buy.base : null;
    out.push({
      rotationId,
      ts,
      kind,
      soldAsset,
      sold,
      boughtAsset,
      bought,
      xmrUsd,
      btcUsd,
      orders: fs.length,
      ratio: xmrUsd && btcUsd ? btcUsd / xmrUsd : null,
    });
  }
  return out.sort((a, c) => c.ts - a.ts);
}

export interface TradeRow extends MirrorTrade {
  /** Real fills for this trade, when the bot traded it. Prices are XMR per BTC. */
  actual: {
    entryPrice: number | null;
    exitPrice: number | null;
    sizeBtc: number;
    /** XMR gained: size x (exit - entry). Open trades are marked to the current price. */
    pnlXmr: number | null;
    returnPct: number | null;
  } | null;
  /** Same size priced at the signal prices, for the signal-vs-actual comparison. */
  signalPnlXmr: number | null;
}

/** XMR per BTC from a window of fills: (BTC avg USD) / (XMR avg USD). */
function ratioOf(btcUsd: number, btcBase: number, xmrUsd: number, xmrBase: number): number | null {
  return btcBase > 0 && xmrBase > 0 ? btcUsd / btcBase / (xmrUsd / xmrBase) : null;
}

/**
 * Attaches the bot's real fills to the signal trades. A trade's entry fills are the
 * XMR sells and BTC buys between its entry and exit; its exit fills are the BTC sells and
 * XMR buys from the exit until the next trade starts. `mark` = BTC priced in XMR now.
 */
export function attachActual(trades: MirrorTrade[], fills: FillRow[], mark: number | null): TradeRow[] {
  const asc = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const rows: TradeRow[] = asc.map((t, i) => {
    const entryFrom = t.entryTime * 1000;
    const entryTo = t.exitTime !== null ? t.exitTime * 1000 : Infinity;
    const next = asc[i + 1];
    const exitTo = next ? next.entryTime * 1000 : Infinity;
    const inFills = fills.filter((f) => f.ts >= entryFrom && f.ts < entryTo);
    const outFills = t.exitTime !== null ? fills.filter((f) => f.ts >= entryTo && f.ts < exitTo) : [];
    const inBtc = legsOf(inFills, BTC_SYM).buy;
    const inX = legsOf(inFills, XMR_SYM).sell;
    if (inBtc.base <= 0) return { ...t, actual: null, signalPnlXmr: null };
    const entryPrice = ratioOf(inBtc.usd, inBtc.base, inX.usd, inX.base);
    let exitPrice: number | null = null;
    let size = inBtc.base;
    if (t.status === "closed") {
      const outBtc = legsOf(outFills, BTC_SYM).sell;
      const outX = legsOf(outFills, XMR_SYM).buy;
      exitPrice = ratioOf(outBtc.usd, outBtc.base, outX.usd, outX.base);
      if (outBtc.base > 0) size = Math.min(size, outBtc.base);
    } else {
      exitPrice = mark;
    }
    const pnl = entryPrice !== null && exitPrice !== null ? size * (exitPrice - entryPrice) : null;
    const ret = entryPrice !== null && exitPrice !== null ? (exitPrice / entryPrice - 1) * 100 : null;
    const sigExit = t.status === "closed" ? t.exitSignal : mark;
    const signalPnl = t.entrySignal !== null && sigExit !== null ? size * (sigExit - t.entrySignal) : null;
    return { ...t, actual: { entryPrice, exitPrice, sizeBtc: size, pnlXmr: pnl, returnPct: ret }, signalPnlXmr: signalPnl };
  });
  return rows.sort((a, b) => b.entryTime - a.entryTime);
}
