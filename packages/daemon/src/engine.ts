import type { Exchange, WalletBalance } from "./bitfinex.js";
import type { BotConfig, BotState } from "./config.js";
import { BTC_UST, XAUT_UST, XMR_BTC, XMR_UST, convertToUst, otherSymbol, rotate, sweepUst } from "./execute.js";
import {
  RELIABLE_BARS,
  buildTrades,
  computeLarsson,
  invertCandles,
  replaySignals,
  type DailyCandle,
  type LarssonBar,
} from "./larsson.js";
import type { Store } from "./store.js";

/** XMR/BTC history reaches back to 2016 (~3,700 daily bars). The Larsson lines need the full history to match TradingView exactly. */
export const CANDLE_LIMIT = 5000;
/** Smallest XMR sale (exchange minimum is 0.02 XMR) and BTC purchase (0.00004 BTC) used to close a last small reserve gap. */
const MIN_XMR_SELL = 0.0205;
const MIN_BTC_BUY = 0.00005;
/** Smallest XAUT purchase (exchange minimum is 0.002 XAUT) used to close a last small XAUT gap. */
const MIN_XAUT_BUY = 0.0021;

// ---------------------------------------------------------------- analysis

export interface Analysis {
  /** Inverted (BTC priced in XMR) bars with Larsson lines. */
  bars: LarssonBar[];
  signals: ReturnType<typeof replaySignals>["signals"];
  /** The strategy wants to hold BTC (true) or XMR (false), after the strategy entry cap. */
  desiredBtc: boolean;
  /** Same without the strategy cap, for the dashboard. */
  desiredBtcUncapped: boolean;
  /** Last confirmed bar with a regime. */
  last: { regime: "orange" | "navy" | "gray"; dist: number | null; time: number } | null;
  warmup: boolean;
}

/** Pure: candles (XMR/BTC, as the exchange quotes them) -> what the strategy wants now. */
export function analyze(rawXmrBtc: DailyCandle[], cfg: BotConfig, now: number): Analysis {
  const bars = computeLarsson(invertCandles(rawXmrBtc), now);
  const cap = cfg.strategyCap.enabled ? cfg.strategyCap.maxDistPct : null;
  const capped = replaySignals(bars, cap);
  const plain = cap === null ? capped : replaySignals(bars, null);
  const lastBar = [...bars].reverse().find((b) => b.confirmed && b.regime !== null) ?? null;
  return {
    bars,
    signals: capped.signals,
    desiredBtc: capped.holdingBtc,
    desiredBtcUncapped: plain.holdingBtc,
    last: lastBar ? { regime: lastBar.regime!, dist: lastBar.dist, time: lastBar.time } : null,
    warmup: bars.length < RELIABLE_BARS,
  };
}

export function tradesFor(a: Analysis) {
  const lastClose = a.bars[a.bars.length - 1]?.close ?? null;
  return buildTrades(a.signals, lastClose);
}

// ---------------------------------------------------------------- planning

export interface WalletView {
  xmr: number;
  btc: number;
  xmrAvail: number;
  btcAvail: number;
  ustAvail: number;
  /** XAUT held as the secondary reserve. */
  xaut?: number;
  xautAvail?: number;
  /** Balances in anything other than BTC, XMR, XAUT and USDT (USD, other coins). */
  others?: Array<{ currency: string; available: number }>;
}

export function walletView(w: WalletBalance[]): WalletView {
  const get = (c: string) => w.find((x) => x.currency === c);
  const ust = w.filter((x) => x.currency === "UST" || x.currency === "USDT").reduce((s, x) => s + x.availableBalance, 0);
  return {
    xmr: get("XMR")?.balance ?? 0,
    btc: get("BTC")?.balance ?? 0,
    xmrAvail: get("XMR")?.availableBalance ?? 0,
    btcAvail: get("BTC")?.availableBalance ?? 0,
    ustAvail: ust,
    xaut: get("XAUT")?.balance ?? 0,
    xautAvail: get("XAUT")?.availableBalance ?? 0,
    others: w
      .filter((x) => !(["BTC", "XMR", "XAUT", "UST", "USDT"] as string[]).includes(x.currency) && !x.currency.startsWith("TEST") && x.availableBalance > 0)
      .map((x) => ({ currency: x.currency, available: x.availableBalance })),
  };
}

