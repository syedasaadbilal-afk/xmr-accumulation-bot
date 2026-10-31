import { useState } from "react";
import { saveConfig, saveSecrets, type BotConfigDto, type StatusDto } from "../api.js";
import { btnCls, card, h3, inputCls } from "../format.js";

function NumField({ label, value, onChange, suffix, disabled }: { label: string; value: string; onChange: (v: string) => void; suffix?: string; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      {label}
      <input className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      {suffix && <span className="text-slate-500">{suffix}</span>}
    </label>
  );
}

function Settings({ s, reload }: { s: StatusDto; reload: () => Promise<void> }) {
  const c = s.config;
  const [chunk, setChunk] = useState(String(c.chunkUsd));
  const [minTrade, setMinTrade] = useState(String(c.minTradeUsd));
  const [posCap, setPosCap] = useState(String(c.positionCapXmr));
  const [reserve, setReserve] = useState(String(c.usdtReserve ?? 0));
  const [xres, setXres] = useState(String(c.xmrReserve ?? 0));
  const [sEn, setSEn] = useState(c.strategyCap.enabled);
  const [sPct, setSPct] = useState(String(c.strategyCap.maxDistPct));
  const [nEn, setNEn] = useState(c.newMoneyCap.enabled);
  const [nPct, setNPct] = useState(String(c.newMoneyCap.maxDistPct));
  const [nLump, setNLump] = useState(String(c.newMoneyCap.minLumpPct));
  const [note, setNote] = useState<string | undefined>(undefined);

  async function save() {
    const next: BotConfigDto = {
      enabled: c.enabled,
      mode: c.mode,
      chunkUsd: Number(chunk),
      minTradeUsd: Number(minTrade),
      positionCapXmr: Number(posCap),
      xmrReserve: Number(xres),
      usdtReserve: Number(reserve),
      strategyCap: { enabled: sEn, maxDistPct: Number(sPct) },
      newMoneyCap: { enabled: nEn, maxDistPct: Number(nPct), minLumpPct: Number(nLump) },
    };
    const r = await saveConfig(next);
    setNote(r.ok ? "Saved." : (r.error ?? "Save failed"));
    if (r.ok) await reload();
  }

  return (
    <div className={card}>
      <h3 className={h3}>Settings (run mode is set on the Status tab)</h3>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-4">
          <NumField label="Order size" value={chunk} onChange={setChunk} suffix="USD per order (one order open at a time)" />
          <NumField label="Ignore below" value={minTrade} onChange={setMinTrade} suffix="USD" />
          <NumField label="Position cap" value={posCap} onChange={setPosCap} suffix="XMR in BTC at once (0 = none)" />
        </div>

        <div className="border border-slate-800 rounded p-3 space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-400">Reserves (kept out of the strategy)</div>
          <div className="flex flex-wrap items-center gap-4">
            <NumField label="XMR reserve" value={xres} onChange={setXres} suffix="XMR (0 = off)" />
            <NumField label="of which parked as USDT" value={reserve} onChange={setReserve} suffix="USDT (0 = none)" />
          </div>
          <p className="text-xs text-slate-500">
            The XMR reserve is a pot of XMR the strategy never converts to BTC. If the wallet holds less than this (counting the USDT carved from it), the bot buys XMR with BTC, in order-size chunks, one order at a time, until it is in place. The USDT amount is taken out of that pot by selling XMR; it never sells the strategy position and has no effect while the XMR reserve is 0. Any other USDT in the wallet is treated as idle and swept into whatever the strategy wants. Parked USDT still counts in account value.
          </p>
        </div>

        <div className="border border-slate-800 rounded p-3 space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-400">Strategy entry cap (part of the strategy)</div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={sEn} onChange={(e) => setSEn(e.target.checked)} />
              Use it
            </label>
            <NumField label="Skip entries when BTC is more than" value={sPct} onChange={setSPct} suffix="% above the baseline" />
          </div>
          <p className="text-xs text-slate-500">
            Applies to the strategy's own flat-to-BTC entry only. An open BTC position and exits are never affected. The entry is re-checked every day, so it can still happen later once price comes back within the cap.
          </p>
        </div>

        <div className="border border-slate-800 rounded p-3 space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-400">New-money cap (money you add)</div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={nEn} onChange={(e) => setNEn(e.target.checked)} />
              Use it
            </label>
            <NumField label="Hold new XMR back when BTC is more than" value={nPct} onChange={setNPct} suffix="% above the baseline" />
            <NumField label="Only for deposits of at least" value={nLump} onChange={setNLump} suffix="% of the account (0 = all)" />
          </div>
          <p className="text-xs text-slate-500">
            Applies only to XMR you deposit while the strategy is already holding BTC. Held-back XMR is converted when price returns within the cap, or stays XMR when the strategy exits. The money already working is not touched.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button className={btnCls} onClick={() => void save()}>
            Save settings
          </button>
          {note && <span className="text-slate-400">{note}</span>}
        </div>
      </div>
    </div>
  );
}

