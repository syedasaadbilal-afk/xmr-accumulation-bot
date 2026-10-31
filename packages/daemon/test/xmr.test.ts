import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_STATE, parseConfig, type BotConfig, type BotState } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { analyze, planTick, runTick, type PlanInput } from "../src/engine.js";
import { rotate } from "../src/execute.js";
import { computeLarsson, invertCandles, replaySignals } from "../src/larsson.js";
import { twrXmrPct } from "../src/service.js";
import { Store } from "../src/store.js";
import { attachActual, buildExecutions } from "../src/timeline.js";
import { DOWN_CLOSES, FakeExchange, UP_CLOSES, nowAfter, xmrBtcPath } from "./helpers.js";

const cfg = (over: Partial<BotConfig> = {}): BotConfig => ({ ...DEFAULT_CONFIG, enabled: true, mode: "LIVE", ...over });
const newStore = () => {
  const db = openDatabase(":memory:");
  applyMigrations(db);
  return new Store(db);
};

describe("mirror larsson engine", () => {
  it("inverts XMR/BTC candles into BTC-in-XMR with swapped high/low", () => {
    const inv = invertCandles([{ time: 1, open: 0.04, high: 0.05, low: 0.02, close: 0.025 }]);
    expect(inv[0]).toEqual({ time: 1, open: 25, high: 50, low: 20, close: 40 });
  });

  it("wants BTC while BTC rallies against XMR and goes back to XMR when it crashes", () => {
    const up = analyze(xmrBtcPath(UP_CLOSES), cfg(), nowAfter(UP_CLOSES.length));
    expect(up.last?.regime).toBe("orange");
    expect(up.desiredBtc).toBe(true);
    expect(up.signals.map((s) => s.action)).toEqual(["enter"]);

    const down = analyze(xmrBtcPath(DOWN_CLOSES), cfg(), nowAfter(DOWN_CLOSES.length));
    expect(down.desiredBtc).toBe(false);
    expect(down.signals.map((s) => s.action)).toEqual(["enter", "exit"]);
  });

  it("measures each trade in XMR (exit/entry on the inverted price)", () => {
    const a = analyze(xmrBtcPath(DOWN_CLOSES), cfg(), nowAfter(DOWN_CLOSES.length));
    const bars = a.bars;
    const enter = a.signals[0]!;
    const exit = a.signals[1]!;
    const ei = bars.findIndex((b) => b.time === enter.signalBarTime);
    const xi = bars.findIndex((b) => b.time === exit.signalBarTime);
    expect(enter.signalPrice).toBeCloseTo(bars[ei + 1]!.open, 12);
    expect(exit.signalPrice).toBeCloseTo(bars[xi + 1]!.open, 12);
  });

  it("does not signal on the still-forming bar", () => {
    const bars = computeLarsson(invertCandles(xmrBtcPath(UP_CLOSES)), nowAfter(UP_CLOSES.length - 1));
    expect(bars[bars.length - 1]!.confirmed).toBe(false);
    expect(bars[bars.length - 2]!.confirmed).toBe(true);
  });

  it("strategy entry cap blocks a flat->BTC entry while too extended, and never cuts an exit", () => {
    const a0 = analyze(xmrBtcPath(UP_CLOSES), cfg(), nowAfter(UP_CLOSES.length));
    expect(a0.last!.dist).toBeGreaterThan(0.001);
    // Absurdly tight cap: never allowed to enter during this steady rally.
    const tight = analyze(xmrBtcPath(UP_CLOSES), cfg({ strategyCap: { enabled: true, maxDistPct: 0.0001 } }), nowAfter(UP_CLOSES.length));
    expect(tight.desiredBtc).toBe(false);
    expect(tight.desiredBtcUncapped).toBe(true);
    expect(tight.signals).toHaveLength(0);
    // Generous cap behaves like no cap.
    const loose = analyze(xmrBtcPath(UP_CLOSES), cfg({ strategyCap: { enabled: true, maxDistPct: 99 } }), nowAfter(UP_CLOSES.length));
    expect(loose.desiredBtc).toBe(true);
    // A cap that is off is ignored even with a tight number.
    const off = analyze(xmrBtcPath(UP_CLOSES), cfg({ strategyCap: { enabled: false, maxDistPct: 0.0001 } }), nowAfter(UP_CLOSES.length));
    expect(off.desiredBtc).toBe(true);
  });

  it("entry re-checks the cap each orange bar (can enter later)", () => {
    const bars = computeLarsson(invertCandles(xmrBtcPath(UP_CLOSES)), nowAfter(UP_CLOSES.length));
    const dists = bars.filter((b) => b.regime === "orange" && b.dist !== null).map((b) => b.dist! * 100);
    const cap = (Math.min(...dists) + Math.max(...dists)) / 2;
    const { signals } = replaySignals(bars, cap);
    if (signals.length) {
      const entryBar = bars.find((b) => b.time === signals[0]!.signalBarTime)!;
      expect(entryBar.dist! * 100).toBeLessThanOrEqual(cap);
    }
  });
});

