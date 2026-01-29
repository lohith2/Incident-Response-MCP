import type { Incident } from "../api/client";

const SEV_BADGE: Record<string, string> = {
  SEV1: "bg-red-900 text-red-300 border-red-700",
  SEV2: "bg-orange-900 text-orange-300 border-orange-700",
  SEV3: "bg-yellow-900 text-yellow-300 border-yellow-700",
  SEV4: "bg-green-900 text-green-300 border-green-700",
};

function fmt(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

interface Props {
  incidents: Incident[];
}

export function RecentIncidents({ incidents }: Props) {
  const sorted = [...incidents].sort(
    (a, b) => new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime(),
  );

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-200 mb-4">Recent Incidents</h2>
      <div className="rounded-xl bg-gray-900 border border-gray-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-left">
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">Service</th>
              <th className="px-4 py-3 font-medium">Severity</th>
              <th className="px-4 py-3 font-medium">Root Cause</th>
              <th className="px-4 py-3 font-medium">Time to Resolve</th>
              <th className="px-4 py-3 font-medium">Postmortem</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((inc) => (
              <tr key={inc.incident_id} className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors">
                <td className="px-4 py-3 font-mono text-blue-400">
                  {inc.github_issue_url ? (
                    <a href={inc.github_issue_url} target="_blank" rel="noreferrer" className="hover:underline">
                      {inc.incident_id}
                    </a>
                  ) : inc.incident_id}
                </td>
                <td className="px-4 py-3 text-gray-300">{inc.service}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded border text-xs font-bold ${SEV_BADGE[inc.severity]}`}>
                    {inc.severity}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-400 max-w-xs truncate" title={inc.root_cause ?? ""}>
                  {inc.root_cause ?? <span className="italic text-gray-600">investigating…</span>}
                </td>
                <td className="px-4 py-3 font-mono text-gray-300">{fmt(inc.time_to_resolve_sec)}</td>
                <td className="px-4 py-3">
                  {inc.postmortem_url ? (
                    <a href={inc.postmortem_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline text-xs">
                      View →
                    </a>
                  ) : (
                    <span className="text-gray-600 text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
