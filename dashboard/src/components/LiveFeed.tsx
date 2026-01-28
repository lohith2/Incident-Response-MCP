import type { Incident } from "../api/client";

const SEV_DOT: Record<string, string> = {
  SEV1: "bg-red-500",
  SEV2: "bg-orange-500",
  SEV3: "bg-yellow-500",
  SEV4: "bg-green-500",
};

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

interface Props {
  incidents: Incident[];
}

export function LiveFeed({ incidents }: Props) {
  const active = incidents.filter((i) => i.resolved_at === null);
  const recent = [...incidents]
    .sort((a, b) => new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime())
    .slice(0, 8);

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold text-gray-200">Live Feed</h2>
        {active.length > 0 && (
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-900 border border-red-700 text-red-300 text-xs font-bold">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            {active.length} ACTIVE
          </span>
        )}
        {active.length === 0 && (
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-900 border border-green-700 text-green-300 text-xs font-bold">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            ALL CLEAR
          </span>
        )}
      </div>

      <div className="rounded-xl bg-gray-900 border border-gray-800 divide-y divide-gray-800">
        {recent.map((inc) => {
          const isActive = inc.resolved_at === null;
          return (
            <div
              key={inc.incident_id}
              className={`flex items-start gap-3 px-4 py-3 ${isActive ? "bg-gray-800/40" : ""}`}
            >
              {/* Severity indicator */}
              <div className="mt-1.5 flex-shrink-0">
                <span
                  className={`block w-2.5 h-2.5 rounded-full ${SEV_DOT[inc.severity]} ${isActive ? "animate-pulse" : ""}`}
                />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm text-blue-400">{inc.incident_id}</span>
                  <span className="text-gray-400 text-sm">{inc.service}</span>
                  {isActive && (
                    <span className="text-xs text-red-400 font-semibold uppercase">Active</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  {inc.root_cause ?? "Root cause under investigation"}
                </p>
              </div>

              <span className="text-xs text-gray-600 flex-shrink-0">{timeAgo(inc.detected_at)}</span>
            </div>
          );
        })}
        {recent.length === 0 && (
          <p className="px-4 py-6 text-center text-gray-600 text-sm">No incidents yet.</p>
        )}
      </div>
    </section>
  );
}