/** XAUT the bot keeps as the secondary reserve: the XAUT amount, limited to the value of the BTC reserve, and 0 while the BTC reserve is off. */
export function xautTargetOf(cfg: { reservesEnabled?: boolean; btcReserve: number; xautReserve: number }, usdPerBtc: number, usdPerXaut: number): number {
  if (cfg.reservesEnabled === false || !(cfg.btcReserve > 0) || !(cfg.xautReserve > 0) || !(usdPerXaut > 0)) return 0;
  return Math.min(cfg.xautReserve, (cfg.btcReserve * usdPerBtc) / usdPerXaut);
}

/** USDT that counts as part of the account value: leftovers of the bot's own rotations. */
export function parkedUst(w: { ustAvail: number }, strandedUst: number): number {
  return Math.min(w.ustAvail, Math.max(0, strandedUst));
}

export interface PlanInput {
  cfg: BotConfig;
  state: BotState;
  wallets: WalletView;
  /** BTC per XMR. */
  price: number;
  usdPerXmr: number;
  usdPerBtc: number;
  /** USD per XAUT, when the XAUT price could be read (needed for the XAUT reserve). */
  usdPerXaut?: number;
  desiredBtc: boolean;
  /** Distance of BTC (in XMR) above its Larsson baseline, as a fraction; null while warming up. */
  dist: number | null;
  /** USD value of each "other" balance (filled in by runTick). */
  others?: Array<{ currency: string; available: number; usd: number }>;
}

export interface DepositFound {
  asset: "XMR" | "BTC";
  /** Positive = deposit, negative = withdrawal. */
  amount: number;
  valueXmr: number;
  action: string;
}

export type PlannedAction =
  | { kind: "none"; why: string }
  | { kind: "sweep"; into: "btc" | "xmr"; ust: number; idle?: boolean }
  | { kind: "reserve_btc"; xmr: number }
  | { kind: "reserve_xaut"; btc: number }
  | { kind: "release_xaut"; xaut: number }
  | { kind: "convert_other"; currency: string; amount: number; usd: number }
  | { kind: "to_btc"; xmr: number }
  | { kind: "to_xmr"; btc: number };

export interface Plan {
  deposits: DepositFound[];
  heldBackXmr: number;
  clearStranded: boolean;
  action: PlannedAction;
  notes: string[];
}

/**
 * Pure planning step. Detects wallet changes the bot did not cause (deposits and
 * withdrawals), applies the new-money cap, and decides the single next action.
 */
