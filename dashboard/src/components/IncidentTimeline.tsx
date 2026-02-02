import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import type { Incident } from "../api/client";

const SEV_COLOUR: Record<string, string> = {
  SEV1: "#ef4444",
  SEV2: "#f97316",
  SEV3: "#eab308",
  SEV4: "#22c55e",
};

interface Props {
  incidents: Incident[];
}

export function IncidentTimeline({ incidents }: Props) {
  // Aggregate by date
  const byDate = new Map<string, Record<string, number>>();
  for (const inc of incidents) {
    const date = inc.detected_at.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, { SEV1: 0, SEV2: 0, SEV3: 0, SEV4: 0 });
    const day = byDate.get(date)!;
    day[inc.severity] = (day[inc.severity] ?? 0) + 1;
  }

  const data = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-200 mb-4">Incidents Over Time</h2>
      <div className="rounded-xl bg-gray-900 border border-gray-800 p-6">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="date" tick={{ fill: "#9ca3af", fontSize: 11 }} />
            <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 8 }}
              labelStyle={{ color: "#e5e7eb" }}
            />
            <Legend wrapperStyle={{ color: "#9ca3af" }} />
            {(["SEV1", "SEV2", "SEV3", "SEV4"] as const).map((sev) => (
              <Line
                key={sev}
                type="monotone"
                dataKey={sev}
                stroke={SEV_COLOUR[sev]}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
