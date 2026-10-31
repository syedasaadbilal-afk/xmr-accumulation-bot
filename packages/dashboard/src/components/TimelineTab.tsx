import type { ExecutionDto, StatusDto, TradeDto } from "../api.js";
import { cagrPct, card, fmtDate, fmtPct, fmtTs, h3, num, pctCls } from "../format.js";

const KIND: Record<ExecutionDto["kind"], string> = {
  to_btc: "Entry (XMR → BTC)",
  to_xmr: "Exit (BTC → XMR)",
  to_usdt: "Park (XMR reserve → USDT)",
  reserve_xmr: "XMR reserve (BTC → XMR)",
  convert_ust: "Convert (other balance → USDT)",
  sweep_btc: "Sweep (USDT → BTC)",
  sweep_xmr: "Sweep (USDT → XMR)",
};

function amt(asset: string | null, v: number): string {
  return asset === null ? "-" : `${v.toFixed(asset === "BTC" ? 6 : asset === "USDT" ? 2 : 4)} ${asset}`;
}

function Executions({ rows }: { rows: ExecutionDto[] }) {
  if (rows.length === 0) return <div className="text-sm text-slate-500 py-2">No orders yet. Dry-run plans are in the activity log below.</div>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[11px] uppercase tracking-wider text-slate-500 text-left">
          <th className="pr-3 pb-1 font-medium">Date and time</th>
          <th className="pr-3 pb-1 font-medium">Type</th>
          <th className="pr-3 pb-1 font-medium text-right">Sold</th>
          <th className="pr-3 pb-1 font-medium text-right">Bought</th>
          <th className="pr-3 pb-1 font-medium">Detail</th>
          <th className="pb-1 font-medium text-right">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.rotationId} className="border-t border-slate-800 align-top">
            <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">{fmtTs(e.ts)}</td>
            <td className="py-2 pr-3">{KIND[e.kind]}</td>
            <td className="py-2 pr-3 font-mono text-right">{amt(e.soldAsset, e.sold)}</td>
            <td className="py-2 pr-3 font-mono text-right">{amt(e.boughtAsset, e.bought)}</td>
            <td className="py-2 pr-3 text-xs text-slate-500">
              {e.orders} order{e.orders === 1 ? "" : "s"}
              {e.ratio !== null ? ` · ${e.ratio.toFixed(3)} XMR per BTC` : ""}
              {e.btcUsd !== null ? ` · BTC $${e.btcUsd.toFixed(0)}` : ""}
              {e.xmrUsd !== null ? ` · XMR $${e.xmrUsd.toFixed(2)}` : ""}
            </td>
            <td className="py-2 text-right">
              <span className="text-[11px] px-2 py-0.5 rounded border border-emerald-800 bg-emerald-950/50 text-emerald-300">executed</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TradeBlock({ t, n }: { t: TradeDto; n: number }) {
  const a = t.actual;
  const sigOnly = a === null;
  const retActual = a?.returnPct ?? null;
  return (
    <tbody>
      <tr className="border-t border-slate-800 align-top">
        <td className="py-2 pr-3 text-slate-500" rowSpan={2}>
          {n}
        </td>
        <td className="py-2 pr-3 text-sky-400" rowSpan={2}>
          long BTC
        </td>
        <td className="py-2 pr-3 text-slate-400">{t.status === "open" ? "Open" : "Exit"} <span className="font-mono text-slate-200">{t.status === "open" ? "now" : fmtDate(t.exitTime)}</span></td>
        <td className="py-2 pr-3 font-mono">
          {a?.exitPrice != null ? a.exitPrice.toFixed(4) : sigOnly ? (t.status === "open" ? "mark" : num(t.exitSignal, 4)) : "-"}
          {!sigOnly && t.status === "closed" && <div className="text-xs text-slate-500">signal {num(t.exitSignal, 4)}</div>}
        </td>
        <td className="py-2 pr-3 font-mono">{a ? `${a.sizeBtc.toFixed(6)} BTC` : "-"}</td>
        <td className={`py-2 pr-3 font-mono ${pctCls(a?.pnlXmr ?? t.xmrReturnPct)}`} rowSpan={2}>
          {a?.pnlXmr != null ? `${a.pnlXmr >= 0 ? "+" : ""}${a.pnlXmr.toFixed(4)} XMR` : "-"}
          <div className="text-xs text-slate-500">{a ? (t.signalPnlXmr != null ? `signal ${t.signalPnlXmr >= 0 ? "+" : ""}${t.signalPnlXmr.toFixed(4)} XMR` : "") : "signal prices only"}</div>
        </td>
        <td className={`py-2 font-mono text-right ${pctCls(retActual ?? t.xmrReturnPct)}`} rowSpan={2}>
          {fmtPct(retActual ?? t.xmrReturnPct)}
          <div className="text-xs text-slate-500">{a ? `signal ${fmtPct(t.xmrReturnPct)}` : "signal prices only"}</div>
        </td>
      </tr>
      <tr>
        <td className="pb-2 pr-3 text-slate-400">Entry <span className="font-mono text-slate-200">{fmtDate(t.entryTime)}</span></td>
        <td className="pb-2 pr-3 font-mono">
          {a?.entryPrice != null ? a.entryPrice.toFixed(4) : num(t.entrySignal, 4)}
          {a && <div className="text-xs text-slate-500">signal {num(t.entrySignal, 4)}</div>}
        </td>
        <td className="pb-2 pr-3 font-mono">{a ? `${a.sizeBtc.toFixed(6)} BTC` : "-"}</td>
      </tr>
    </tbody>
  );
}

