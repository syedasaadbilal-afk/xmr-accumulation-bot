import type { RunMode } from "./bitfinex.js";

/**
 * All settings live here. Safe by default: disabled, DRY_RUN, both caps off.
 *
 * Two kinds of cap, deliberately separate:
 *
 *  - strategyCap: part of the strategy itself. A flat->BTC entry is skipped while
 *    BTC is more than maxDistPct above the Larsson baseline (chasing protection).
 *    It never touches an open BTC position or exits.
 *
 *  - newMoneyCap: about money ADDED to the account (XMR deposited while the
 *    strategy is already holding BTC). If BTC is more than maxDistPct above the
 *    baseline the new XMR is held back instead of being swapped to BTC in the
 *    middle of an extended move. It is released when price comes back within
 *    the cap, or when the strategy exits to XMR. minLumpPct limits the cap to
 *    big deposits (a deposit smaller than that % of the managed equity is
 *    deployed normally), so small regular top-ups are not delayed. 0 = every deposit.
 */
export interface BotConfig {
  enabled: boolean;
  mode: RunMode;
  /** USD size of each limit order (one open at a time). */
  chunkUsd: number;
  /** Rotations / deposits below this USD value are ignored as dust. */
  minTradeUsd: number;
  /** Max XMR-equivalent allowed to sit in BTC at once. 0 = no limit. */
  positionCapXmr: number;
  /** XMR pot kept out of the strategy. Built from BTC when short. 0 = off. */
  xmrReserve: number;
  /**
   * USDT to park, carved out of the XMR reserve only (the strategy position is never sold for it).
   * Has no effect while xmrReserve is 0. Capped at the value of the XMR reserve.
   */
  usdtReserve: number;
  strategyCap: { enabled: boolean; maxDistPct: number };
  newMoneyCap: { enabled: boolean; maxDistPct: number; minLumpPct: number };
}

export const DEFAULT_CONFIG: BotConfig = {
  enabled: false,
  mode: "DRY_RUN",
  chunkUsd: 2000,
  minTradeUsd: 25,
  positionCapXmr: 0,
  xmrReserve: 0,
  usdtReserve: 0,
  strategyCap: { enabled: false, maxDistPct: 5 },
  newMoneyCap: { enabled: false, maxDistPct: 5, minLumpPct: 0 },
};

export interface BotState {
  /** Wallet balances at the end of the previous tick; the next tick's difference is "not caused by us". */
  snapshot: { xmr: number; btc: number; at: number } | null;
  /** XMR deposited mid-uptrend that the new-money cap is holding back from conversion. */
  heldBackXmr: number;
  /** USDT proceeds of a half-finished rotation, to be spent first on the next tick. */
  strandedUst: number;
  lastResult: { action: string; detail: string; at: number } | null;
  lastTickAt: number | null;
  /** Dedupes repeated dry-run "would convert" events. */
  lastWouldKey: string | null;
  /** Other-currency balances the bot could not convert ("CUR:amount"); retried when the balance changes. */
  ignoredOthers: string[];
}

export const DEFAULT_STATE: BotState = {
  snapshot: null,
  heldBackXmr: 0,
  strandedUst: 0,
  lastResult: null,
  lastTickAt: null,
  lastWouldKey: null,
  ignoredOthers: [],
};

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Validates a config coming from the API. Returns the clean config or an error message. */
export function parseConfig(b: unknown): { config: BotConfig } | { error: string } {
  const x = b as Partial<BotConfig> | undefined;
  if (!x || typeof x !== "object") return { error: "body must be a config object" };
  if (typeof x.enabled !== "boolean") return { error: "enabled must be true or false" };
  if (x.mode !== "DRY_RUN" && x.mode !== "LIVE") return { error: "mode must be DRY_RUN or LIVE" };
  if (!isNum(x.chunkUsd) || x.chunkUsd < 10 || x.chunkUsd > 1_000_000) return { error: "chunkUsd must be between 10 and 1,000,000" };
  if (!isNum(x.minTradeUsd) || x.minTradeUsd < 1 || x.minTradeUsd > 100_000) return { error: "minTradeUsd must be between 1 and 100,000" };
  if (!isNum(x.positionCapXmr) || x.positionCapXmr < 0) return { error: "positionCapXmr must be 0 (no limit) or more" };
  const reserve = x.usdtReserve === undefined ? 0 : x.usdtReserve;
  if (!isNum(reserve) || reserve < 0 || reserve > 100_000_000) return { error: "usdtReserve must be 0 (off) or more" };
  const xres = x.xmrReserve === undefined ? 0 : x.xmrReserve;
  if (!isNum(xres) || xres < 0 || xres > 1_000_000) return { error: "xmrReserve must be 0 (off) or more" };
  const s = x.strategyCap;
  if (!s || typeof s.enabled !== "boolean" || !isNum(s.maxDistPct) || s.maxDistPct <= 0 || s.maxDistPct > 100) {
    return { error: "strategyCap needs enabled and maxDistPct in (0, 100]" };
  }
  const n = x.newMoneyCap;
  if (!n || typeof n.enabled !== "boolean" || !isNum(n.maxDistPct) || n.maxDistPct <= 0 || n.maxDistPct > 100 || !isNum(n.minLumpPct) || n.minLumpPct < 0 || n.minLumpPct > 1000) {
    return { error: "newMoneyCap needs enabled, maxDistPct in (0, 100] and minLumpPct >= 0" };
  }
  return {
    config: {
      enabled: x.enabled,
      mode: x.mode,
      chunkUsd: x.chunkUsd,
      minTradeUsd: x.minTradeUsd,
      positionCapXmr: x.positionCapXmr,
      xmrReserve: xres,
      usdtReserve: reserve,
      strategyCap: { enabled: s.enabled, maxDistPct: s.maxDistPct },
      newMoneyCap: { enabled: n.enabled, maxDistPct: n.maxDistPct, minLumpPct: n.minLumpPct },
    },
  };
}
