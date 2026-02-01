import { useEffect, useRef } from "react";
import type { ActivityEntry } from "../App";

const TOOL_COLORS: Record<string, string> = {
  metrics_fetch:       "text-accent",
  incidents_fetch:     "text-[#7eb8f7]",
  incident_new:        "text-danger",
  rag_hit_rate_fetch:  "text-warn",
  alert_get_active:    "text-danger",
  log_query:           "text-[#a78bfa]",
  postmortem_generate: "text-accent",
  traces_query:        "text-[#7eb8f7]",
  traces_query_metrics:"text-[#7eb8f7]",
  system_init:         "text-accent",
  tool_registry:       "text-accent",
  db_connect:          "text-[#7eb8f7]",
  redis_connect:       "text-warn",
};

function fmtTs(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const latestId  = entries[0]?.id;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [latestId]);

  // Display oldest → newest (newest at bottom, auto-scroll reveals it)
  const displayed = [...entries].reverse();

  return (
    <div className="bg-surface border border-brd rounded-lg flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-brd flex-shrink-0">
        <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-primary uppercase">
          Live Activity Feed
        </span>
        <span className="font-mono text-[10px] text-accent animate-pulse">● STREAMING</span>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] space-y-0.5">
        {displayed.length === 0 && (
          <div className="text-muted text-center py-8">
            Initializing<span className="blink">_</span>
          </div>
        )}

        {displayed.map((e) => (
          <div
            key={e.id}
            className="row-animate flex items-start gap-2 leading-5 group"
          >
            <span className="text-muted shrink-0 tabular-nums">{fmtTs(e.ts)}</span>
            <span className="text-brd shrink-0">›</span>
            <span
              className={`shrink-0 font-semibold ${TOOL_COLORS[e.tool] ?? "text-primary"}`}
            >
              {e.tool}
            </span>
            <span className="text-muted truncate flex-1 min-w-0">{e.result}</span>
            <span
              className={`shrink-0 tabular-nums ${e.ok ? "text-accent" : "text-danger"}`}
            >
              {e.ok ? "OK" : "ERR"}
            </span>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