/** Timeline tab, same sections as the BTC Yield Autopilot: executions, trades (signal vs actual), then the logs. */
export function TimelineTab({ status }: { status: StatusDto | undefined }) {
  if (!status) return <div className="text-slate-500 p-6">Loading...</div>;
  const s = status;
  const sm = s.summary;
  return (
    <div className="space-y-6 p-6">
      <div className={card}>
        <h3 className={h3}>Executions (entries, exits and sweeps, from real order fills)</h3>
        <div className="overflow-x-auto">
          <Executions rows={s.executions} />
        </div>
      </div>

      <div className={card}>
        <h3 className={h3}>Trades (TradingView style: entry into BTC, exit back to XMR)</h3>
        <div className="flex flex-wrap gap-6 text-sm text-slate-400 mb-3">
          <span>
            Closed trades (executed): <span className="text-slate-100">{sm.actualClosed}</span>
          </span>
          <span>
            Win rate: <span className="text-slate-100">{sm.actualClosed > 0 ? `${Math.round((sm.actualWins / sm.actualClosed) * 100)}%` : "-"}</span>
          </span>
          <span>
            Net PnL: <span className={pctCls(sm.actualNetPnlXmr)}>{sm.actualClosed > 0 || sm.actualNetPnlXmr !== 0 ? `${sm.actualNetPnlXmr >= 0 ? "+" : ""}${sm.actualNetPnlXmr.toFixed(4)} XMR` : "-"}</span>
          </span>
          <span>
            Chart signals: <span className="text-slate-100">{sm.closed} closed, {sm.wins} wins</span>
          </span>
          <span>
            Cumulative: <span className={pctCls(sm.signalXmrReturnPct)}>{fmtPct(sm.signalXmrReturnPct)}</span>
          </span>
          <span>
            CAGR: <span className={pctCls(cagrPct(sm.signalXmrReturnPct, s.trades[s.trades.length - 1]?.entryTime ?? null))}>{fmtPct(cagrPct(sm.signalXmrReturnPct, s.trades[s.trades.length - 1]?.entryTime ?? null))}</span>
            <span className="text-slate-500"> /yr since {fmtDate(s.trades[s.trades.length - 1]?.entryTime ?? null)}</span>
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-slate-500 text-left">
                <th className="pr-3 pb-1 font-medium">Trade #</th>
                <th className="pr-3 pb-1 font-medium">Type</th>
                <th className="pr-3 pb-1 font-medium">Date</th>
                <th className="pr-3 pb-1 font-medium">Price (XMR per BTC)</th>
                <th className="pr-3 pb-1 font-medium">Size</th>
                <th className="pr-3 pb-1 font-medium">Net PnL</th>
                <th className="pb-1 font-medium text-right">Return</th>
              </tr>
            </thead>
            {s.trades.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={7} className="py-3 text-slate-500">
                    No signals in the available history.
                  </td>
                </tr>
              </tbody>
            )}
            {s.trades.map((t, i) => (
              <TradeBlock key={t.entryTime} t={t} n={s.trades.length - i} />
            ))}
          </table>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Price = what the bot actually got (average of the real fills, XMR per BTC); "signal" = the chart's next-open price. Trades the bot did not execute (before it started) show "signal prices only". Bitfinex spot trading fees are zero, so the gap between actual and signal is spread and slippage. Net PnL is in XMR and open trades are marked to the current price.
        </p>
      </div>

      <div className={card}>
        <h3 className={h3}>Deposits and withdrawals seen</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {s.deposits.length === 0 && (
                <tr>
                  <td className="py-2 text-slate-500">None yet. A wallet change the bot did not cause is logged here.</td>
                </tr>
              )}
              {s.deposits.map((d) => (
                <tr key={d.id} className="border-t border-slate-800 align-top">
                  <td className="py-1.5 pr-3 font-mono text-xs text-slate-400 whitespace-nowrap">{fmtTs(d.ts)}</td>
                  <td className={`py-1.5 pr-3 font-mono ${d.amount >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {d.amount >= 0 ? "+" : ""}
                    {num(d.amount, d.asset === "BTC" ? 6 : 4)} {d.asset}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-slate-400">{d.dist === null ? "" : `BTC ${fmtPct(d.dist * 100)} vs baseline`}</td>
                  <td className="py-1.5 text-xs text-slate-300">{d.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={card}>
        <h3 className={h3}>Activity log</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {s.events.map((e) => (
                <tr key={e.id} className="border-t border-slate-800 align-top">
                  <td className="py-1.5 pr-3 font-mono text-xs text-slate-400 whitespace-nowrap">{fmtTs(e.ts)}</td>
                  <td className="py-1.5 pr-3 text-xs text-slate-500">{e.kind}</td>
                  <td className={`py-1.5 text-xs ${e.kind === "error" ? "text-red-300" : "text-slate-300"}`}>{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
