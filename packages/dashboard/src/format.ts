export type DisplayUnit = "xmr" | "btc";

export const inputCls = "bg-ink-950 border border-slate-800 rounded px-2 py-1.5 text-sm text-slate-200 w-28";
export const btnCls = "px-3 py-1.5 rounded text-sm font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50 border border-slate-700";
export const card = "bg-ink-900 border border-slate-800 rounded-lg p-4";
export const h3 = "text-xs font-semibold tracking-wider text-slate-300 uppercase mb-3";

export const REGIME_COLOR = { orange: "#f59e0b", navy: "#3b82f6", gray: "#94a3b8" } as const;

export const fmtDate = (s: number | null) => (s === null ? "-" : new Date(s * 1000).toISOString().slice(0, 10));
export const fmtTs = (ms: number | null) => (ms === null ? "-" : new Date(ms).toISOString().replace("T", " ").slice(0, 16));
export const fmtPct = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
export const pctCls = (n: number | null | undefined) => (n === null || n === undefined ? "text-slate-500" : n >= 0 ? "text-emerald-400" : "text-red-400");
export const num = (n: number | null | undefined, d = 4) => (n === null || n === undefined ? "-" : n.toFixed(d));

/** An XMR amount shown in the chosen unit (BTC value uses the current XMR/BTC price). */
export function formatAmount(xmr: number, priceBtcPerXmr: number | null, unit: DisplayUnit, opts?: { signed?: boolean }): string {
  const sign = opts?.signed ? (xmr >= 0 ? "+" : "") : "";
  if (unit === "btc") return priceBtcPerXmr ? `${sign}${(xmr * priceBtcPerXmr).toFixed(6)} BTC` : "-";
  return `${sign}${xmr.toFixed(4)} XMR`;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "any moment";
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