const baseInput = (over: Partial<PlanInput> = {}, state: Partial<BotState> = {}): PlanInput => ({
  cfg: cfg(),
  state: { ...DEFAULT_STATE, ...state },
  wallets: { xmr: 10, btc: 0, xmrAvail: 10, btcAvail: 0, ustAvail: 0, others: [] },
  price: 0.04,
  usdPerXmr: 4000,
  usdPerBtc: 100_000,
  desiredBtc: true,
  dist: 0.02,
  ...over,
});

describe("planTick", () => {
  it("converts all XMR to BTC when the strategy wants BTC, and all BTC to XMR when it wants XMR", () => {
    expect(planTick(baseInput()).action).toEqual({ kind: "to_btc", xmr: 10 });
    const p = planTick(baseInput({ desiredBtc: false, wallets: { xmr: 0, btc: 0.5, xmrAvail: 0, btcAvail: 0.5, ustAvail: 0 } }));
    expect(p.action).toEqual({ kind: "to_xmr", btc: 0.5 });
  });

  it("ignores dust below minTradeUsd", () => {
    const p = planTick(baseInput({ wallets: { xmr: 0.001, btc: 0, xmrAvail: 0.001, btcAvail: 0, ustAvail: 0 } }));
    expect(p.action.kind).toBe("none");
  });

  it("detects a wallet rise the bot did not cause as a deposit", () => {
    const p = planTick(
      baseInput({ wallets: { xmr: 12, btc: 0.4, xmrAvail: 12, btcAvail: 0.4, ustAvail: 0 } }, { snapshot: { xmr: 10, btc: 0.4, at: 1 } })
    );
    expect(p.deposits).toHaveLength(1);
    expect(p.deposits[0]).toMatchObject({ asset: "XMR", amount: 2 });
    expect(p.heldBackXmr).toBe(0); // cap is off by default: deployed normally
  });

  it("no snapshot means no deposits (first tick just sets the baseline)", () => {
    expect(planTick(baseInput()).deposits).toHaveLength(0);
  });

  it("new-money cap holds back a deposit made while BTC is extended, and does not touch the old position", () => {
    const c = cfg({ newMoneyCap: { enabled: true, maxDistPct: 5, minLumpPct: 0 } });
    const w = { xmr: 3, btc: 1, xmrAvail: 3, btcAvail: 1, ustAvail: 0 };
    const p = planTick(baseInput({ cfg: c, dist: 0.08, wallets: w }, { snapshot: { xmr: 0, btc: 1, at: 1 } }));
    expect(p.deposits[0]!.action).toMatch(/held back/);
    expect(p.heldBackXmr).toBe(3);
    expect(p.action.kind).toBe("none");
  });

  it("new-money cap deploys a deposit made while BTC is within the cap", () => {
    const c = cfg({ newMoneyCap: { enabled: true, maxDistPct: 5, minLumpPct: 0 } });
    const w = { xmr: 3, btc: 1, xmrAvail: 3, btcAvail: 1, ustAvail: 0 };
    const p = planTick(baseInput({ cfg: c, dist: 0.03, wallets: w }, { snapshot: { xmr: 0, btc: 1, at: 1 } }));
    expect(p.heldBackXmr).toBe(0);
    expect(p.action).toEqual({ kind: "to_btc", xmr: 3 });
  });

  it("minLumpPct: small top-ups are deployed even when extended, big lumps are held", () => {
    const c = cfg({ newMoneyCap: { enabled: true, maxDistPct: 5, minLumpPct: 20 } });
    // equity before = 0 XMR + 1 BTC / 0.04 = 25 XMR. 1 XMR deposit = 4% -> deploy. 10 XMR = 40% -> hold.
    const small = planTick(baseInput({ cfg: c, dist: 0.08, wallets: { xmr: 1, btc: 1, xmrAvail: 1, btcAvail: 1, ustAvail: 0 } }, { snapshot: { xmr: 0, btc: 1, at: 1 } }));
    expect(small.heldBackXmr).toBe(0);
    expect(small.action.kind).toBe("to_btc");
    const big = planTick(baseInput({ cfg: c, dist: 0.08, wallets: { xmr: 10, btc: 1, xmrAvail: 10, btcAvail: 1, ustAvail: 0 } }, { snapshot: { xmr: 0, btc: 1, at: 1 } }));
    expect(big.heldBackXmr).toBe(10);
  });

  it("releases held-back money when price returns within the cap, when the strategy exits, or when the cap is switched off", () => {
    const c = cfg({ newMoneyCap: { enabled: true, maxDistPct: 5, minLumpPct: 0 } });
    const w = { xmr: 3, btc: 1, xmrAvail: 3, btcAvail: 1, ustAvail: 0 };
    const held = { heldBackXmr: 3, snapshot: { xmr: 3, btc: 1, at: 1 } };
    expect(planTick(baseInput({ cfg: c, dist: 0.07, wallets: w }, held)).heldBackXmr).toBe(3); // still extended
    const back = planTick(baseInput({ cfg: c, dist: 0.04, wallets: w }, held));
    expect(back.heldBackXmr).toBe(0);
    expect(back.action).toEqual({ kind: "to_btc", xmr: 3 });
    expect(planTick(baseInput({ cfg: c, dist: 0.07, desiredBtc: false, wallets: w }, held)).heldBackXmr).toBe(0);
    expect(planTick(baseInput({ cfg: cfg(), dist: 0.07, wallets: w }, held)).heldBackXmr).toBe(0);
  });

  it("a BTC deposit while the strategy wants XMR is converted to XMR", () => {
    const p = planTick(
      baseInput(
        { desiredBtc: false, wallets: { xmr: 5, btc: 0.2, xmrAvail: 5, btcAvail: 0.2, ustAvail: 0 } },
        { snapshot: { xmr: 5, btc: 0, at: 1 } }
      )
    );
    expect(p.deposits[0]).toMatchObject({ asset: "BTC" });
    expect(p.action).toEqual({ kind: "to_xmr", btc: 0.2 });
  });

  it("position cap limits how much XMR-equivalent may sit in BTC", () => {
    const c = cfg({ positionCapXmr: 8 });
    // already 0.1 BTC = 2.5 XMR in BTC, 10 XMR available: room = 5.5
    const p = planTick(baseInput({ cfg: c, wallets: { xmr: 10, btc: 0.1, xmrAvail: 10, btcAvail: 0.1, ustAvail: 0 } }));
    expect(p.action.kind).toBe("to_btc");
    expect((p.action as { xmr: number }).xmr).toBeCloseTo(5.5, 9);
  });

  it("sweeps stranded USDT into the asset the strategy wants before anything else", () => {
    const p = planTick(baseInput({ wallets: { xmr: 10, btc: 0, xmrAvail: 10, btcAvail: 0, ustAvail: 500 } }, { strandedUst: 400 }));
    expect(p.action).toEqual({ kind: "sweep", into: "btc", ust: 400 });
    const q = planTick(baseInput({ desiredBtc: false, wallets: { xmr: 0, btc: 0, xmrAvail: 0, btcAvail: 0, ustAvail: 500 } }, { strandedUst: 400 }));
    expect(q.action).toEqual({ kind: "sweep", into: "xmr", ust: 400 });
  });

  it("sweeps idle USDT in the wallet even when nothing is tracked as stranded", () => {
    const p = planTick(baseInput({ cfg: cfg({ minTradeUsd: 1 }), wallets: { xmr: 0, btc: 0.4, xmrAvail: 0, btcAvail: 0.4, ustAvail: 21.29 } }));
    expect(p.action.kind).toBe("sweep");
    expect((p.action as { ust: number }).ust).toBeCloseTo(21.29, 6);
    const dust = planTick(baseInput({ cfg: cfg({ minTradeUsd: 1 }), wallets: { xmr: 0, btc: 0.4, xmrAvail: 0, btcAvail: 0.4, ustAvail: 1.9 } }));
    expect(dust.action.kind).toBe("none");
  });

  it("does not sweep idle USDT into BTC beyond the position cap", () => {
    const c = cfg({ positionCapXmr: 5, minTradeUsd: 1 });
    const p = planTick(baseInput({ cfg: c, wallets: { xmr: 0, btc: 0.4, xmrAvail: 0, btcAvail: 0.4, ustAvail: 500 } }));
    expect(p.action.kind).toBe("none");
  });

  it("XMR reserve: stays out of the strategy conversion", () => {
    const p = planTick(baseInput({ cfg: cfg({ xmrReserve: 3 }) }));
    expect(p.action).toEqual({ kind: "to_btc", xmr: 7 }); // 10 XMR held, 3 kept back as the pot
  });

  it("XMR reserve: built from BTC when the wallet is short", () => {
    const p = planTick(baseInput({ cfg: cfg({ xmrReserve: 3 }), wallets: { xmr: 1, btc: 0.4, xmrAvail: 1, btcAvail: 0.4, ustAvail: 0 } }));
    expect(p.action.kind).toBe("reserve_xmr");
    expect((p.action as { btc: number }).btc).toBeCloseTo(0.08, 9); // 2 XMR missing x 0.04 BTC
  });

  it("XMR reserve: idle USDT is spent on the pot before any BTC is sold", () => {
    const p = planTick(baseInput({ cfg: cfg({ xmrReserve: 1, minTradeUsd: 1 }), wallets: { xmr: 0.9965, btc: 0.4, xmrAvail: 0.9965, btcAvail: 0.4, ustAvail: 12.36 } }));
    expect(p.action).toMatchObject({ kind: "sweep", into: "xmr", idle: true });
    expect((p.action as { ust: number }).ust).toBeCloseTo(12.36, 6); // all idle USDT (less than the $14 gap)
  });

  it("USDT reserve: carved out of the XMR reserve by selling XMR, never the strategy position", () => {
    const c = cfg({ xmrReserve: 3, usdtReserve: 4000 });
    const p = planTick(baseInput({ cfg: c, wallets: { xmr: 3, btc: 0.4, xmrAvail: 3, btcAvail: 0.4, ustAvail: 0 } }));
    expect(p.action).toEqual({ kind: "raise_usdt", usd: 4000, base: 3 });
    // pot in place (2 XMR + 4000 USDT = 3 XMR): nothing to do and the 2 XMR are not converted
    const q = planTick(baseInput({ cfg: c, wallets: { xmr: 2, btc: 0.4, xmrAvail: 2, btcAvail: 0.4, ustAvail: 4000 } }));
    expect(q.action.kind).toBe("none");
    // pot empty: build XMR from BTC first, do not sell BTC for USDT
    const r = planTick(baseInput({ cfg: c, wallets: { xmr: 0, btc: 0.4, xmrAvail: 0, btcAvail: 0.4, ustAvail: 0 } }));
    expect(r.action.kind).toBe("reserve_xmr");
  });

  it("USDT reserve: capped at the value of the XMR reserve", () => {
    const c = cfg({ xmrReserve: 1, usdtReserve: 99_999 });
    const p = planTick(baseInput({ cfg: c, wallets: { xmr: 1, btc: 0.4, xmrAvail: 1, btcAvail: 0.4, ustAvail: 0 } }));
    expect((p.action as { usd: number }).usd).toBeCloseTo(4000, 6);
  });

  it("USDT reserve does nothing while the XMR reserve is 0: USDT in the wallet is idle and swept", () => {
    const w = { xmr: 0, btc: 0.4, xmrAvail: 0, btcAvail: 0.4, ustAvail: 1000 };
    const p = planTick(baseInput({ cfg: cfg({ xmrReserve: 0, usdtReserve: 1000 }), wallets: w }));
    expect(p.action).toMatchObject({ kind: "sweep", into: "btc", idle: true });
  });

  it("converts any other balance (USD, other coins) into USDT before anything else", () => {
    const w = { xmr: 0, btc: 0.4, xmrAvail: 0, btcAvail: 0.4, ustAvail: 0, others: [] };
    const p = planTick(baseInput({ cfg: cfg({ minTradeUsd: 1 }), wallets: w, others: [{ currency: "USD", available: 4.9, usd: 4.9 }] }));
    expect(p.action).toEqual({ kind: "convert_other", currency: "USD", amount: 4.9, usd: 4.9 });
    // below the $2 floor nothing is done
    const q = planTick(baseInput({ cfg: cfg({ minTradeUsd: 1 }), wallets: w, others: [{ currency: "USD", available: 1.03, usd: 1.03 }] }));
    expect(q.action.kind).toBe("none");
  });

  it("an idle sweep that cannot buy anything is parked until the balance changes", () => {
    const w = { xmr: 0, btc: 0.4, xmrAvail: 0, btcAvail: 0.4, ustAvail: 2.5, others: [] };
    const c = cfg({ minTradeUsd: 1 });
    expect(planTick(baseInput({ cfg: c, wallets: w })).action.kind).toBe("sweep");
    expect(planTick(baseInput({ cfg: c, wallets: w }, { ignoredOthers: ["USDT:2.50"] })).action.kind).toBe("none");
    expect(planTick(baseInput({ cfg: c, wallets: { ...w, ustAvail: 3.1 } }, { ignoredOthers: ["USDT:2.50"] })).action.kind).toBe("sweep");
  });

  it("clears stranded USDT that is no longer in the wallet", () => {
    const p = planTick(baseInput({ wallets: { xmr: 10, btc: 0, xmrAvail: 10, btcAvail: 0, ustAvail: 0 } }, { strandedUst: 400 }));
    expect(p.clearStranded).toBe(true);
    expect(p.action.kind).toBe("to_btc");
  });
});

