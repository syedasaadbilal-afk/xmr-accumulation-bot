import type { DatabaseSyncLike } from "./db/types.js";
import { BitfinexExchange, type Exchange } from "./bitfinex.js";
import { analyze, parkedUst, runTick, tradesFor, walletView, type TickResult } from "./engine.js";
import { BTC_UST, XMR_BTC, XMR_UST } from "./execute.js";
import { hasSecrets, readSecrets } from "./secrets.js";
import { Store, type DepositRow, type SnapshotRow } from "./store.js";
import { attachActual, buildExecutions } from "./timeline.js";
import { CANDLE_LIMIT } from "./engine.js";

/**
 * Time-weighted XMR return of the whole account: equity is measured in XMR, and
 * deposits / withdrawals between two snapshots are taken out so adding money
 * does not look like performance. Returns percent, or null with < 2 snapshots.
 */
export function twrXmrPct(snaps: SnapshotRow[], deposits: DepositRow[]): number | null {
  if (snaps.length < 2) return null;
  let mult = 1;
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1]!;
    const cur = snaps[i]!;
    if (prev.equityXmr <= 0) continue;
    const flows = deposits.filter((d) => d.ts > prev.ts && d.ts <= cur.ts).reduce((s, d) => s + d.valueXmr, 0);
    mult *= (cur.equityXmr - flows) / prev.equityXmr;
  }
  return (mult - 1) * 100;
}

export class XmrService {
  readonly store: Store;
  private running = false;
  private view: { at: number; data: unknown } | null = null;

  constructor(
    private readonly dbPath: string,
    db: DatabaseSyncLike,
    /** Injected in tests. */
    private readonly makeExchange?: (apiKey: string, apiSecret: string, mode: "DRY_RUN" | "LIVE") => Exchange
  ) {
    this.store = new Store(db);
  }

  private exchange(authenticated: boolean): Exchange {
    const cfg = this.store.getConfig();
    const s = authenticated ? readSecrets(this.dbPath) : { apiKey: "", apiSecret: "" };
    // The exchange object itself refuses to place orders unless the config says LIVE.
    const mode = authenticated ? cfg.mode : "DRY_RUN";
    return this.makeExchange ? this.makeExchange(s.apiKey, s.apiSecret, mode) : new BitfinexExchange({ apiKey: s.apiKey, apiSecret: s.apiSecret, runMode: mode });
  }

