// ── Types ─────────────────────────────────────────────────────────────────────

export interface Incident {
  incident_id: string;
  service: string;
  severity: "SEV1" | "SEV2" | "SEV3" | "SEV4";
  detected_at: string;
  resolved_at: string | null;
  root_cause: string | null;
  time_to_resolve_sec: number | null;
  time_to_root_cause_sec: number | null;
  postmortem_url: string | null;
  github_issue_url: string | null;
  ai_assisted: boolean;
}

export interface RecentIncidentSummary {
  incident_id: string;
  service: string;
  severity: string;
  root_cause: string | null;
  time_to_resolve_sec: number | null;
  resolved_at: string | null;
  detected_at: string | null;
}

export interface Metrics {
  total_incidents: number;
  avg_ai_minutes: string | number;
  avg_manual_minutes: number;
  improvement_percent: number;
  knowledge_base_size: number;
  recent_incidents: RecentIncidentSummary[];
}

// ── Mock data (used when backend is unavailable) ──────────────────────────────

const MOCK_INCIDENTS: Incident[] = [
  { incident_id: "INC-042", service: "payment-service", severity: "SEV1", detected_at: "2024-03-15T14:32:00Z", resolved_at: "2024-03-15T15:10:00Z", root_cause: "Database connection pool exhausted after deploy", time_to_resolve_sec: 2280, time_to_root_cause_sec: 420, postmortem_url: null, github_issue_url: "https://github.com/acme/api/issues/42", ai_assisted: true },
  { incident_id: "INC-041", service: "auth-service", severity: "SEV2", detected_at: "2024-03-14T09:15:00Z", resolved_at: "2024-03-14T10:02:00Z", root_cause: "Redis cache TTL misconfiguration", time_to_resolve_sec: 2820, time_to_root_cause_sec: 600, postmortem_url: null, github_issue_url: null, ai_assisted: true },
  { incident_id: "INC-040", service: "api-gateway", severity: "SEV2", detected_at: "2024-03-13T22:40:00Z", resolved_at: "2024-03-13T23:18:00Z", root_cause: "Memory leak in request parser v2.1.0", time_to_resolve_sec: 2280, time_to_root_cause_sec: 540, postmortem_url: null, github_issue_url: null, ai_assisted: false },
  { incident_id: "INC-039", service: "notification-svc", severity: "SEV3", detected_at: "2024-03-12T11:05:00Z", resolved_at: "2024-03-12T11:45:00Z", root_cause: "Third-party email provider rate limit", time_to_resolve_sec: 2400, time_to_root_cause_sec: 780, postmortem_url: null, github_issue_url: null, ai_assisted: true },
  { incident_id: "INC-038", service: "payment-service", severity: "SEV1", detected_at: "2024-03-10T03:20:00Z", resolved_at: "2024-03-10T04:55:00Z", root_cause: "Cascading timeout from upstream service", time_to_resolve_sec: 5700, time_to_root_cause_sec: 1200, postmortem_url: null, github_issue_url: null, ai_assisted: false },
  { incident_id: "INC-037", service: "search-service", severity: "SEV3", detected_at: "2024-03-09T16:33:00Z", resolved_at: "2024-03-09T17:01:00Z", root_cause: "Elasticsearch index corruption", time_to_resolve_sec: 1680, time_to_root_cause_sec: 360, postmortem_url: null, github_issue_url: null, ai_assisted: true },
];

const MOCK_METRICS: Metrics = {
  total_incidents: 6,
  avg_ai_minutes: "38.0",
  avg_manual_minutes: 47,
  improvement_percent: 19,
  knowledge_base_size: 10,
  recent_incidents: [],
};

// ── API client ────────────────────────────────────────────────────────────────

const BASE = "/api";

async function safeFetch<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export async function fetchIncidents(): Promise<Incident[]> {
  return safeFetch<Incident[]>("/incidents", MOCK_INCIDENTS);
}

export async function fetchRecentIncidents(): Promise<RecentIncidentSummary[]> {
  return safeFetch<RecentIncidentSummary[]>(
    "/incidents/recent",
    MOCK_INCIDENTS.map((i) => ({
      incident_id: i.incident_id,
      service: i.service,
      severity: i.severity,
      root_cause: i.root_cause,
      time_to_resolve_sec: i.time_to_resolve_sec,
      resolved_at: i.resolved_at,
      detected_at: i.detected_at,
    })),
  );
}

export async function fetchMetrics(): Promise<Metrics> {
  return safeFetch<Metrics>("/metrics", MOCK_METRICS);
}

// ── RAG metric types ──────────────────────────────────────────────────────────

export interface RagHitRate {
  /** 0–1 fraction of incidents where a similar past incident was found */
  hit_rate: number;
  total_searched: number;
  total_matched: number;
  knowledge_base_size: number;
}

export interface KnowledgeBaseGrowthPoint {
  /** "YYYY-MM-DD" */
  date: string;
  /** Cumulative number of incidents stored up to this date */
  count: number;
}

export interface RecurringIssue {
  pattern: string;
  occurrences: number;
  avg_resolution_min: number;
  /** ISO 8601 timestamp of most recent occurrence */
  last_seen: string;
}

// ── RAG mock fallback data ────────────────────────────────────────────────────

const MOCK_RAG_HIT_RATE: RagHitRate = {
  hit_rate: 0.74,
  total_searched: 38,
  total_matched: 28,
  knowledge_base_size: 10,
};

const MOCK_KB_GROWTH: KnowledgeBaseGrowthPoint[] = [
  { date: "2024-02-10", count: 1 },
  { date: "2024-02-15", count: 3 },
  { date: "2024-02-20", count: 5 },
  { date: "2024-02-25", count: 6 },
  { date: "2024-03-01", count: 7 },
  { date: "2024-03-05", count: 8 },
  { date: "2024-03-10", count: 9 },
  { date: "2024-03-15", count: 10 },
];

const MOCK_RECURRING_ISSUES: RecurringIssue[] = [
  { pattern: "Connection pool exhausted", occurrences: 12, avg_resolution_min: 22, last_seen: "2024-03-15T14:32:00Z" },
  { pattern: "ECONNREFUSED to downstream", occurrences: 9, avg_resolution_min: 18, last_seen: "2024-03-12T09:10:00Z" },
  { pattern: "OOM / heap exhausted", occurrences: 6, avg_resolution_min: 55, last_seen: "2024-03-10T03:20:00Z" },
  { pattern: "Certificate expired", occurrences: 3, avg_resolution_min: 73, last_seen: "2024-02-28T03:14:00Z" },
  { pattern: "JWT secret rotation mismatch", occurrences: 3, avg_resolution_min: 52, last_seen: "2024-03-08T11:00:00Z" },
];

// ── RAG fetch functions ───────────────────────────────────────────────────────

export async function fetchRagHitRate(): Promise<RagHitRate> {
  return safeFetch<RagHitRate>("/metrics/rag-hit-rate", MOCK_RAG_HIT_RATE);
}

export async function fetchKnowledgeBaseGrowth(): Promise<KnowledgeBaseGrowthPoint[]> {
  return safeFetch<KnowledgeBaseGrowthPoint[]>("/metrics/knowledge-base-growth", MOCK_KB_GROWTH);
}

export async function fetchRecurringIssues(): Promise<RecurringIssue[]> {
  return safeFetch<RecurringIssue[]>("/metrics/recurring-issues", MOCK_RECURRING_ISSUES);
}