describe("rotate (executor)", () => {
  it("sells XMR for USDT then buys BTC with the proceeds, chunk by chunk, one order at a time", async () => {
    const ex = new FakeExchange({ closes: UP_CLOSES, xmr: 2 });
    const r = await rotate({ ex, direction: "xmr_to_btc", amount: 2, chunkUsd: 3000, pollMs: 0, log: () => {} });
    expect(r.interrupted).toBeNull();
    expect(r.sold).toBeCloseTo(2, 6);
    expect(ex.wallets["XMR"]).toBeCloseTo(0, 6);
    expect(ex.wallets["BTC"]).toBeGreaterThan(0.07); // ~ 2*4000/100000 = 0.08 minus the fee allowance
    expect(ex.orders.filter((o) => o.symbol === "tXMRUST").length).toBe(3); // 3000 USD chunks over 8000 USD
    expect(r.strandedUst).toBe(0);
    // every sell is paired with a buy
    expect(ex.orders.map((o) => (o.amount < 0 ? "S" : "B")).join("")).toMatch(/^(SB)+$/);
  });

  it("reports stranded USDT when the buy leg cannot complete", async () => {
    const ex = new FakeExchange({ closes: UP_CLOSES, btc: 0.1 });
    const real = ex.getMinOrderSize.bind(ex);
    ex.getMinOrderSize = async (s: string) => (s === "tXMRUST" ? 1000 : real());
    const r = await rotate({ ex, direction: "btc_to_xmr", amount: 0.1, chunkUsd: 10_000, pollMs: 0, log: () => {} });
    expect(r.sold).toBeCloseTo(0.1, 6);
    expect(r.bought).toBe(0);
    expect(r.strandedUst).toBeGreaterThan(9000);
    expect(r.interrupted).toMatch(/USDT left/);
  });
});

