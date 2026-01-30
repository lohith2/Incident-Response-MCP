import type { Metrics, RagHitRate } from "../api/client";

interface Props {
  metrics: Metrics;
  ragHitRate?: RagHitRate | null;
}

function StatCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: "green" | "yellow" | "red" | "indigo";
}) {
  const colours = {
    green: "text-green-400",
    yellow: "text-yellow-400",
    red: "text-red-400",
    indigo: "text-indigo-400",
  };
  return (
    <div className="rounded-xl bg-gray-900 border border-gray-800 p-6 flex flex-col gap-2">
      <p className="text-sm text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-3xl font-bold ${highlight ? colours[highlight] : "text-white"}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

export function MetricsSummary({ metrics, ragHitRate }: Props) {
  const aiMinutes = Math.round(parseFloat(String(metrics.avg_ai_minutes)));
  const manualMinutes = Math.round(metrics.avg_manual_minutes);

  const thisWeek = metrics.recent_incidents.filter(
    (i) =>
      i.resolved_at &&
      new Date(i.resolved_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  ).length;

  const ragPct = ragHitRate ? `${Math.round(ragHitRate.hit_rate * 100)}%` : "—";
  const kbSize = String(metrics.knowledge_base_size);

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-200 mb-4">This Week</h2>
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <StatCard
          label="Avg MTTR — Manual"
          value={`${manualMinutes} min`}
          sub="Baseline without AI"
          highlight="red"
        />
        <StatCard
          label="Avg MTTR — AI-Assisted"
          value={`${aiMinutes} min`}
          sub={`${metrics.improvement_percent}% faster than manual`}
          highlight="green"
        />
        <StatCard
          label="Incidents This Week"
          value={String(thisWeek)}
          sub="Resolved in last 7 days"
        />
        <StatCard
          label="Total Incidents"
          value={String(metrics.total_incidents)}
          sub="In knowledge base"
        />
        <StatCard
          label="Knowledge Base Size"
          value={kbSize}
          sub="Incidents stored in Pinecone"
          highlight="indigo"
        />
        <StatCard
          label="RAG Hit Rate"
          value={ragPct}
          sub="Similar incident found (≥ 0.7)"
          highlight="indigo"
        />
      </div>
    </section>
  );
}
