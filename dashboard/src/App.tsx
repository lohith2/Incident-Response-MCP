import { useState, useEffect, useRef } from "react";
import type { Metrics, RecentIncidentSummary, RagHitRate } from "./api/client";
import { TopBar }           from "./components/TopBar";
import { MetricsRow }       from "./components/MetricsRow";
import { IncidentsTable }   from "./components/IncidentsTable";
import { ActivityFeed }     from "./components/ActivityFeed";
import { BottomBar }        from "./components/BottomBar";
import { PostmortemModal }  from "./components/PostmortemModal";

export interface ActivityEntry {
  id: string;
  ts: Date;
  tool: string;
  result: string;
  ok: boolean;
}

// ── Default / fallback state ───────────────────────────────────────────────────

const MOCK_METRICS: Metrics = {
  total_incidents: 0,
  avg_ai_minutes: "0",
  avg_manual_minutes: 47,
  improvement_percent: 0,
  knowledge_base_size: 0,
  recent_incidents: [],
};

const MOCK_RAG: RagHitRate = {
  hit_rate: 0,
  total_searched: 0,
  total_matched: 0,
  knowledge_base_size: 0,
};

const SEED_ENTRIES: ActivityEntry[] = [
  { id: "s1", ts: new Date(Date.now() - 8_000), tool: "redis_connect", result: "Redis cache connected",       ok: true },
  { id: "s2", ts: new Date(Date.now() - 6_000), tool: "db_connect",    result: "PostgreSQL pool initialized", ok: true },
  { id: "s3", ts: new Date(Date.now() - 4_000), tool: "tool_registry", result: "17 tools registered",         ok: true },
  { id: "s4", ts: new Date(Date.now() - 2_000), tool: "system_init",   result: "MCP server connected",        ok: true },
];

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [metrics,       setMetrics]       = useState<Metrics>(MOCK_METRICS);
  const [incidents,     setIncidents]     = useState<RecentIncidentSummary[]>([]);
  const [ragHitRate,    setRagHitRate]    = useState<RagHitRate>(MOCK_RAG);
  const [patternCount,  setPatternCount]  = useState<number>(0);
  const [systemHealthy, setSystemHealthy] = useState<boolean>(true);
  const [activity,      setActivity]      = useState<ActivityEntry[]>(SEED_ENTRIES);
  const [lastUpdated,   setLastUpdated]   = useState<Date | null>(null);
  const [cardErrors,    setCardErrors]    = useState<Record<string, boolean>>({});
  const [modalIncidentId, setModalIncidentId] = useState<string | null>(null);
  const [syncedAt,      setSyncedAt]      = useState<{ metrics: Date | null; patterns: Date | null }>({
    metrics: null, patterns: null,
  });

  const entryId           = useRef(0);
  const prevMetricsRef    = useRef<Metrics | null>(null);
  const prevIncidentIdsRef = useRef<Set<string> | null>(null);
  const prevHealthyRef    = useRef<boolean | null>(null);
  const prevPatternCountRef  = useRef<number>(0);
  const prevRagHitRateRef    = useRef<number | null>(null);

  // Stable log helper — uses functional state update, safe in all closures.
  const log = useRef((tool: string, result: string, ok: boolean) => {
    const entry: ActivityEntry = {
      id: String(++entryId.current),
      ts: new Date(),
      tool,
      result,
      ok,
    };
    setActivity((prev) => [entry, ...prev].slice(0, 60));
  });

  const markOk  = (key: string) => {
    setLastUpdated(new Date());
    setCardErrors((p) => ({ ...p, [key]: false }));
  };
  const markErr = (key: string) => setCardErrors((p) => ({ ...p, [key]: true }));

  // ── 1. Metrics — GET :8000/metrics every 10 s ──────────────────────────────
  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch("http://localhost:8000/metrics", {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Metrics = await res.json();
        setMetrics(data);
        markOk("metrics");
        setSyncedAt((p) => ({ ...p, metrics: new Date() }));
        if (data.total_incidents !== prevMetricsRef.current?.total_incidents) {
          log.current(
            "metrics_fetch",
            `metrics refreshed — ${data.total_incidents} incidents`,
            true,
          );
        }
        prevMetricsRef.current = data;
      } catch (e) {
        markErr("metrics");
        log.current("metrics_fetch", `⚠ metrics fetch failed: ${(e as Error).message}`, false);
      }
    };
    run();
    const t = setInterval(run, 10_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. Incidents — GET :8000/incidents/recent every 5 s ───────────────────
  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch("http://localhost:8000/incidents/recent", {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: RecentIncidentSummary[] = await res.json();
        setIncidents(data);
        markOk("incidents");
        if (prevIncidentIdsRef.current === null) {
          // First load — silently seed the set so existing incidents aren't treated as new.
          prevIncidentIdsRef.current = new Set(data.map((i) => i.incident_id));
          log.current("system_init", `system ready — monitoring ${data.length} incidents`, true);
        } else {
          const newOnes = data.filter((i) => !prevIncidentIdsRef.current!.has(i.incident_id));
          for (const inc of newOnes) {
            log.current("incident_new", `🚨 new incident — ${inc.incident_id} on ${inc.service} [${inc.severity}]`, true);
            prevIncidentIdsRef.current.add(inc.incident_id);
          }
        }
      } catch (e) {
        markErr("incidents");
        log.current("incidents_fetch", `⚠ incidents fetch failed: ${(e as Error).message}`, false);
      }
    };
    run();
    const t = setInterval(run, 5_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 3. Error Patterns — POST :3000/tools/call every 30 s ──────────────────
  useEffect(() => {
    const run = async () => {
      try {
        const patternResponse = await fetch("http://localhost:3000/tools/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "pattern_get_count", arguments: {} }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!patternResponse.ok) throw new Error(`HTTP ${patternResponse.status}`);
        const patternData = await patternResponse.json();
        const patternText = patternData.content[0].text;
        const parsed = JSON.parse(patternText);
        const count: number = parsed.total_patterns ?? 0;
        setPatternCount(count);
        markOk("patterns");
        setSyncedAt((p) => ({ ...p, patterns: new Date() }));
        if (count > prevPatternCountRef.current) {
          const delta = prevPatternCountRef.current === 0 ? count : count - prevPatternCountRef.current;
          log.current("pattern_fetch", `patterns grew — ${count} total (+${delta} new)`, true);
          prevPatternCountRef.current = count;
        }
      } catch (e) {
        markErr("patterns");
        log.current("pattern_fetch", `⚠ pattern fetch failed: ${(e as Error).message}`, false);
      }
    };
    run();
    const t = setInterval(run, 30_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 4. RAG hit rate — GET :8000/metrics/rag-hit-rate every 30 s ───────────
  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch("http://localhost:8000/metrics/rag-hit-rate", {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: RagHitRate = await res.json();
        setRagHitRate(data);
        markOk("rag");
        const newPct = Math.round(data.hit_rate * 100);
        if (prevRagHitRateRef.current === null || Math.abs(newPct - prevRagHitRateRef.current) > 1) {
          log.current(
            "rag_fetch",
            `RAG hit rate ${newPct}% — ${data.total_matched}/${data.total_searched} matched`,
            true,
          );
          prevRagHitRateRef.current = newPct;
        }
      } catch (e) {
        markErr("rag");
        log.current("rag_fetch", `⚠ RAG fetch failed: ${(e as Error).message}`, false);
      }
    };
    run();
    const t = setInterval(run, 30_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 5. System health — GET :3000/health every 15 s ────────────────────────
  useEffect(() => {
    const run = async () => {
      let healthy = false;
      try {
        const healthResponse = await fetch("http://localhost:3000/health", {
          signal: AbortSignal.timeout(5_000),
        });
        const healthData = await healthResponse.json();
        healthy = healthData.status === "ok";
      } catch {
        healthy = false;
      }
      setSystemHealthy(healthy);
      const prev = prevHealthyRef.current;
      if (prev !== healthy) {
        if (healthy) {
          log.current("health_check", "MCP server back online", true);
        } else {
          log.current("health_check", "⚠ MCP server went offline", false);
        }
        prevHealthyRef.current = healthy;
      }
    };
    run();
    const t = setInterval(run, 15_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ONE_HOUR_MS = 60 * 60 * 1_000;
  const hasActiveIncident = incidents.some((i) => {
    if (!i.detected_at) return false;
    return Date.now() - new Date(i.detected_at).getTime() < ONE_HOUR_MS;
  });

  return (
    <div className="scanlines min-h-screen bg-ink font-sans text-primary flex flex-col">
      <TopBar
        totalResolved={metrics.total_incidents}
        hasActiveIncident={hasActiveIncident}
        lastUpdated={lastUpdated}
      />

      <div className="heartbeat-line" />

      <main className="flex-1 flex flex-col gap-5 p-5 min-h-0">
        <MetricsRow
          metrics={metrics}
          patternCount={patternCount}
          errors={{ metrics: !!cardErrors.metrics, patterns: !!cardErrors.patterns }}
          syncedAt={syncedAt}
        />

        <div className="flex gap-5 flex-1 min-h-0" style={{ minHeight: "420px" }}>
          <div className="flex-[3] min-w-0">
            <IncidentsTable incidents={incidents} onRowClick={setModalIncidentId} />
          </div>
          <div className="flex-[2] min-w-0">
            <ActivityFeed entries={activity} />
          </div>
        </div>
      </main>

      {modalIncidentId && (
        <PostmortemModal
          incidentId={modalIncidentId}
          onClose={() => setModalIncidentId(null)}
        />
      )}

      <BottomBar
        ragHitRate={ragHitRate}
        kbSize={metrics.knowledge_base_size}
        lastUpdated={lastUpdated}
        systemHealthy={systemHealthy}
      />
    </div>
  );
}