function Credentials({ configured, reload }: { configured: boolean; reload: () => Promise<void> }) {
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState<string | undefined>(undefined);
  async function save() {
    const r = await saveSecrets(key, secret);
    setNote(r.ok ? "Saved." : (r.error ?? "Save failed"));
    if (r.ok) {
      setKey("");
      setSecret("");
      await reload();
    }
  }
  return (
    <div className={card}>
      <h3 className={h3}>Bitfinex API key {configured ? "(saved)" : "(not set)"}</h3>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input className={`${inputCls} w-64`} placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        <input className={`${inputCls} w-64`} type="password" placeholder="API secret" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
        <button className={btnCls} onClick={() => void save()} disabled={!key || !secret}>
          Save key
        </button>
        {note && <span className="text-slate-400">{note}</span>}
      </div>
      <p className="text-xs text-slate-500 mt-2">
        Use a dedicated Bitfinex sub-account holding only the XMR/BTC you want this bot to manage. Permissions: read wallets and orders, create and cancel orders. No withdrawals. Anything the bot did not trade (including trades you make by hand) is read as a deposit or withdrawal.
      </p>
    </div>
  );
}


export function ConfigTab({ status, reload }: { status: StatusDto | undefined; reload: () => Promise<void> }) {
  if (!status) return <div className="text-slate-500 p-6">Loading...</div>;
  return (
    <div className="space-y-6 p-6">
      <Settings key={JSON.stringify(status.config)} s={status} reload={reload} />
      <Credentials configured={status.configured} reload={reload} />
      <div className={card}>
        <h3 className={h3}>Wallets the API key can see</h3>
        {!status.configured ? (
          <div className="text-sm text-slate-500">Add an API key first.</div>
        ) : !status.walletRows || status.walletRows.length === 0 ? (
          <div className="text-sm text-slate-500">
            The key works but every wallet is empty. If your BTC or XMR is in another Bitfinex account, or in a Margin or Funding wallet, move it to this account's Exchange wallet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-slate-500 text-left">
                <th className="pb-1 font-medium">Wallet</th>
                <th className="pb-1 font-medium">Currency</th>
                <th className="pb-1 font-medium text-right">Balance</th>
                <th className="pb-1 font-medium text-right">Available</th>
                <th className="pb-1 font-medium text-right">Used by bot</th>
              </tr>
            </thead>
            <tbody>
              {status.walletRows.map((w, i) => (
                <tr key={i} className="border-t border-slate-800">
                  <td className="py-1.5">{w.type}</td>
                  <td className="py-1.5 font-mono">{w.currency}</td>
                  <td className="py-1.5 font-mono text-right">{w.balance}</td>
                  <td className="py-1.5 font-mono text-right">{w.availableBalance}</td>
                  <td className="py-1.5 text-right text-xs">{w.type === "exchange" && ["BTC", "XMR", "UST"].includes(w.currency) ? <span className="text-emerald-400">yes</span> : <span className="text-slate-500">no</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-slate-500 mt-2">The bot only uses BTC, XMR and UST (USDT) in the Exchange wallet.</p>
      </div>
    </div>
  );
}