export function planTick(i: PlanInput): Plan {
  const { cfg, state, wallets: w, price, desiredBtc, dist } = i;
  const notes: string[] = [];
  const deposits: DepositFound[] = [];
  let heldBack = state.heldBackXmr;

  // 1. Wallet changes since the end of the previous tick = money the bot did not move.
  const snap = state.snapshot;
  if (snap) {
    const dX = w.xmr - snap.xmr;
    const dB = w.btc - snap.btc;
    const equityBefore = snap.xmr + snap.btc / price;
    if (Math.abs(dX) * i.usdPerXmr >= cfg.minTradeUsd) {
      if (dX > 0) {
        const lumpPct = equityBefore > 1e-9 ? (dX / equityBefore) * 100 : 100;
        let action: string;
        if (!desiredBtc) {
          action = "kept as XMR (strategy is in XMR)";
        } else if (cfg.newMoneyCap.enabled && lumpPct >= cfg.newMoneyCap.minLumpPct && dist !== null && dist * 100 > cfg.newMoneyCap.maxDistPct) {
          heldBack += dX;
          action = `held back: BTC ${(dist * 100).toFixed(1)}% above baseline (> ${cfg.newMoneyCap.maxDistPct}% new-money cap)`;
        } else {
          action = "will be converted to BTC (strategy is in BTC)";
        }
        deposits.push({ asset: "XMR", amount: dX, valueXmr: dX, action });
      } else {
        deposits.push({ asset: "XMR", amount: dX, valueXmr: dX, action: "withdrawal" });
      }
    }
    if (Math.abs(dB) * i.usdPerBtc >= cfg.minTradeUsd) {
      deposits.push({
        asset: "BTC",
        amount: dB,
        valueXmr: dB / price,
        action: dB < 0 ? "withdrawal" : desiredBtc ? "kept as BTC (strategy is in BTC)" : "will be converted to XMR (strategy is in XMR)",
      });
    }
  }

  // 2. Release held-back new money.
  if (heldBack > 0) {
    if (!cfg.newMoneyCap.enabled) {
      notes.push("new-money cap switched off: released held-back XMR");
      heldBack = 0;
    } else if (!desiredBtc) {
      notes.push("strategy is in XMR: held-back XMR released");
      heldBack = 0;
    } else if (dist !== null && dist * 100 <= cfg.newMoneyCap.maxDistPct) {
      notes.push(`BTC back within ${cfg.newMoneyCap.maxDistPct}% of baseline: held-back XMR released`);
      heldBack = 0;
    }
  }
  heldBack = Math.max(0, Math.min(heldBack, w.xmr));

  // 3. Decide the next action.
  let action: PlannedAction;
  let clearStranded = false;
  // Reserves. The BTC reserve is a pot kept out of the strategy; part of it can be held as XAUT instead of BTC
  // (the XAUT reserve, carved out of the pot only). USDT in the wallet is idle and is swept into what the strategy wants.
  const bres = cfg.reservesEnabled === false ? 0 : Math.max(0, cfg.btcReserve);
  const uX = i.usdPerXaut && i.usdPerXaut > 0 ? i.usdPerXaut : 0;
  const xaut = w.xautAvail ?? 0;
  const xTarget = uX > 0 ? xautTargetOf(cfg, i.usdPerBtc, uX) : 0;
  const potXautBtc = uX > 0 ? (Math.min(xaut, xTarget) * uX) / i.usdPerBtc : 0; // BTC value of the XAUT that is part of the pot
  const xmrFree = Math.max(0, w.xmrAvail - heldBack);
  const btcHold = Math.max(0, bres - potXautBtc); // BTC that stays in the wallet for the pot
  const stratBtc = Math.max(0, w.btc - btcHold); // BTC the strategy itself holds (position cap counts only this)
  // Reserve moves must clear the exchange minimum orders; a plain idle-USDT sweep only needs ~$2
  // (and is parked for a balance whose last sweep could not buy anything).
  const reserveMin = Math.max(cfg.minTradeUsd, 5);
  const idleMin = Math.max(cfg.minTradeUsd, 2);
  const idleParked = state.ignoredOthers.includes(`USDT:${w.ustAvail.toFixed(2)}`);
  // The sweep itself keeps a small price buffer, so the whole excess can be offered.
  const excessUst = idleParked ? 0 : Math.max(0, w.ustAvail);
  if (state.strandedUst >= cfg.minTradeUsd) {
    const ust = Math.min(state.strandedUst, excessUst);
    if (ust >= 1) {
      action = { kind: "sweep", into: desiredBtc ? "btc" : "xmr", ust };
      return { deposits, heldBackXmr: heldBack, clearStranded, action, notes };
    }
    clearStranded = true;
    notes.push(idleParked ? "stranded USDT is too small to buy anything: set aside until the balance changes" : "stranded USDT is no longer in the wallet: cleared");
  } else if (state.strandedUst > 0) {
    clearStranded = true; // dust
  }
  // 3-. Any other balance (USD, other coins) is turned into USDT; the idle-USDT sweep then moves it on.
  for (const o of i.others ?? []) {
    if (o.usd >= Math.max(cfg.minTradeUsd, 2)) {
      notes.push(`${o.available} ${o.currency} (~$${o.usd.toFixed(2)}) is neither USDT, BTC nor XMR: converting to USDT`);
      action = { kind: "convert_other", currency: o.currency, amount: o.available, usd: o.usd };
      return { deposits, heldBackXmr: heldBack, clearStranded, action, notes };
    }
  }
  // 3a. BTC pot short (BTC in the wallet plus the USDT carved from it) while the strategy is in XMR: build it from XMR.
  // While the strategy wants BTC, every XMR is converted to BTC anyway, which fills the pot.
  if (bres > 0 && !desiredBtc) {
    const deficit = bres - (w.btcAvail + potXautBtc);
    // A last small gap is closed with the smallest XMR sale the exchange accepts, so the reserve ends at or just
    // above the target. Gaps under 0.0000001 BTC are ignored.
    if (deficit >= 0.0000001) {
      const buyBtc = Math.max(deficit, MIN_XMR_SELL * price);
      const buyUsd = buyBtc * i.usdPerBtc;
      // Idle USDT in the wallet goes into the pot first; XMR is only sold for what is still missing.
      if (excessUst >= Math.min(buyUsd, MIN_BTC_BUY * i.usdPerBtc)) {
        const ust = Math.min(excessUst, buyUsd);
        notes.push(`BTC reserve is short: ${ust.toFixed(2)} idle USDT spent on BTC first`);
        action = { kind: "sweep", into: "btc", ust, idle: true };
        return { deposits, heldBackXmr: heldBack, clearStranded, action, notes };
      }
      const sell = Math.min(xmrFree, buyBtc / price);
      if (sell >= MIN_XMR_SELL && sell * i.usdPerXmr >= (buyUsd >= cfg.minTradeUsd ? Math.max(cfg.minTradeUsd, 4) : 4)) {
        notes.push(`BTC reserve is ${bres} but only ${(bres - deficit).toFixed(8)} is in place: buying BTC with XMR`);
        action = { kind: "reserve_btc", xmr: sell };
        return { deposits, heldBackXmr: heldBack, clearStranded, action, notes };
      }
    }
  }
  // 3b. XAUT part of the pot short: sell BTC from the pot for XAUT. A last gap below the exchange minimum is closed with
  // the minimum order, so the XAUT ends at or just above the target.
  if (uX > 0 && xTarget > 0) {
    const xDef = xTarget - xaut;
    if (xDef >= 0.00001) {
      const buyXaut = Math.max(xDef, MIN_XAUT_BUY);
      const sellBtc = Math.min(w.btcAvail, (buyXaut * uX) / i.usdPerBtc);
      const usd = sellBtc * i.usdPerBtc;
      if (usd >= (buyXaut * uX >= cfg.minTradeUsd ? Math.max(cfg.minTradeUsd, 4) : 4)) {
        notes.push(`XAUT reserve is ${xTarget.toFixed(4)} but only ${xaut.toFixed(4)} is in place: buying XAUT with BTC`);
        action = { kind: "reserve_xaut", btc: sellBtc };
        return { deposits, heldBackXmr: heldBack, clearStranded, action, notes };
      }
    }
  }
  // 3b'. XAUT above the target (reserve lowered or switched off, or XAUT deposited): released back into BTC.
  if (uX > 0) {
    const xExcess = xaut - xTarget;
    if (xExcess >= MIN_XAUT_BUY && xExcess * uX >= Math.max(cfg.minTradeUsd, 12)) {
      notes.push(`${xExcess.toFixed(4)} XAUT is above the XAUT reserve: converting back to BTC`);
      action = { kind: "release_xaut", xaut: xExcess };
      return { deposits, heldBackXmr: heldBack, clearStranded, action, notes };
    }
  }
  // 3c. USDT in the wallet is idle: swept into the desired asset (position cap respected).
  if (excessUst >= idleMin) {
    let ust = excessUst;
    if (desiredBtc && cfg.positionCapXmr > 0) {
      const room = Math.max(0, cfg.positionCapXmr - stratBtc / price);
      ust = Math.min(ust, room * i.usdPerXmr);
    }
    if (ust >= idleMin) {
      action = { kind: "sweep", into: desiredBtc ? "btc" : "xmr", ust, idle: true };
      notes.push(`${ust.toFixed(2)} USDT sitting idle in the wallet: swept into ${desiredBtc ? "BTC" : "XMR"}`);
      return { deposits, heldBackXmr: heldBack, clearStranded, action, notes };
    }
  }

  if (desiredBtc) {
    let sell = xmrFree;
    let why = "";
    if (cfg.positionCapXmr > 0) {
      const room = Math.max(0, cfg.positionCapXmr - stratBtc / price);
      if (room < sell) {
        sell = room;
        why = ` (position cap ${cfg.positionCapXmr} XMR)`;
      }
    }
    if (sell >= MIN_XMR_SELL && sell * i.usdPerXmr >= cfg.minTradeUsd) action = { kind: "to_btc", xmr: sell }; // below the exchange minimum order nothing can be sold
    else action = { kind: "none", why: heldBack > 0 ? `holding BTC; ${heldBack.toFixed(4)} XMR held back by the new-money cap` : `holding BTC${why}; nothing to convert` };
  } else {
    const sellBtc = Math.max(0, w.btcAvail - btcHold);
    if (sellBtc * i.usdPerBtc >= Math.max(cfg.minTradeUsd, MIN_XMR_SELL * i.usdPerXmr * 1.02)) action = { kind: "to_xmr", btc: sellBtc }; // the XMR buy must reach the exchange minimum
    else action = { kind: "none", why: bres > 0 ? "holding XMR; the BTC reserve stays in BTC" : "holding XMR; nothing to convert" };
  }
  return { deposits, heldBackXmr: heldBack, clearStranded, action, notes };
}

