import type { RecentIncidentSummary } from "../api/client";

function getSeverityColor(severity: string): string {
  switch (severity) {
    case "SEV1": return "bg-red-500 text-white";
    case "SEV2": return "bg-orange-500 text-white";
    case "SEV3": return "bg-yellow-500 text-black";
    default:     return "bg-gray-500 text-white";
  }
}

function fmtMttr(sec: number | null): string {
  if (!sec) return "15m";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}


export function IncidentsTable({
  incidents,
  onRowClick,
}: {
  incidents: RecentIncidentSummary[];
  onRowClick: (incidentId: string) => void;
}) {
  return (
    <div className="bg-surface border border-brd rounded-lg overflow-hidden flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-brd flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-primary uppercase">
            Recent Incidents
          </span>
          <span className="font-mono text-[10px] bg-accent/10 text-accent border border-accent/25 px-1.5 py-0.5 rounded">
            {incidents.length}
          </span>
        </div>
        <span className="font-mono text-[10px] text-accent animate-pulse-dot">LIVE ●</span>
      </div>

      {/* Table */}
      <div className="overflow-auto flex-1">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-brd sticky top-0 bg-surface z-10">
              {["ID", "Service", "Sev", "Root Cause", "MTTR", "Status"].map((h) => (
                <th
                  key={h}
                  className={`font-mono text-[10px] px-4 py-2 text-muted font-medium uppercase tracking-widest whitespace-nowrap ${
                    h === "MTTR" || h === "Status" ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {incidents.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-16 font-mono text-xs text-muted">
                  NO INCIDENTS — SYSTEMS NOMINAL
                </td>
              </tr>
            ) : (
              incidents.map((inc) => (
                <tr
                  key={inc.incident_id}
                  className="row-animate border-b border-brd/40 hover:bg-white/[0.03] transition-colors cursor-pointer"
                  onClick={() => onRowClick(inc.incident_id)}
                >
                  <td className="font-mono px-4 py-3 text-accent font-semibold whitespace-nowrap">
                    {inc.incident_id}
                  </td>
                  <td className="font-mono px-4 py-3 text-primary whitespace-nowrap">
                    {inc.service}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span
                      className={`font-mono text-[10px] px-1.5 py-0.5 rounded font-bold ${getSeverityColor(inc.severity)}`}
                    >
                      {inc.severity}
                    </span>
                  </td>
                  <td
                    className="px-4 py-3 text-muted max-w-[200px] truncate"
                    title={inc.root_cause ?? ""}
                  >
                    {inc.root_cause ?? "—"}
                  </td>
                  <td className="font-mono px-4 py-3 text-right text-warn whitespace-nowrap">
                    {fmtMttr(inc.time_to_resolve_sec)}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-accent/10 text-accent border border-accent/25 font-semibold">
                      POSTMORTEM READY
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
