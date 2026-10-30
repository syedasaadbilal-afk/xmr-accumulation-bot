import { useState } from "react";
import type { BarDto, SignalDto } from "../api.js";
import { REGIME_COLOR, card, fmtDate, h3 } from "../format.js";

function Chart({ bars, signals }: { bars: BarDto[]; signals: SignalDto[] }) {
  const W = 960;
  const H = 340;
  const padL = 8;
  const padR = 64;
  const padT = 12;
  const padB = 24;
  if (bars.length < 2) return <div className="text-sm text-slate-500">Not enough candles yet.</div>;
  const vals: number[] = [];
  for (const b of bars) {
    vals.push(b.high, b.low);
    if (b.v1 !== null) vals.push(b.v1);
    if (b.v2 !== null) vals.push(b.v2);
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.01)] ?? sorted[0]!;
  const hi = sorted[Math.ceil(sorted.length * 0.99) - 1] ?? sorted[sorted.length - 1]!;
  const span = Math.max(hi - lo, 1e-12);
  const min = lo - span * 0.05;
  const max = hi + span * 0.05;
  const x = (i: number) => padL + (i / (bars.length - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (Math.min(Math.max(v, min), max) - min) / (max - min)) * (H - padT - padB);
  const cw = Math.max(1.5, ((W - padL - padR) / bars.length) * 0.6);
  const idxByTime = new Map(bars.map((b, i) => [b.time, i]));

  const bands: Array<{ regime: keyof typeof REGIME_COLOR; from: number; to: number }> = [];
  bars.forEach((b, i) => {
    if (!b.regime || b.v1 === null || b.v2 === null) return;
    const last = bands[bands.length - 1];
    if (last && last.regime === b.regime && last.to === i - 1) last.to = i;
    else bands.push({ regime: b.regime, from: i, to: i });
  });
  const line = (key: "v1" | "v2", from: number, to: number) =>
    bars
      .slice(from, to + 1)
      .map((b, k) => `${k === 0 ? "M" : "L"}${x(from + k).toFixed(1)},${y(b[key] as number).toFixed(1)}`)
      .join(" ");
  const poly = (from: number, to: number) => {
    const top = bars.slice(from, to + 1).map((b, k) => `${x(from + k).toFixed(1)},${y(b.v1 as number).toFixed(1)}`);
    const bot = bars
      .slice(from, to + 1)
      .map((b, k) => `${x(from + k).toFixed(1)},${y(b.v2 as number).toFixed(1)}`)
      .reverse();
    return [...top, ...bot].join(" ");
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + (max - min) * f);
  const labelEvery = Math.ceil(bars.length / 8);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="BTC priced in XMR, daily candles with Larsson lines">
      {ticks.map((t, k) => (
        <g key={k}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#1e293b" strokeWidth={1} />
          <text x={W - padR + 6} y={y(t) + 4} fontSize={10} fill="#64748b" fontFamily="monospace">
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      {bands.map((b, k) => (
        <polygon key={k} points={poly(b.from, b.to)} fill={REGIME_COLOR[b.regime]} fillOpacity={0.2} />
      ))}
      {bars.map((b, i) => {
        const up = b.close >= b.open;
        const c = up ? "#34d399" : "#f87171";
        return (
          <g key={b.time} opacity={b.confirmed ? 1 : 0.5}>
            <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={c} strokeWidth={1} />
            <rect x={x(i) - cw / 2} y={Math.min(y(b.open), y(b.close))} width={cw} height={Math.max(1, Math.abs(y(b.open) - y(b.close)))} fill={c} />
          </g>
        );
      })}
      {bands.map((b, k) => (
        <g key={`l${k}`}>
          <path d={line("v1", b.from, b.to)} fill="none" stroke={REGIME_COLOR[b.regime]} strokeWidth={1.6} />
          <path d={line("v2", b.from, b.to)} fill="none" stroke={REGIME_COLOR[b.regime]} strokeWidth={2.4} />
        </g>
      ))}
      {signals.map((s) => {
        const i = idxByTime.get(s.signalBarTime);
        if (i === undefined) return null;
        const enter = s.action === "enter";
        const cy = enter ? y(bars[i]!.low) + 14 : y(bars[i]!.high) - 14;
        return (
          <polygon
            key={`${s.signalBarTime}${s.action}`}
            points={enter ? `${x(i)},${cy - 7} ${x(i) - 6},${cy + 4} ${x(i) + 6},${cy + 4}` : `${x(i)},${cy + 7} ${x(i) - 6},${cy - 4} ${x(i) + 6},${cy - 4}`}
            fill={enter ? "#34d399" : "#f87171"}
          />
        );
      })}
      {bars.map((b, i) =>
        i % labelEvery === 0 ? (
          <text key={`t${b.time}`} x={x(i)} y={H - 6} fontSize={10} fill="#64748b" textAnchor="middle" fontFamily="monospace">
            {fmtDate(b.time).slice(5)}
          </text>
        ) : null
      )}
    </svg>
  );
}


/** Card around the inverted-ratio chart, with the same EXPAND toggle as the other charts. */
export function LarssonChart({ bars, signals }: { bars: BarDto[]; signals: SignalDto[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? bars : bars.slice(-90);
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <h3 className={`${h3} mb-0`}>BTC priced in XMR · Larsson lines</h3>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-[10px] px-2 py-0.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500"
          >
            {expanded ? "COLLAPSE" : "EXPAND"}
          </button>
        </div>
        <span className="text-xs text-slate-400">{expanded ? "180 days" : "90 days"}</span>
      </div>
      <Chart bars={shown} signals={signals} />
      <p className="text-xs text-slate-500 mt-2">
        The XMR/BTC chart upside down. Orange = hold BTC, navy/gray = hold XMR. Green up arrow = enter BTC, red down arrow = back to XMR.
      </p>
    </div>
  );
}