// ---------------------------------------------------------------- tick

export interface TickResult {
  action: "disabled" | "idle" | "would_to_btc" | "would_to_xmr" | "would_sweep" | "would_raise_usdt" | "would_reserve" | "would_convert" | "rotated" | "raised" | "reserved" | "converted" | "swept" | "blocked" | "error";
  detail: string;
}

const fx = (n: number, d = 6) => n.toFixed(d);

/**
 * One pass: read the market and wallets, plan, and (only when enabled AND LIVE)
 * execute. DRY_RUN reads everything and logs what it would do, never an order.
 */
export async function runTick(d: { ex: Exchange; store: Store; now?: number; pollMs?: number }): Promise<TickResult> {
  const { ex, store } = d;
  const now = d.now ?? Date.now();
  const cfg = store.getConfig();
  let state = store.getState();
  const finish = (r: TickResult): TickResult => {
    state = { ...state, lastResult: { action: r.action, detail: r.detail, at: now }, lastTickAt: now };
    store.setState(state);
    return r;
  };

  try {
    const [candles, xmrBtc, xmrUst, btcUst, walletRows] = await Promise.all([
      ex.getDailyCandles(XMR_BTC, CANDLE_LIMIT),
      ex.getTicker(XMR_BTC),
      ex.getTicker(XMR_UST),
      ex.getTicker(BTC_UST),
      ex.getWallets(),
    ]);
    const newest = candles[candles.length - 1];
    if (!newest || now / 1000 - newest.time > 3 * 86_400) {
      return finish({ action: "blocked", detail: "candle data is stale or empty (newest bar is more than 3 days old); not trading" });
    }
    const a = analyze(candles, cfg, now);
    if (!a.last) return finish({ action: "blocked", detail: `not enough daily candles yet (${a.bars.length}); the lines need at least 29` });
    const price = xmrBtc.last;
    if (!(price > 0) || !(xmrUst.last > 0) || !(btcUst.last > 0)) return finish({ action: "blocked", detail: "missing prices" });
    const wallets = walletView(walletRows);
    // XAUT price, only needed while the XAUT reserve is in use or some XAUT is held.
    let usdPerXaut: number | undefined;
    if ((cfg.reservesEnabled !== false && cfg.btcReserve > 0 && cfg.xautReserve > 0) || (wallets.xaut ?? 0) > 0) {
      try {
        const t = await ex.getTicker(XAUT_UST);
        if (t.last > 0) usdPerXaut = t.last;
      } catch {
        usdPerXaut = undefined; // XAUT steps are skipped this tick
      }
    }

    // USD value of every balance that is not USDT, BTC or XMR (skipping ones that failed before and have not changed).
    const others: Array<{ currency: string; available: number; usd: number }> = [];
    for (const o of wallets.others ?? []) {
      if (state.ignoredOthers.includes(`${o.currency}:${o.available.toFixed(4)}`)) continue;
      let usd = 0;
      if (o.currency === "USD") usd = o.available;
      else {
        try {
          usd = o.available * (await ex.getTicker(otherSymbol(o.currency))).bid;
        } catch {
          usd = 0;
        }
      }
      others.push({ currency: o.currency, available: o.available, usd });
    }

    const plan = planTick({
      cfg,
      state,
      wallets,
      price,
      usdPerXmr: xmrUst.last,
      usdPerBtc: btcUst.last,
      ...(usdPerXaut !== undefined ? { usdPerXaut } : {}),
      desiredBtc: a.desiredBtc,
      dist: a.last.dist,
      others,
    });

    for (const dep of plan.deposits) {
      store.addDeposit({ ts: now, asset: dep.asset, amount: dep.amount, valueXmr: dep.valueXmr, dist: a.last.dist, action: dep.action });
      store.addEvent("deposit", `${dep.amount > 0 ? "Deposit" : "Withdrawal"} seen: ${fx(Math.abs(dep.amount), 6)} ${dep.asset} - ${dep.action}`, undefined, now);
    }
    for (const n of plan.notes) store.addEvent("info", n, undefined, now);
    state = { ...state, heldBackXmr: plan.heldBackXmr, ...(plan.clearStranded ? { strandedUst: 0 } : {}) };

    const equityXmr = wallets.xmr + wallets.btc / price + parkedUst(wallets, state.strandedUst) / xmrUst.last + (usdPerXaut ? ((wallets.xaut ?? 0) * usdPerXaut) / xmrUst.last : 0);
    store.addSnapshot({ ts: now, xmr: wallets.xmr, btc: wallets.btc, price, equityXmr });
    const baseline = { xmr: wallets.xmr, btc: wallets.btc, at: now };

    const want = a.desiredBtc ? "BTC" : "XMR";
    if (!cfg.enabled) {
      state = { ...state, snapshot: baseline };
      return finish({ action: "disabled", detail: `bot is disabled (strategy wants ${want}, regime ${a.last.regime})` });
    }
    if (plan.action.kind === "none") {
      state = { ...state, snapshot: baseline };
      return finish({ action: "idle", detail: `${plan.action.why} (strategy wants ${want}, regime ${a.last.regime})` });
    }

    const act = plan.action;
    const describe =
      act.kind === "to_btc"
        ? `${fx(act.xmr, 6)} XMR -> BTC`
        : act.kind === "to_xmr"
          ? `${fx(act.btc, 8)} BTC -> XMR`
          : act.kind === "reserve_btc"
            ? `${fx(act.xmr, 6)} XMR -> BTC (BTC reserve)`
            : act.kind === "reserve_xaut"
              ? `${fx(act.btc, 8)} BTC -> XAUT (XAUT reserve)`
              : act.kind === "release_xaut"
                ? `${fx(act.xaut, 6)} XAUT -> BTC (XAUT released)`
                : act.kind === "convert_other"
                  ? `${fx(act.amount, 6)} ${act.currency} (~$${fx(act.usd, 2)}) -> USDT`
                  : `${fx(act.ust, 2)} USDT -> ${act.into.toUpperCase()}`;

    if (cfg.mode !== "LIVE" || ex.runMode !== "LIVE") {
      state = { ...state, snapshot: baseline };
      const key = `${act.kind}:${describe}`;
      if (state.lastWouldKey !== key) {
        store.addEvent("would", `[DRY_RUN] would convert ${describe}`, { regime: a.last.regime, dist: a.last.dist }, now);
        state = { ...state, lastWouldKey: key };
      }
      const kind = act.kind === "to_btc" ? "would_to_btc" : act.kind === "to_xmr" ? "would_to_xmr" : act.kind === "reserve_btc" || act.kind === "reserve_xaut" || act.kind === "release_xaut" ? "would_reserve" : act.kind === "convert_other" ? "would_convert" : "would_sweep";
      return finish({ action: kind, detail: `[DRY_RUN] would convert ${describe}` });
    }

    // ---- LIVE ----
    // Reserve moves and idle-USDT sweeps are tagged "usdt:" so they never pose as trade entries/exits.
    const rotationId = act.kind === "convert_other" || (act.kind === "sweep" && act.idle) ? `usdt:${now}` : act.kind === "reserve_btc" ? `xres:${now}` : act.kind === "reserve_xaut" || act.kind === "release_xaut" ? `xaut:${now}` : String(now);
    const ownFills: Array<{ symbol: string; side: "buy" | "sell"; base: number; price: number }> = [];
    const onFill = (f: { symbol: string; side: "buy" | "sell"; base: number; price: number }) => {
      ownFills.push(f);
      store.addFill({ ts: Date.now(), rotationId, symbol: f.symbol, side: f.side, base: f.base, price: f.price });
    };
    store.addEvent("rotation_start", `Converting ${describe}`, { regime: a.last.regime, dist: a.last.dist }, now);

    // Re-read the run mode before every new order so PAUSED / DRY_RUN stops a rotation that is already running.
    const shouldStop = () => {
      const c = store.getConfig();
      return !c.enabled || c.mode !== "LIVE";
    };
    let stranded: number;
    let summary: string;
    let interrupted: string | null;
    let kind: TickResult["action"];
    if (act.kind === "convert_other") {
      const r = await convertToUst({ ex, currency: act.currency, amount: act.amount, chunkUsd: cfg.chunkUsd, onFill, shouldStop, ...(d.pollMs !== undefined ? { pollMs: d.pollMs } : {}) });
      stranded = state.strandedUst;
      summary = `Converted ${fx(r.spent, 6)} ${act.currency} into ${fx(r.gotUst, 2)} USDT`;
      interrupted = r.interrupted;
      kind = "converted";
      if (r.gotUst <= 0) {
        // Nothing could be converted (below the minimum order, no pair...): leave it alone until the balance changes.
        state = { ...state, ignoredOthers: [...state.ignoredOthers, `${act.currency}:${act.amount.toFixed(4)}`].slice(-20) };
      }
    } else if (act.kind === "sweep") {
      const r = await sweepUst({ ex, into: act.into, ust: act.ust, chunkUsd: cfg.chunkUsd, onFill, shouldStop, ...(d.pollMs !== undefined ? { pollMs: d.pollMs } : {}) });
      stranded = r.strandedUst;
      summary = `Swept ${fx(r.spentUst, 2)} USDT into ${act.into.toUpperCase()} (${fx(r.bought, act.into === "btc" ? 8 : 6)} bought)`;
      interrupted = r.interrupted;
      kind = "swept";
      if (r.bought <= 0) {
        // Too small for the pair's minimum order: park it (stranded or idle) so it cannot block a rotation,
        // until the USDT balance changes.
        state = { ...state, ignoredOthers: [...state.ignoredOthers, `USDT:${wallets.ustAvail.toFixed(2)}`].slice(-20) };
      }
    } else {
      const r = await rotate({
        ex,
        direction: act.kind === "to_btc" || act.kind === "reserve_btc" ? "xmr_to_btc" : act.kind === "reserve_xaut" ? "btc_to_xaut" : act.kind === "release_xaut" ? "xaut_to_btc" : "btc_to_xmr",
        amount: act.kind === "to_btc" || act.kind === "reserve_btc" ? act.xmr : act.kind === "release_xaut" ? act.xaut : act.btc,
        chunkUsd: cfg.chunkUsd,
        onFill,
        shouldStop,
        ...(d.pollMs !== undefined ? { pollMs: d.pollMs } : {}),
      });
      stranded = r.strandedUst;
      const [soldU, boughtU, soldD, boughtD] =
        act.kind === "to_btc" || act.kind === "reserve_btc" ? ["XMR", "BTC", 6, 8] : act.kind === "reserve_xaut" ? ["BTC", "XAUT", 8, 6] : act.kind === "release_xaut" ? ["XAUT", "BTC", 6, 8] : ["BTC", "XMR", 8, 6];
      summary = `Sold ${fx(r.sold, soldD as number)} ${soldU}, bought ${fx(r.bought, boughtD as number)} ${boughtU}`;
      interrupted = r.interrupted;
      kind = act.kind === "reserve_btc" || act.kind === "reserve_xaut" || act.kind === "release_xaut" ? "reserved" : "rotated";
    }
    state = { ...state, strandedUst: act.kind === "sweep" && act.idle ? state.strandedUst : stranded, lastWouldKey: null };
    store.addEvent(interrupted ? "rotation_partial" : "rotation_done", interrupted ? `${summary} - stopped: ${interrupted}` : summary, { stranded }, Date.now());

    // New baseline = wallets after our own trades, so they are never mistaken for deposits.
    try {
      const after = walletView(await ex.getWallets());
      // Anything beyond our own fills that changed during the rotation (a transfer in or out) is logged, not absorbed.
      const net = (sym: string) => ownFills.filter((f) => f.symbol === sym).reduce((t, f) => t + (f.side === "buy" ? f.base : -f.base), 0);
      const notionalUsd = ownFills.reduce((t, f) => t + f.base * f.price, 0);
      const tolUsd = Math.max(cfg.minTradeUsd, 0.003 * notionalUsd);
      const dA = after.xmr - (wallets.xmr + net(XMR_UST));
      const dB = after.btc - (wallets.btc + net(BTC_UST));
      for (const [asset, amt, usd, val] of [
        ["XMR", dA, xmrUst.last, dA] as const,
        ["BTC", dB, btcUst.last, dB / price] as const,
      ]) {
        if (Math.abs(amt) * usd >= tolUsd) {
          const what = amt < 0 ? "withdrawal (seen during a rotation)" : "deposit (seen during a rotation)";
          store.addDeposit({ ts: Date.now(), asset, amount: amt, valueXmr: val, dist: a.last.dist, action: what });
          store.addEvent("deposit", `${amt > 0 ? "Deposit" : "Withdrawal"} seen: ${fx(Math.abs(amt), 6)} ${asset} - ${what}`, undefined, Date.now());
        }
      }
      state = { ...state, snapshot: { xmr: after.xmr, btc: after.btc, at: Date.now() } };
    } catch {
      state = { ...state, snapshot: null };
    }
    return finish({ action: kind, detail: interrupted ? `${summary} - stopped: ${interrupted}` : summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.addEvent("error", msg, undefined, now);
    return finish({ action: "error", detail: msg });
  }
}