describe("runTick", () => {
  const NOW = nowAfter(UP_CLOSES.length);

  it("disabled: records state and deposits but trades nothing", async () => {
    const store = newStore();
    store.setConfig({ ...DEFAULT_CONFIG });
    const ex = new FakeExchange({ closes: UP_CLOSES, xmr: 10 });
    const r = await runTick({ ex, store, now: NOW, pollMs: 0 });
    expect(r.action).toBe("disabled");
    expect(ex.orders).toHaveLength(0);
    expect(store.getState().snapshot?.xmr).toBe(10);
  });

  it("DRY_RUN: logs what it would do once, never submits an order", async () => {
    const store = newStore();
    store.setConfig(cfg({ mode: "DRY_RUN" }));
    const ex = new FakeExchange({ closes: UP_CLOSES, xmr: 10, mode: "DRY_RUN" });
    const r1 = await runTick({ ex, store, now: NOW, pollMs: 0 });
    expect(r1.action).toBe("would_to_btc");
    await runTick({ ex, store, now: NOW + 60_000, pollMs: 0 });
    expect(ex.orders).toHaveLength(0);
    expect(store.events().filter((e) => e.kind === "would")).toHaveLength(1); // deduped
  });

  it("LIVE in config but DRY_RUN exchange still never trades (second safety)", async () => {
    const store = newStore();
    store.setConfig(cfg({ mode: "LIVE" }));
    const ex = new FakeExchange({ closes: UP_CLOSES, xmr: 10, mode: "DRY_RUN" });
    const r = await runTick({ ex, store, now: NOW, pollMs: 0 });
    expect(r.action).toBe("would_to_btc");
    expect(ex.orders).toHaveLength(0);
  });

  it("LIVE: rotates XMR to BTC, logs fills, and does not read its own trades as a deposit next tick", async () => {
    const store = newStore();
    store.setConfig(cfg({ chunkUsd: 5000 }));
    const ex = new FakeExchange({ closes: UP_CLOSES, xmr: 4 });
    const r = await runTick({ ex, store, now: NOW, pollMs: 0 });
    expect(r.action).toBe("rotated");
    expect(ex.wallets["XMR"]).toBeCloseTo(0, 6);
    expect(ex.wallets["BTC"]).toBeGreaterThan(0.15);
    expect(store.fills().length).toBeGreaterThan(1);
    const r2 = await runTick({ ex, store, now: NOW + 60_000, pollMs: 0 });
    expect(r2.action).toBe("idle");
    expect(store.deposits()).toHaveLength(0);
  });

  it("LIVE: XMR reserve is built from BTC, USDT is carved out of it, and everything releases at 0", async () => {
    const store = newStore();
    store.setConfig(cfg({ chunkUsd: 5000, minTradeUsd: 100, xmrReserve: 2 }));
    const ex = new FakeExchange({ closes: UP_CLOSES, btc: 0.1 }); // ~ $10,000 of BTC, strategy wants BTC
    const r1 = await runTick({ ex, store, now: NOW, pollMs: 0 });
    expect(r1.action).toBe("reserved");
    expect(ex.wallets["XMR"]).toBeGreaterThan(1.9);
    expect(ex.wallets["BTC"]).toBeCloseTo(0.02, 2);
    expect(store.fills().every((f) => f.rotationId.startsWith("xres:"))).toBe(true);
    expect((await runTick({ ex, store, now: NOW + 60_000, pollMs: 0 })).action).toBe("idle"); // reserve stays XMR, not converted to BTC
    expect(store.deposits()).toHaveLength(0);

    // carve 4,000 USDT out of the XMR pot
    store.setConfig(cfg({ chunkUsd: 5000, minTradeUsd: 100, xmrReserve: 2, usdtReserve: 4000 }));
    const r3 = await runTick({ ex, store, now: NOW + 120_000, pollMs: 0 });
    expect(r3.action).toBe("raised");
    expect(Math.abs(ex.wallets["UST"]! - 4000)).toBeLessThan(1);
    expect(ex.wallets["BTC"]).toBeCloseTo(0.02, 2); // strategy position untouched
    expect(buildExecutions(store.allFills()).map((e) => e.kind).sort()).toEqual(["reserve_xmr", "to_usdt"]);
    expect((await runTick({ ex, store, now: NOW + 180_000, pollMs: 0 })).action).toBe("idle");
    expect(store.snapshots().at(-1)!.equityXmr).toBeCloseTo(0.02 / 0.04 + 1.0 + 4000 / 4000, 0);

    // release: XMR reserve off -> the USDT is idle and goes into BTC; the XMR follows the strategy
    store.setConfig(cfg({ chunkUsd: 5000, minTradeUsd: 100, xmrReserve: 0, usdtReserve: 4000 }));
    const r5 = await runTick({ ex, store, now: NOW + 240_000, pollMs: 0 });
    expect(r5.action).toBe("swept");
    expect(ex.wallets["UST"]).toBeLessThan(60);
  });

  it("LIVE: USD and other coins are converted to USDT, then swept into the strategy asset", async () => {
    const store = newStore();
    store.setConfig(cfg({ chunkUsd: 5000, minTradeUsd: 1 }));
    const ex = new FakeExchange({ closes: UP_CLOSES, btc: 0.1, usd: 4.9, prices: { ETH: 3000 } });
    ex.wallets["ETH"] = 0.01; // ~$30 of an unrelated coin
    const r1 = await runTick({ ex, store, now: NOW, pollMs: 0 });
    expect(r1.action).toBe("converted");
    const r2 = await runTick({ ex, store, now: NOW + 60_000, pollMs: 0 });
    expect(r2.action).toBe("converted");
    expect(ex.wallets["USD"]!).toBeLessThan(0.1);
    expect(ex.wallets["ETH"]!).toBeLessThan(0.0001);
    expect(ex.wallets["UST"]!).toBeGreaterThan(30);
    expect(store.fills().every((f) => f.rotationId.startsWith("usdt:"))).toBe(true);
    expect(buildExecutions(store.allFills()).some((e) => e.kind === "convert_ust")).toBe(true);
    const r3 = await runTick({ ex, store, now: NOW + 120_000, pollMs: 0 });
    expect(r3.action).toBe("swept"); // the USDT goes into BTC (strategy asset)
    expect(ex.wallets["BTC"]!).toBeGreaterThan(0.1);
    expect(store.deposits()).toHaveLength(0);
  });

  it("LIVE: a USD balance below the pair minimum is left alone and not retried every tick", async () => {
    const store = newStore();
    store.setConfig(cfg({ chunkUsd: 5000, minTradeUsd: 1 }));
    const ex = new FakeExchange({ closes: UP_CLOSES, btc: 0.1, usd: 1.5 });
    const r1 = await runTick({ ex, store, now: NOW, pollMs: 0 });
    expect(r1.action).toBe("idle"); // under the $2 floor: never attempted
    expect(ex.orders).toHaveLength(0);
  });

  it("LIVE: stranded USDT too small for the pair minimum does not block the rotation", async () => {
    const store = newStore();
    store.setConfig(cfg({ chunkUsd: 5000, minTradeUsd: 1 }));
    store.setState({ ...DEFAULT_STATE, strandedUst: 8.11 });
    // strategy wants XMR (crash); XMR minimum order is 0.01 (= $40) so 8.11 USDT cannot buy any
    const ex = new FakeExchange({ closes: DOWN_CLOSES, btc: 0.1, ust: 8.11, mins: { "tXMRUST": 0.01 } });
    const NOW2 = nowAfter(DOWN_CLOSES.length);
    const r1 = await runTick({ ex, store, now: NOW2, pollMs: 0 });
    expect(r1.action).toBe("swept"); // tried, bought nothing
    expect(ex.orders).toHaveLength(0);
    const r2 = await runTick({ ex, store, now: NOW2 + 60_000, pollMs: 0 });
    expect(r2.action).toBe("rotated"); // no longer stuck: BTC goes into XMR
    expect(ex.wallets["BTC"]!).toBeLessThan(0.01);
    expect(ex.wallets["XMR"]!).toBeGreaterThan(2);
  });

  it("PAUSED mid-rotation: the order in flight finishes, then no further orders are placed", async () => {
    const store = newStore();
    store.setConfig(cfg({ chunkUsd: 1000 }));
    const ex = new FakeExchange({ closes: UP_CLOSES, xmr: 10 }); // $40,000 to convert = many chunks
    const orig = ex.submitOrder.bind(ex);
    let n = 0;
    ex.submitOrder = async (o) => {
      const r = await orig(o);
      if (++n === 2) store.setConfig(cfg({ chunkUsd: 1000, enabled: false })); // user clicks PAUSED after chunk 1 (sell + buy)
      return r;
    };
    const r = await runTick({ ex, store, now: NOW, pollMs: 0 });
    expect(ex.orders).toHaveLength(2); // one full sell+buy pair, nothing more
    expect(r.detail).toMatch(/paused/);
    expect(ex.wallets["XMR"]!).toBeGreaterThan(9); // the rest was not converted
    expect(store.getState().strandedUst).toBe(0);
  });

  it("LIVE: new XMR deposited later is detected, logged, and converted (cap off)", async () => {
    const store = newStore();
    store.setConfig(cfg({ chunkUsd: 5000 }));
    const ex = new FakeExchange({ closes: UP_CLOSES, xmr: 4 });
    await runTick({ ex, store, now: NOW, pollMs: 0 });
    ex.wallets["XMR"] = 2; // user deposits 2 XMR
    const r = await runTick({ ex, store, now: NOW + 60_000, pollMs: 0 });
    expect(store.deposits()).toHaveLength(1);
    expect(store.deposits()[0]).toMatchObject({ asset: "XMR" });
    expect(store.deposits()[0]!.amount).toBeCloseTo(2, 9);
    expect(r.action).toBe("rotated");
    expect(ex.wallets["XMR"]).toBeCloseTo(0, 6);
  });

  it("LIVE: new-money cap holds a mid-uptrend deposit in XMR and the old position stays BTC", async () => {
    const store = newStore();
    store.setConfig(cfg({ chunkUsd: 5000, newMoneyCap: { enabled: true, maxDistPct: 0.0001, minLumpPct: 0 } }));
    const ex = new FakeExchange({ closes: UP_CLOSES, xmr: 4 });
    await runTick({ ex, store, now: NOW, pollMs: 0 }); // first deployment of the original money
    ex.wallets["XMR"] = 2;
    const r = await runTick({ ex, store, now: NOW + 60_000, pollMs: 0 });
    expect(r.action).toBe("idle");
    expect(ex.wallets["XMR"]).toBe(2);
    expect(store.getState().heldBackXmr).toBe(2);
    const dep = store.deposits()[0]!;
    expect(dep.action).toMatch(/held back/);
  });

  it("LIVE: exits to XMR when the strategy flips, and BTC deposits are converted too", async () => {
    const store = newStore();
    store.setConfig(cfg({ chunkUsd: 20_000 }));
    const NOW2 = nowAfter(DOWN_CLOSES.length);
    const ex = new FakeExchange({ closes: DOWN_CLOSES, btc: 0.5 });
    const r = await runTick({ ex, store, now: NOW2, pollMs: 0 });
    expect(r.action).toBe("rotated");
    expect(ex.wallets["BTC"]).toBeCloseTo(0, 6);
    expect(ex.wallets["XMR"]).toBeGreaterThan(11);
  });

  it("refuses to act on stale candles", async () => {
    const store = newStore();
    store.setConfig(cfg());
    const ex = new FakeExchange({ closes: UP_CLOSES, xmr: 1 });
    const r = await runTick({ ex, store, now: nowAfter(UP_CLOSES.length + 10), pollMs: 0 });
    expect(r.action).toBe("blocked");
    expect(r.detail).toMatch(/stale/);
    expect(ex.orders).toHaveLength(0);
  });

  it("blocked without enough candles", async () => {
    const store = newStore();
    store.setConfig(cfg());
    const ex = new FakeExchange({ closes: UP_CLOSES.slice(0, 20), xmr: 1 });
    expect((await runTick({ ex, store, now: nowAfter(20), pollMs: 0 })).action).toBe("blocked");
  });
});