  async tick(): Promise<TickResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      if (!hasSecrets(this.dbPath)) {
        const r: TickResult = { action: "blocked", detail: "Bitfinex API key not set yet" };
        const st = this.store.getState();
        this.store.setState({ ...st, lastResult: { ...r, at: Date.now() }, lastTickAt: Date.now() });
        return r;
      }
      return await runTick({ ex: this.exchange(true), store: this.store });
    } finally {
      this.running = false;
      this.view = null;
    }
  }

  async status() {
    const cfg = this.store.getConfig();
    const state = this.store.getState();
    const configured = hasSecrets(this.dbPath);
    let error: string | null = null;
    let analysis: ReturnType<typeof analyze> | null = null;
    let price: number | null = null;
    let usdPerXmr: number | null = null;
    let usdPerBtc: number | null = null;
    let wallets: ReturnType<typeof walletView> | null = null;
    let walletRows: Array<{ type: string; currency: string; balance: number; availableBalance: number }> | null = null;
    try {
      const pub = this.exchange(false);
      const [candles, t1, t2, t3] = await Promise.all([pub.getDailyCandles(XMR_BTC, CANDLE_LIMIT), pub.getTicker(XMR_BTC), pub.getTicker(XMR_UST), pub.getTicker(BTC_UST)]);
      analysis = analyze(candles, cfg, Date.now());
      price = t1.last;
      usdPerXmr = t2.last;
      usdPerBtc = t3.last;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (configured) {
      try {
        const ex = this.exchange(true);
        wallets = walletView(await ex.getWallets());
        if (ex.getAllWallets) walletRows = (await ex.getAllWallets()).filter((w) => Math.abs(w.balance) > 0);
      } catch (err) {
        error = error ?? `wallets: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const allFills = this.store.allFills();
    const trades = analysis ? attachActual(tradesFor(analysis), allFills, price ? 1 / price : null) : [];
    const actualClosed = trades.filter((t) => t.status === "closed" && t.actual?.pnlXmr != null);
    const compound = (xs: Array<number | null>) => (xs.reduce<number>((m, x) => (x === null ? m : m * (1 + x / 100)), 1) - 1) * 100;
    const snaps = this.store.snapshots(2000);
    const deposits = this.store.deposits(500);
    const last = analysis?.last ?? null;
    const dist = last?.dist ?? null;
    const holding =
      wallets && price
        ? (() => {
            const btcX = wallets.btc / price;
            const total = wallets.xmr + btcX;
            if (total <= 0) return wallets.ustAvail > 1 ? "USDT" : "EMPTY";
            return btcX / total > 0.9 ? "BTC" : wallets.xmr / total > 0.9 ? "XMR" : "MIXED";
          })()
        : null;

    return {
      configured,
      config: cfg,
      state: { heldBackXmr: state.heldBackXmr, strandedUst: state.strandedUst, lastResult: state.lastResult, lastTickAt: state.lastTickAt },
      error,
      price,
      usdPerXmr,
      usdPerBtc,
      wallets,
      walletRows,
      equityXmr: wallets && price && usdPerXmr ? wallets.xmr + wallets.btc / price + parkedUst(wallets, cfg, state.strandedUst, usdPerXmr) / usdPerXmr : null,
      holding,
      desired: analysis ? (analysis.desiredBtc ? "BTC" : "XMR") : null,
      desiredUncapped: analysis ? (analysis.desiredBtcUncapped ? "BTC" : "XMR") : null,
      regime: last?.regime ?? null,
      dist,
      warmup: analysis?.warmup ?? false,
      barsCount: analysis?.bars.length ?? 0,
      caps: {
        strategy: {
          enabled: cfg.strategyCap.enabled,
          maxDistPct: cfg.strategyCap.maxDistPct,
          blockingNow: !!analysis && cfg.strategyCap.enabled && analysis.desiredBtcUncapped !== analysis.desiredBtc,
        },
        newMoney: {
          enabled: cfg.newMoneyCap.enabled,
          maxDistPct: cfg.newMoneyCap.maxDistPct,
          minLumpPct: cfg.newMoneyCap.minLumpPct,
          wouldHoldBackNow: cfg.newMoneyCap.enabled && dist !== null && dist * 100 > cfg.newMoneyCap.maxDistPct,
          heldBackXmr: state.heldBackXmr,
        },
      },
      bars: analysis ? analysis.bars.slice(-180) : [],
      signals: analysis ? analysis.signals.filter((s) => s.signalBarTime >= (analysis!.bars[Math.max(0, analysis!.bars.length - 180)]?.time ?? 0)) : [],
      trades,
      executions: buildExecutions(allFills).slice(0, 60),
      summary: {
        trades: trades.length,
        closed: trades.filter((t) => t.status === "closed").length,
        wins: trades.filter((t) => t.status === "closed" && (t.xmrReturnPct ?? 0) > 0).length,
        signalXmrReturnPct: trades.length ? compound(trades.map((t) => t.xmrReturnPct)) : 0,
        accountXmrReturnPct: twrXmrPct(snaps, deposits),
        actualClosed: actualClosed.length,
        actualWins: actualClosed.filter((t) => (t.actual?.pnlXmr ?? 0) > 0).length,
        actualNetPnlXmr: trades.reduce((s, t) => s + (t.actual?.pnlXmr ?? 0), 0),
      },
      tickMs: Number(process.env.XMR_TICK_MS ?? 60_000),
      snapshots: snaps.filter((_, i) => i % Math.max(1, Math.ceil(snaps.length / 400)) === 0 || i === snaps.length - 1),
      events: this.store.events(80),
      fills: this.store.fills(40),
      deposits: deposits.slice(0, 30),
    };
  }
}
