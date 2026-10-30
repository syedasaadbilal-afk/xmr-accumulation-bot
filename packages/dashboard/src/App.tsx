import { useEffect, useState } from "react";
import { fetchStatus, runNow, setMode, type StatusDto } from "./api.js";
import type { DisplayUnit } from "./format.js";
import { ConfigTab } from "./components/ConfigTab.js";
import type { UiMode } from "./components/RunModeToggle.js";
import { StatusTab } from "./components/StatusTab.js";
import { TimelineTab } from "./components/TimelineTab.js";
import { TopNav, type TabKey } from "./components/TopNav.js";

export default function App() {
  const [tab, setTab] = useState<TabKey>("status");
  const [unit, setUnit] = useState<DisplayUnit>("xmr");
  const [status, setStatus] = useState<StatusDto | undefined>(undefined);
  const [runningNow, setRunningNow] = useState(false);

  async function reload() {
    const s = await fetchStatus();
    if (s) setStatus(s);
  }

  useEffect(() => {
    void reload();
    const interval = setInterval(() => void reload(), 30_000);
    return () => clearInterval(interval);
  }, []);

  async function handleModeChange(mode: UiMode) {
    if (mode === "LIVE" && !window.confirm("Switch to LIVE? This places REAL orders on Bitfinex whenever the strategy and your wallets call for it.")) return;
    await setMode(mode);
    await reload();
  }

  async function handleRunNow() {
    setRunningNow(true);
    await runNow();
    setTimeout(() => {
      void reload();
      setRunningNow(false);
    }, 3000);
  }

  return (
    <div className="min-h-screen bg-ink-950 text-slate-100">
      <TopNav active={tab} onChange={setTab} unit={unit} onUnitChange={setUnit} />
      {tab === "status" && <StatusTab status={status} unit={unit} runningNow={runningNow} onRunNow={handleRunNow} onModeChange={handleModeChange} />}
      {tab === "timeline" && <TimelineTab status={status} />}
      {tab === "config" && <ConfigTab status={status} reload={reload} />}
    </div>
  );
}
