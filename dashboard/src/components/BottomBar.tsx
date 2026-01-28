import type { RagHitRate } from "../api/client";

interface Props {
  ragHitRate: RagHitRate | null;
  kbSize: number;
  lastUpdated: Date | null;
  systemHealthy: boolean;
}

export function BottomBar({ ragHitRate, kbSize, lastUpdated, systemHealthy }: Props) {
  const hitPct = ragHitRate ? Math.round(ragHitRate.hit_rate * 100) : 0;
  const matched = ragHitRate?.total_matched ?? 0;
  const searched = ragHitRate?.total_searched ?? 0;

  const lastStr = lastUpdated
    ? lastUpdated.toLocaleTimeString("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }) + " PT"
    : "—";

  return (
    <footer className="border-t border-brd bg-surface px-6 py-2.5 flex items-center gap-6 flex-shrink-0">
      {/* RAG Hit Rate */}
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] text-muted uppercase tracking-widest whitespace-nowrap">
          RAG Hit Rate
        </span>
        <div className="w-28 h-1 bg-brd rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-700"
            style={{ width: `${hitPct}%` }}
          />
        </div>
        <span className="font-mono text-xs font-bold text-accent glow-green">{hitPct}%</span>
        {ragHitRate && (
          <span className="font-mono text-[10px] text-muted">
            ({matched}/{searched} matched)
          </span>
        )}
      </div>

      <span className="text-brd select-none">│</span>

      {/* Knowledge Base */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-muted uppercase tracking-widest whitespace-nowrap">
          Knowledge Base
        </span>
        <span className="font-mono text-xs font-bold text-accent">{kbSize}</span>
        <span className="font-mono text-[10px] text-muted">incidents indexed</span>
      </div>

      <span className="text-brd select-none">│</span>

      {/* MCP Server status */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-muted uppercase tracking-widest">MCP Server</span>
        <span className={`font-mono text-[10px] ${systemHealthy ? "text-accent" : "text-danger"}`}>
          {systemHealthy ? "● CONNECTED" : "⚠ OFFLINE"}
        </span>
      </div>

      {/* Last updated — pushed right */}
      <div className="flex items-center gap-2 ml-auto">
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot flex-shrink-0" />
        <span className="font-mono text-[10px] text-muted whitespace-nowrap">
          Last sync {lastStr}
        </span>
      </div>
    </footer>
  );
}
