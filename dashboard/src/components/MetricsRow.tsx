import { useState, useEffect, useRef } from "react";
import type { Metrics } from "../api/client";

function useSyncAge(syncedAt: Date | null): string {
  const [secs, setSecs] = useState<number | null>(null);

  useEffect(() => {
    if (!syncedAt) return;
    const tick = () => setSecs(Math.floor((Date.now() - syncedAt.getTime()) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [syncedAt]);

  if (secs === null) return "syncing…";
  if (secs < 5)  return "synced just now";
  if (secs < 60) return `synced ${secs}s ago`;
  return `synced ${Math.floor(secs / 60)}m ago`;
}

function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(target);
  const prevRef = useRef(target);

  useEffect(() => {
    if (prevRef.current === target) return;
    const start = prevRef.current;
    const diff = target - start;
    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      setValue(Math.round(start + diff * eased));
      if (progress < 1) requestAnimationFrame(tick);
      else prevRef.current = target;
    };

    requestAnimationFrame(tick);
  }, [target, duration]);

  return value;
}

interface CardProps {
  label: string;
  value: number;
  unit?: string;
  color: "accent" | "danger" | "warn" | "muted";
  sub?: string;
  arrow?: "up";
  dim?: boolean;
  error?: boolean;
  syncedAt: Date | null;
}

function MetricCard({ label, value, unit, color, sub, arrow, dim, error, syncedAt }: CardProps) {
  const displayed = useCountUp(isNaN(value) ? 0 : value);
  const syncLabel = useSyncAge(syncedAt);

  const colorMap = {
    accent: dim ? "text-accent/60" : "text-accent glow-green",
    danger: "text-danger glow-red",
    warn:   "text-warn",
    muted:  "text-muted",
  };

  return (
    <div className="flex-1 bg-surface border border-brd rounded-lg p-5 flex flex-col gap-2 min-w-0">
      <p className="font-mono text-[10px] text-muted uppercase tracking-[0.18em] truncate">
        {error && <span className="text-warn mr-1">⚠</span>}
        {label}
      </p>
      <p className={`font-mono text-4xl font-bold tabular-nums num-transition ${colorMap[color]}`}>
        {displayed}
        {unit && (
          <span className="text-2xl ml-1 opacity-60">{unit}</span>
        )}
        {arrow === "up" && (
          <span className="text-accent text-2xl ml-2 opacity-80">↑</span>
        )}
      </p>
      {sub && <p className="text-[11px] text-muted truncate">{sub}</p>}
      <p className="font-mono text-[10px] text-muted/50 tabular-nums">{syncLabel}</p>
    </div>
  );
}

interface MetricsRowProps {
  metrics: Metrics;
  patternCount: number;
  errors: { metrics: boolean; patterns: boolean };
  syncedAt: { metrics: Date | null; patterns: Date | null };
}

export function MetricsRow({ metrics, patternCount, errors, syncedAt }: MetricsRowProps) {
  const aiMin  = Math.round(parseFloat(String(metrics.avg_ai_minutes ?? 0)));
  const manMin = Math.round(metrics.avg_manual_minutes ?? 47);
  const imp    = metrics.improvement_percent ?? 0;
  const kb     = metrics.knowledge_base_size ?? 0;

  return (
    <section className="flex gap-4">
      <MetricCard
        label="Manual MTTR"
        value={manMin}
        unit="min"
        color="muted"
        sub="Baseline without AI"
        error={errors.metrics}
        syncedAt={syncedAt.metrics}
      />
      <MetricCard
        label="AI-Assisted MTTR"
        value={aiMin}
        unit="min"
        color="accent"
        sub={`${imp}% faster than manual`}
        error={errors.metrics}
        syncedAt={syncedAt.metrics}
      />
      <MetricCard
        label="Improvement"
        value={imp}
        unit="%"
        color="accent"
        arrow="up"
        sub="vs. manual baseline"
        error={errors.metrics}
        syncedAt={syncedAt.metrics}
      />
      <MetricCard
        label="Knowledge Base"
        value={kb}
        color="accent"
        sub="Incidents indexed in Pinecone"
        error={errors.metrics}
        syncedAt={syncedAt.metrics}
      />
      <MetricCard
        label="Error Patterns"
        value={patternCount}
        color="accent"
        sub="Extracted by Haiku"
        error={errors.patterns}
        syncedAt={syncedAt.patterns}
      />
    </section>
  );
}
