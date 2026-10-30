/**
 * Larsson Line engine, MIRRORED for XMR accumulation.
 *
 * Input candles are Bitfinex XMR/BTC (BTC per XMR). They are inverted so the
 * chart is BTC priced in XMR (XMR per BTC): o=1/o, h=1/low, l=1/high, c=1/close.
 * SMMA 15/19/25/29 of hl2. Regime: gray if the middle lines disagree with the
 * fast/slow ordering; else orange (fast > slow) or navy.
 * Base asset = XMR. Orange = hold BTC; navy/gray = hold XMR. Plain version
 * (no take-profit). Signals use confirmed daily closes and execute at the NEXT
 * bar's open. Success is measured in XMR.
 */
export interface DailyCandle {
  /** Unix seconds (bar open). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type LarssonRegime = "orange" | "navy" | "gray";

export interface LarssonBar extends DailyCandle {
  v1: number | null;
  m1: number | null;
  m2: number | null;
  v2: number | null;
  regime: LarssonRegime | null;
  /** (close - v2) / v2, null until the baseline exists. */
  dist: number | null;
  /** False for the still-forming current day. */
  confirmed: boolean;
}

export const SMMA_PERIODS = [15, 19, 25, 29] as const;
/** Bars after which the lines have mostly forgotten their SMA seed (practical warm-up). */
export const RELIABLE_BARS = 90;
const DAY_S = 86_400;

function smma(values: number[], length: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < length) return out;
  let prev = values.slice(0, length).reduce((s, x) => s + x, 0) / length;
  out[length - 1] = prev;
  for (let i = length; i < values.length; i++) {
    prev = (prev * (length - 1) + values[i]!) / length;
    out[i] = prev;
  }
  return out;
}

/** Computes lines and regimes for every bar. `nowMs` decides which bar is still forming. */
export function computeLarsson(candlesIn: DailyCandle[], nowMs: number): LarssonBar[] {
  const candles = [...candlesIn].filter((c) => Number.isFinite(c.close)).sort((a, b) => a.time - b.time);
  const hl2 = candles.map((c) => (c.high + c.low) / 2);
  const [v1, m1, m2, v2] = SMMA_PERIODS.map((p) => smma(hl2, p)) as [
    Array<number | null>,
    Array<number | null>,
    Array<number | null>,
    Array<number | null>,
  ];
  return candles.map((c, i) => {
    const a = v1[i] ?? null;
    const b = m1[i] ?? null;
    const m = m2[i] ?? null;
    const s = v2[i] ?? null;
    let regime: LarssonRegime | null = null;
    let dist: number | null = null;
    if (a !== null && b !== null && m !== null && s !== null) {
      const gray = a < b !== a < s || m < s !== a < s;
      regime = gray ? "gray" : a > s ? "orange" : "navy";
      dist = (c.close - s) / s;
    }
    return { ...c, v1: a, m1: b, m2: m, v2: s, regime, dist, confirmed: (c.time + DAY_S) * 1000 <= nowMs };
  });
}

export interface LarssonSignal {
  /** Bar whose confirmed close produced the signal (unix s). */
  signalBarTime: number;
  /** enter = XMR -> BTC, exit = BTC -> XMR. */
  action: "enter" | "exit";
  /** Open of the following bar (XMR per BTC) = the assumed execution price (null if that bar does not exist yet). */
  signalPrice: number | null;
  /** Unix s of the execution bar (signal bar + 1 day). */
  execTime: number;
}

/**
 * Inverts XMR/BTC candles (BTC per XMR) into BTC-in-XMR candles.
 * Rows with a non-positive price are dropped.
 */
export function invertCandles(candles: DailyCandle[]): DailyCandle[] {
  return candles
    .filter((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .map((c) => ({ time: c.time, open: 1 / c.open, high: 1 / c.low, low: 1 / c.high, close: 1 / c.close }));
}

/**
 * Replays the plain engine over confirmed bars. Starts flat in XMR.
 *
 * `entryCapPct` (null = off) is the STRATEGY entry cap: a flat->BTC entry on an
 * orange bar is skipped while the close is more than that % above the baseline
 * (SMMA 29). It is re-checked on every following orange bar, so the entry can
 * happen later once price comes back within the cap. It never affects an
 * existing BTC position or exits.
 */
export function replaySignals(bars: LarssonBar[], entryCapPct: number | null = null): { signals: LarssonSignal[]; holdingBtc: boolean } {
  const signals: LarssonSignal[] = [];
  let holdingBtc = false;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (!b.confirmed || b.regime === null) continue;
    const next = bars[i + 1];
    const capOk = entryCapPct === null || b.dist === null || b.dist * 100 <= entryCapPct;
    if (!holdingBtc && b.regime === "orange" && capOk) {
      holdingBtc = true;
      signals.push({ signalBarTime: b.time, action: "enter", signalPrice: next ? next.open : null, execTime: b.time + DAY_S });
    } else if (holdingBtc && b.regime !== "orange") {
      holdingBtc = false;
      signals.push({ signalBarTime: b.time, action: "exit", signalPrice: next ? next.open : null, execTime: b.time + DAY_S });
    }
  }
  return { signals, holdingBtc };
}

export interface MirrorTrade {
  /** Round trip XMR -> BTC -> XMR. */
  entryTime: number;
  entrySignal: number | null;
  exitTime: number | null;
  exitSignal: number | null;
  status: "open" | "closed";
  /** XMR gained: exit/entry - 1 on the BTC-in-XMR price (open trades marked to `mark`). */
  xmrReturnPct: number | null;
}

/** Pairs enter/exit signals into trades and measures each in XMR. */
export function buildTrades(signals: LarssonSignal[], mark: number | null): MirrorTrade[] {
  const trades: MirrorTrade[] = [];
  let open: MirrorTrade | null = null;
  const pct = (from: number | null, to: number | null) => (from && to ? (to / from - 1) * 100 : null);
  for (const s of signals) {
    if (s.action === "enter") {
      open = { entryTime: s.execTime, entrySignal: s.signalPrice, exitTime: null, exitSignal: null, status: "open", xmrReturnPct: null };
      trades.push(open);
    } else if (open) {
      open.exitTime = s.execTime;
      open.exitSignal = s.signalPrice;
      open.status = "closed";
      open.xmrReturnPct = pct(open.entrySignal, open.exitSignal);
      open = null;
    }
  }
  if (open) open.xmrReturnPct = pct(open.entrySignal, mark);
  return trades;
}