describe("config and account return", () => {
  it("defaults are safe: disabled, DRY_RUN, both caps off", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_CONFIG.mode).toBe("DRY_RUN");
    expect(DEFAULT_CONFIG.strategyCap.enabled).toBe(false);
    expect(DEFAULT_CONFIG.newMoneyCap.enabled).toBe(false);
    expect(DEFAULT_CONFIG.positionCapXmr).toBe(0);
  });

  it("validates config input", () => {
    expect("config" in parseConfig(DEFAULT_CONFIG)).toBe(true);
    expect("error" in parseConfig({ ...DEFAULT_CONFIG, mode: "PAPER" })).toBe(true);
    expect("error" in parseConfig({ ...DEFAULT_CONFIG, chunkUsd: 1 })).toBe(true);
    expect("error" in parseConfig({ ...DEFAULT_CONFIG, strategyCap: { enabled: true, maxDistPct: 0 } })).toBe(true);
    expect("error" in parseConfig({ ...DEFAULT_CONFIG, newMoneyCap: { enabled: true, maxDistPct: 5, minLumpPct: -1 } })).toBe(true);
  });

  it("stored config fills in new fields from defaults", () => {
    const store = newStore();
    expect(store.getConfig()).toEqual(DEFAULT_CONFIG);
    store.setConfig(cfg({ chunkUsd: 250 }));
    expect(store.getConfig().chunkUsd).toBe(250);
  });

  it("account XMR return ignores deposits (time-weighted)", () => {
    const snaps = [
      { ts: 1, xmr: 10, btc: 0, price: 0.04, equityXmr: 10 },
      { ts: 2, xmr: 10, btc: 0, price: 0.04, equityXmr: 20 }, // +10 XMR deposited, no performance
      { ts: 3, xmr: 10, btc: 0, price: 0.04, equityXmr: 22 }, // +10% on 20
    ];
    const deps = [{ id: 1, ts: 2, asset: "XMR", amount: 10, valueXmr: 10, dist: null, action: "x" }];
    expect(twrXmrPct(snaps, deps)).toBeCloseTo(10, 9);
    expect(twrXmrPct(snaps.slice(0, 1), deps)).toBeNull();
  });
});

