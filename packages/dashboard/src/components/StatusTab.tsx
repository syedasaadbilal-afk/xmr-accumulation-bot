import type { StatusDto } from "../api.js";
import { btnCls, cagrPct, card, floor2, formatAmount, formatCountdown, fmtPct, num, pctCls, type DisplayUnit } from "../format.js";
import { LarssonChart } from "./LarssonChart.js";
import { LineChart } from "./LineChart.js";
import { MetricTile } from "./MetricTile.js";
import { RunModeToggle, type UiMode } from "./RunModeToggle.js";

function uiMode(s: StatusDto): UiMode {
  return !s.config.enabled ? "PAUSED" : s.config.mode;
}

function headline(s: StatusDto): string {
  if (s.desired === null) return "Waiting for market data.";
  const where = s.holding && s.holding !== "EMPTY" ? `Holding ${s.holding}.` : "Wallets are empty.";
  if (s.desired === "BTC") return `BTC is trending up against Monero (regime ${s.regime}). Strategy wants BTC. ${where}`;
  if (s.caps.strategy.blockingNow) return `Regime is orange but the entry cap is blocking the move into BTC. Strategy wants XMR. ${where}`;
  return `BTC is not trending up against Monero (regime ${s.regime}). Strategy wants XMR. ${where}`;
}

