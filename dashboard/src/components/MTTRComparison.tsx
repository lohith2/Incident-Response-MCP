import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import type { Incident } from "../api/client";

interface Props {
  incidents: Incident[];
}

export function MTTRComparison({ incidents }: Props) {
  const resolved = incidents.filter((i) => i.time_to_resolve_sec !== null);

  const data = resolved.map((inc) => ({
    id: inc.incident_id,
    "AI-Assisted": inc.ai_assisted ? Math.round((inc.time_to_resolve_sec ?? 0) / 60) : 0,
    Manual: inc.ai_assisted ? 0 : Math.round((inc.time_to_resolve_sec ?? 0) / 60),
  }));

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-200 mb-4">MTTR: Manual vs AI-Assisted (minutes)</h2>
      <div className="rounded-xl bg-gray-900 border border-gray-800 p-6">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} barSize={28}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="id" tick={{ fill: "#9ca3af", fontSize: 11 }} />
            <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} unit=" m" />
            <Tooltip
              contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 8 }}
              labelStyle={{ color: "#e5e7eb" }}
              formatter={(v: number) => [`${v} min`]}
            />
            <Legend wrapperStyle={{ color: "#9ca3af" }} />
            <Bar dataKey="AI-Assisted" fill="#22c55e" radius={[4, 4, 0, 0]} />
            <Bar dataKey="Manual"      fill="#ef4444" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