describe("timeline: executions and signal vs actual trades", () => {
  const f = (id: number, ts: number, rotationId: string, symbol: string, side: "buy" | "sell", base: number, price: number) => ({ id, ts, rotationId, symbol, side, base, price });
  const DAYMS = 86_400_000;
  const t0 = 1_700_000_000_000;
  // Entry: sell 2 XMR at $4,000, buy 0.08 BTC at $100,000 -> 25 XMR per BTC. Exit: sell 0.08 BTC at $100,000, buy 2.2 XMR at $3,636.36 -> 27.5 XMR per BTC.
  const fills = [
    f(1, t0 + 1000, "A", "tXMRUST", "sell", 2, 4000),
    f(2, t0 + 2000, "A", "tBTCUST", "buy", 0.08, 100000),
    f(3, t0 + 10 * DAYMS + 1000, "B", "tBTCUST", "sell", 0.08, 100000),
    f(4, t0 + 10 * DAYMS + 2000, "B", "tXMRUST", "buy", 2.2, 8000 / 2.2),
  ];

  it("groups fills into one execution per rotation with the implied XMR-per-BTC price", () => {
    const ex = buildExecutions(fills);
    expect(ex.map((e) => e.kind)).toEqual(["to_xmr", "to_btc"]); // newest first
    const entry = ex[1]!;
    expect(entry.sold).toBe(2);
    expect(entry.bought).toBe(0.08);
    expect(entry.ratio).toBeCloseTo(25, 9);
  });

  it("measures a closed trade from the real fills, next to the signal prices", () => {
    const signalTrade = {
      entryTime: Math.floor(t0 / 1000),
      entrySignal: 24,
      exitTime: Math.floor((t0 + 10 * DAYMS) / 1000),
      exitSignal: 27,
      status: "closed" as const,
      xmrReturnPct: 12.5,
    };
    const [row] = attachActual([signalTrade], fills, 28);
    expect(row!.actual!.entryPrice).toBeCloseTo(25, 9);
    expect(row!.actual!.exitPrice).toBeCloseTo(27.5, 9);
    expect(row!.actual!.sizeBtc).toBeCloseTo(0.08, 12);
    expect(row!.actual!.pnlXmr).toBeCloseTo(0.08 * 2.5, 9);
    expect(row!.actual!.returnPct).toBeCloseTo(10, 9);
    expect(row!.signalPnlXmr).toBeCloseTo(0.08 * 3, 9);
  });

  it("marks an open trade to the current price, and leaves unexecuted history as signal-only", () => {
    const open = { entryTime: Math.floor(t0 / 1000), entrySignal: 24, exitTime: null, exitSignal: null, status: "open" as const, xmrReturnPct: 16.7 };
    const old = { entryTime: Math.floor(t0 / 1000) - 400 * 86_400, entrySignal: 20, exitTime: Math.floor(t0 / 1000) - 390 * 86_400, exitSignal: 21, status: "closed" as const, xmrReturnPct: 5 };
    const rows = attachActual([old, open], fills.slice(0, 2), 30);
    expect(rows[0]!.status).toBe("open");
    expect(rows[0]!.actual!.returnPct).toBeCloseTo(20, 9); // 30 / 25 - 1
    expect(rows[0]!.actual!.pnlXmr).toBeCloseTo(0.08 * 5, 9);
    expect(rows[1]!.actual).toBeNull();
  });
});
