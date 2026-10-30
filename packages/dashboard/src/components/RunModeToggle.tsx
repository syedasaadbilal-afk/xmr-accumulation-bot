export type UiMode = "DRY_RUN" | "LIVE" | "PAUSED";

const MODES: UiMode[] = ["DRY_RUN", "LIVE", "PAUSED"];
const ACTIVE_STYLES: Record<UiMode, string> = {
  DRY_RUN: "bg-slate-200 text-ink-950",
  LIVE: "bg-amber-400 text-ink-950",
  PAUSED: "bg-slate-500 text-ink-950",
};

/** DRY RUN / LIVE / PAUSED segmented control, same look as the BTC Yield Autopilot. */
export function RunModeToggle({ current, onChange }: { current: UiMode; onChange: (mode: UiMode) => void }) {
  return (
    <div className="flex gap-1 bg-ink-950/60 p-1 rounded-lg border border-slate-800 w-fit">
      {MODES.map((mode) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={`px-4 py-2 rounded-md text-sm font-semibold tracking-wide transition-colors ${
            mode === current ? ACTIVE_STYLES[mode] : "text-slate-500 hover:text-slate-200"
          }`}
        >
          {mode.replace("_", " ")}
        </button>
      ))}
    </div>
  );
}
