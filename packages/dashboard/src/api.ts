export type BotMode = "DRY_RUN" | "LIVE";

export interface BotConfigDto {
  enabled: boolean;
  mode: BotMode;
  chunkUsd: number;
  minTradeUsd: number;
  positionCapXmr: number;
  strategyCap: { enabled: boolean; maxDistPct: number };
  newMoneyCap: { enabled: boolean; maxDistPct: number; minLumpPct: number };
}

export interface BarDto {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  v1: number | null;
  v2: number | null;
  regime: "orange" | "navy" | "gray" | null;
  confirmed: boolean;
}

export interface SignalDto {
  signalBarTime: number;
  action: "enter" | "exit";
  signalPrice: number | null;
  execTime: number;
}

export interface TradeDto {
  entryTime: number;
  entrySignal: number | null;
  exitTime: number | null;
  exitSignal: number | null;
  status: "open" | "closed";
  xmrReturnPct: number | null;
  actual: { entryPrice: number | null; exitPrice: number | null; sizeBtc: number; pnlXmr: number | null; returnPct: number | null } | null;
  signalPnlXmr: number | null;
}

export interface ExecutionDto {
  rotationId: string;
  ts: number;
  kind: "to_btc" | "to_xmr" | "sweep_btc" | "sweep_xmr";
  soldAsset: "XMR" | "BTC" | null;
  sold: number;
  boughtAsset: "XMR" | "BTC";
  bought: number;
  xmrUsd: number | null;
  btcUsd: number | null;
  orders: number;
  ratio: number | null;
}

export interface StatusDto {
  configured: boolean;
  config: BotConfigDto;
  state: { heldBackXmr: number; strandedUst: number; lastResult: { action: string; detail: string; at: number } | null; lastTickAt: number | null };
  error: string | null;
  price: number | null;
  usdPerXmr: number | null;
  usdPerBtc: number | null;
  wallets: { xmr: number; btc: number; xmrAvail: number; btcAvail: number; ustAvail: number } | null;
  walletRows: Array<{ type: string; currency: string; balance: number; availableBalance: number }> | null;
  equityXmr: number | null;
  holding: "BTC" | "XMR" | "MIXED" | "EMPTY" | null;
  desired: "BTC" | "XMR" | null;
  desiredUncapped: "BTC" | "XMR" | null;
  regime: "orange" | "navy" | "gray" | null;
  dist: number | null;
  warmup: boolean;
  barsCount: number;
  caps: {
    strategy: { enabled: boolean; maxDistPct: number; blockingNow: boolean };
    newMoney: { enabled: boolean; maxDistPct: number; minLumpPct: number; wouldHoldBackNow: boolean; heldBackXmr: number };
  };
  bars: BarDto[];
  signals: SignalDto[];
  trades: TradeDto[];
  executions: ExecutionDto[];
  summary: { trades: number; closed: number; wins: number; signalXmrReturnPct: number; accountXmrReturnPct: number | null; actualClosed: number; actualWins: number; actualNetPnlXmr: number };
  tickMs: number;
  snapshots: Array<{ ts: number; xmr: number; btc: number; price: number; equityXmr: number }>;
  events: Array<{ id: number; ts: number; kind: string; summary: string; detail: string | null }>;
  fills: Array<{ id: number; ts: number; rotationId: string; symbol: string; side: "buy" | "sell"; base: number; price: number }>;
  deposits: Array<{ id: number; ts: number; asset: string; amount: number; valueXmr: number; dist: number | null; action: string }>;
}

export async function fetchStatus(): Promise<StatusDto | undefined> {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return undefined;
    return (await res.json()) as StatusDto;
  } catch {
    return undefined;
  }
}

async function send(method: "PUT" | "POST", url: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: json.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const saveConfig = (c: BotConfigDto) => send("PUT", "/api/config", c);
export const saveSecrets = (apiKey: string, apiSecret: string) => send("PUT", "/api/secrets", { apiKey, apiSecret });
export const runNow = () => send("POST", "/api/run-now");
export const clearHeldBack = () => send("POST", "/api/clear-held-back");

export const setMode = (mode: "DRY_RUN" | "LIVE" | "PAUSED") => send("PUT", "/api/mode", { mode });