export function StatusTab({
  status,
  unit,
  runningNow,
  onRunNow,
  onModeChange,
}: {
  status: StatusDto | undefined;
  unit: DisplayUnit;
  runningNow: boolean;
  onRunNow: () => void;
  onModeChange: (m: UiMode) => void;
}) {
  if (!status) return <div className="text-slate-500 p-6">Loading...</div>;
  const s = status;
  const px = s.price;
  const mode = uiMode(s);
  const lr = s.state.lastResult;
  const toUnit = (xmr: number) => (unit === "btc" ? xmr * (px ?? 0) : xmr);
  const eqSeries = s.snapshots.map((p) => ({ x: p.ts, y: unit === "btc" ? p.equityXmr * p.price : p.equityXmr }));
  const nextAt = s.state.lastTickAt ? s.state.lastTickAt + s.tickMs : null;
  const w = s.wallets;

  return (
    <div className="space-y-6 p-6">
      {s.error && <div className="bg-red-950/40 border border-red-900 rounded p-3 text-sm text-red-300">{s.error}</div>}
      {!s.configured && <div className="bg-amber-950/30 border border-amber-900 rounded p-3 text-sm text-amber-200">No Bitfinex API key yet. Add one in the Config tab so the bot can read your wallets.</div>}
      {s.warmup && <div className="bg-amber-950/30 border border-amber-900 rounded p-3 text-sm text-amber-200">Only {s.barsCount} daily bars of history; the lines are most reliable after about 90.</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-emerald-950/40 border border-emerald-900 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap justify-between gap-6">
            <div>
              <div className="text-[11px] tracking-wider text-slate-500 uppercase mb-1">Account value</div>
              <div className="text-4xl font-bold text-slate-100">{s.equityXmr === null ? "-" : formatAmount(s.equityXmr, px, unit)}</div>
              <div className={`text-sm mt-1 ${pctCls(s.summary.accountXmrReturnPct)}`}>
                {s.summary.accountXmrReturnPct === null ? "XMR gain: building history" : `${fmtPct(s.summary.accountXmrReturnPct)} in XMR since start (deposits removed)`}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] tracking-wider text-slate-500 uppercase mb-1">BTC above baseline</div>
              <div className="text-4xl font-bold text-slate-100">{s.dist === null ? "-" : fmtPct(s.dist * 100)}</div>
              <div className="text-xs text-slate-500 mt-1">1 XMR = {px ? px.toFixed(6) : "-"} BTC</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-8">
            <div>
              <div className="text-[11px] tracking-wider text-slate-500 uppercase mb-1">XMR held</div>
              <div className="text-lg font-semibold text-slate-300">{w ? formatAmount(w.xmr, px, unit) : "-"}</div>
            </div>
            <div>
              <div className="text-[11px] tracking-wider text-slate-500 uppercase mb-1">BTC held (in {unit === "btc" ? "BTC" : "XMR"})</div>
              <div className="text-lg font-semibold text-slate-300">{w && px ? formatAmount(w.btc / px, px, unit) : "-"}</div>
            </div>
          </div>
          <RunModeToggle current={mode} onChange={onModeChange} />
        </div>

        <div className="bg-ink-900 border border-slate-800 rounded-lg p-5 flex flex-col justify-between gap-4">
          <div>
            <p className="text-slate-200 text-sm">{headline(s)}</p>
            {lr && (
              <p className="text-slate-400 text-xs mt-2">
                last result: {lr.action} - {lr.detail}
              </p>
            )}
            <button onClick={onRunNow} disabled={runningNow} className={`mt-3 ${btnCls}`}>
              {runningNow ? "Running..." : "Run decision now"}
            </button>
          </div>
          <div className="flex justify-between text-xs text-slate-500 font-mono">
            <span>last tick: {s.state.lastTickAt ? new Date(s.state.lastTickAt).toLocaleString() : "never"}</span>
            <span>next in {nextAt ? formatCountdown(nextAt - Date.now()) : "-"}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricTile label="USDT held (live)" value={w ? floor2(w.ustAvail) : "-"} sublabel={s.state.strandedUst > 0 ? `${floor2(s.state.strandedUst)} waiting to be swept` : undefined} />
        <MetricTile label="BTC held (live)" value={w ? w.btc.toFixed(8) : "-"} />
        <MetricTile label="XMR held (live)" value={w ? w.xmr.toFixed(6) : "-"} />
        <MetricTile label="XMR held back" value={num(s.caps.newMoney.heldBackXmr, 6)} sublabel="by the new-money cap" valueColor={s.caps.newMoney.heldBackXmr > 0 ? "text-amber-400" : "text-slate-100"} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricTile label="Strategy wants" value={s.desired ?? "-"} valueColor={s.desired === "BTC" ? "text-amber-400" : "text-yellow-200"} sublabel={s.caps.strategy.blockingNow ? "entry cap blocking" : (s.regime ?? "no regime yet")} />
        <MetricTile label="Position now" value={s.holding ?? "-"} sublabel={s.holding && s.desired && s.holding !== "MIXED" && s.holding !== "EMPTY" ? (s.holding === s.desired ? "on target" : "rotating") : undefined} />
        <MetricTile label="Strategy entry cap" value={s.caps.strategy.enabled ? `${s.caps.strategy.maxDistPct}%` : "off"} sublabel={s.caps.strategy.enabled ? (s.caps.strategy.blockingNow ? "blocking now" : "not blocking") : undefined} valueColor={s.caps.strategy.blockingNow ? "text-amber-400" : "text-slate-100"} />
        <MetricTile
          label="New-money cap"
          value={s.caps.newMoney.enabled ? `${s.caps.newMoney.maxDistPct}%` : "off"}
          sublabel={s.caps.newMoney.enabled ? (s.caps.newMoney.wouldHoldBackNow ? "a deposit would be held" : "a deposit would deploy") : undefined}
          valueColor={s.caps.newMoney.wouldHoldBackNow ? "text-amber-400" : "text-slate-100"}
        />
        <MetricTile
          label="Reserves"
          value={s.config.xmrReserve > 0 ? `${s.config.xmrReserve} XMR` : "off"}
          sublabel={s.config.xmrReserve > 0 ? (s.config.usdtReserve > 0 ? `of which ${s.config.usdtReserve} USDT parked (${w ? floor2(w.ustAvail) : "-"} now)` : "no USDT carve-out") : undefined}
        />
        <MetricTile label="Position cap" value={s.config.positionCapXmr > 0 ? `${s.config.positionCapXmr} XMR` : "off"} />
        <MetricTile label="Strategy XMR gain" value={fmtPct(s.summary.signalXmrReturnPct)} valueColor={pctCls(s.summary.signalXmrReturnPct)} sublabel={`chart signals, cumulative · CAGR ${fmtPct(cagrPct(s.summary.signalXmrReturnPct, s.trades[s.trades.length - 1]?.entryTime ?? null))}`} />
      </div>

      <LarssonChart bars={s.bars} signals={s.signals} />

      <LineChart
        title="Account value"
        series={[{ label: unit === "btc" ? "BTC value" : "XMR value", color: "#f2c94c", points: eqSeries }]}
        valueFormatter={(v) => (unit === "btc" ? v.toFixed(6) : v.toFixed(4))}
        compactHeight={140}
        expandedHeight={260}
      />
      {eqSeries.length > 0 && <div className={`${card} hidden`} />}
      <p className="text-xs text-slate-600">Values are shown in {unit === "btc" ? "BTC" : "XMR"} ({toUnit(1).toFixed(unit === "btc" ? 6 : 0)} per XMR). The bot's goal is more XMR.</p>
    </div>
  );
}
