import axios, { AxiosInstance, AxiosError } from "axios";
import { logger } from "../logger.js";

const DD_BASE = "https://api.datadoghq.com";

// ── Public types ──────────────────────────────────────────────────────────────

export interface LogEvent {
  id: string;
  timestamp: string;
  status: string;
  message: string;
  service?: string;
  host?: string;
  tags?: string[];
}

export interface MetricPoint {
  /** Epoch milliseconds */
  timestamp: number;
  value: number;
}

export interface MetricSeries {
  metric: string;
  scope: string;
  points: MetricPoint[];
  /** Average value over the window, 0 when no data */
  avg: number;
}

export interface ErrorRateResult {
  error_count: number;
  hit_count: number;
  /** Fraction 0–1 */
  error_rate: number;
  window_minutes: number;
}

export interface TraceSpan {
  span_id: string;
  trace_id: string;
  service: string;
  resource: string;
  operation: string;
  /** Duration in milliseconds */
  duration_ms: number;
  error: boolean;
  status: string;
  timestamp: string;
}

export interface Trace {
  trace_id: string;
  spans: TraceSpan[];
  /** Max span duration in the trace, in milliseconds */
  duration_ms: number;
  error: boolean;
}

export interface AnomalyResult {
  anomaly_detected: boolean;
  metrics: {
    current_error_rate: number;
    baseline_error_rate: number;
    spike_factor: number;
    current_p99_ms: number;
    baseline_p99_ms: number;
    latency_factor: number;
  };
  window_minutes: number;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class DatadogClient {
  private readonly http: AxiosInstance;

  constructor(apiKey: string, appKey: string) {
    this.http = axios.create({
      baseURL: DD_BASE,
      headers: {
        "DD-API-KEY": apiKey,
        "DD-APPLICATION-KEY": appKey,
        "Content-Type": "application/json",
      },
    });

    // ── Request interceptor ──────────────────────────────────────────────────
    this.http.interceptors.request.use((config) => {
      logger.debug("datadog →", {
        method: config.method?.toUpperCase(),
        url: config.url,
        params: config.params,
      });
      (config as any)._startMs = Date.now();
      return config;
    });

    // ── Response interceptor ─────────────────────────────────────────────────
    this.http.interceptors.response.use(
      (response) => {
        const startMs = (response.config as any)._startMs as number | undefined;
        logger.debug("datadog ←", {
          status: response.status,
          url: response.config.url,
          duration_ms: startMs ? Date.now() - startMs : undefined,
        });
        return response;
      },
      (error: AxiosError) => {
        logger.error("datadog request failed", {
          url: error.config?.url,
          status: error.response?.status,
          body: (error.response?.data as Record<string, unknown>)?.errors,
          message: error.message,
        });
        return Promise.reject(error);
      },
    );
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  /**
   * Search Datadog logs (v2 API).
   *
   * @param service       Service name — automatically prepended to the query.
   * @param query         Additional DDog filter expression (e.g. "status:error").
   * @param fromMinutesAgo  Window start relative to now.
   * @param limit         Max log events returned (1–1000).
   */
  async queryLogs(
    service: string,
    query: string,
    fromMinutesAgo: number,
    limit = 100,
  ): Promise<LogEvent[]> {
    const now = new Date();
    const from = new Date(now.getTime() - fromMinutesAgo * 60_000);
    const fullQuery = `service:${service}${query ? ` ${query}` : ""}`;

    const { data } = await this.http.post("/api/v2/logs/events/search", {
      filter: { query: fullQuery, from: from.toISOString(), to: now.toISOString() },
      page: { limit },
      sort: "-timestamp",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.data ?? []).map((item: any) => ({
      id: item.id,
      timestamp: item.attributes?.timestamp ?? "",
      status: item.attributes?.status ?? "info",
      message: item.attributes?.message ?? "",
      service: item.attributes?.service,
      host: item.attributes?.host,
      tags: item.attributes?.tags,
    }));
  }

  /**
   * Query a Datadog metric time-series (v1 query API).
   *
   * @param metricName  Full metric name with aggregator, e.g. "avg:trace.web.request.duration".
   * @param service     Value for the `service` tag filter.
   * @param fromMinutesAgo  Window size relative to now.
   */
  async getMetrics(
    metricName: string,
    service: string,
    fromMinutesAgo: number,
  ): Promise<MetricSeries> {
    const now = Math.floor(Date.now() / 1000);
    const from = now - fromMinutesAgo * 60;
    const query = `${metricName}{service:${service}}`;

    const { data } = await this.http.get("/api/v1/query", {
      params: { metric: query, from, to: now },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = data.series?.[0];
    const points: MetricPoint[] = (raw?.pointlist ?? []).map(
      ([ts, val]: [number, number | null]) => ({ timestamp: ts, value: val ?? 0 }),
    );
    const avg = points.length
      ? points.reduce((s, p) => s + p.value, 0) / points.length
      : 0;

    return { metric: metricName, scope: `service:${service}`, points, avg };
  }

  /**
   * Calculate the error rate for a service over a window using APM trace metrics.
   * Uses `trace.web.request.errors` / `trace.web.request.hits`.
   *
   * @param service  Service tag.
   * @param minutes  Window size in minutes.
   * @param toMinutesAgo  End of window relative to now (default 0 = "up to now").
   *                      Pass 15 + a `minutes` of 15 to query the 15–30 min window.
   */
  async getErrorRate(
    service: string,
    minutes: number,
    toMinutesAgo = 0,
  ): Promise<ErrorRateResult> {
    const now = Math.floor(Date.now() / 1000);
    const to = now - toMinutesAgo * 60;
    const from = to - minutes * 60;

    const [errRes, hitRes] = await Promise.all([
      this.fetchScalarSum(`sum:trace.web.request.errors{service:${service}}.as_count()`, from, to),
      this.fetchScalarSum(`sum:trace.web.request.hits{service:${service}}.as_count()`, from, to),
    ]);

    return {
      error_count: Math.round(errRes),
      hit_count: Math.round(hitRes),
      error_rate: hitRes > 0 ? errRes / hitRes : 0,
      window_minutes: minutes,
    };
  }

  /**
   * Detect anomalies by comparing current window metrics to the equivalent
   * prior window.  Flags an anomaly when error rate or p99 latency exceeds
   * twice the baseline.
   *
   * @param service  Service tag.
   * @param minutes  Window size in minutes.
   */
  async detectAnomalies(service: string, minutes: number): Promise<AnomalyResult> {
    const now = Math.floor(Date.now() / 1000);
    const windowSec = minutes * 60;

    // Current window: (now - window, now]
    // Baseline window: (now - 2*window, now - window]
    const [currentErr, baselineErr, currentP99, baselineP99] = await Promise.all([
      this.fetchScalarSum(
        `sum:trace.web.request.errors{service:${service}}.as_count()`,
        now - windowSec, now,
      ),
      this.fetchScalarSum(
        `sum:trace.web.request.errors{service:${service}}.as_count()`,
        now - 2 * windowSec, now - windowSec,
      ),
      this.fetchScalarAvg(
        `p99:trace.web.request.duration{service:${service}}`,
        now - windowSec, now,
      ),
      this.fetchScalarAvg(
        `p99:trace.web.request.duration{service:${service}}`,
        now - 2 * windowSec, now - windowSec,
      ),
    ]);

    const spikeFactor = baselineErr > 0 ? currentErr / baselineErr : (currentErr > 0 ? 99 : 1);
    const latencyFactor = baselineP99 > 0 ? currentP99 / baselineP99 : (currentP99 > 0 ? 99 : 1);

    return {
      anomaly_detected: spikeFactor > 2 || latencyFactor > 2,
      metrics: {
        current_error_rate: currentErr,
        baseline_error_rate: baselineErr,
        spike_factor: spikeFactor,
        current_p99_ms: currentP99,
        baseline_p99_ms: baselineP99,
        latency_factor: latencyFactor,
      },
      window_minutes: minutes,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async fetchScalarSum(query: string, from: number, to: number): Promise<number> {
    try {
      const { data } = await this.http.get("/api/v1/query", { params: { metric: query, from, to } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const points: [number, number | null][] = data.series?.[0]?.pointlist ?? [];
      return points.reduce((acc, [, v]) => acc + (v ?? 0), 0);
    } catch {
      return 0;
    }
  }

  private async fetchScalarAvg(query: string, from: number, to: number): Promise<number> {
    try {
      const { data } = await this.http.get("/api/v1/query", { params: { metric: query, from, to } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const points: [number, number | null][] = data.series?.[0]?.pointlist ?? [];
      if (!points.length) return 0;
      const sum = points.reduce((acc, [, v]) => acc + (v ?? 0), 0);
      return sum / points.length;
    } catch {
      return 0;
    }
  }

  /**
   * Search Datadog APM spans (v2 API) and group them into traces.
   *
   * @param service  APM service name (tag filter).
   * @param env      Deployment environment (tag filter).
   * @param from     ISO 8601 start time.
   * @param to       ISO 8601 end time.
   * @param limit    Max spans to retrieve before grouping (default 25).
   */
  async queryTraces(service: string, env: string, from: string, to: string, limit: number): Promise<Trace[]> {
    const query = `service:${service} env:${env}`;
    const { data } = await this.http.post("/api/v2/spans/events/search", {
      filter: { query, from, to },
      page: { limit },
      sort: "-timestamp",
    });

    // Group spans by trace_id
    const spansByTrace = new Map<string, TraceSpan[]>();
    for (const item of (data.data ?? []) as Record<string, any>[]) {
      const attrs = item.attributes ?? {};
      const traceId: string = attrs["trace_id"] ?? item.id;
      const span: TraceSpan = {
        span_id: item.id,
        trace_id: traceId,
        service: attrs["service"] ?? service,
        resource: attrs["resource_name"] ?? "",
        operation: attrs["operation_name"] ?? "",
        // Datadog returns duration in nanoseconds
        duration_ms: (attrs["duration"] ?? 0) / 1_000_000,
        error: (attrs["error"] ?? 0) === 1,
        status: (attrs["error"] ?? 0) === 1 ? "error" : "ok",
        timestamp: attrs["timestamp"] ?? from,
      };
      if (!spansByTrace.has(traceId)) spansByTrace.set(traceId, []);
      spansByTrace.get(traceId)!.push(span);
    }

    return Array.from(spansByTrace.entries()).map(([traceId, spans]) => ({
      trace_id: traceId,
      spans,
      duration_ms: Math.max(...spans.map((s) => s.duration_ms)),
      error: spans.some((s) => s.error),
    }));
  }

  /**
   * Query a Datadog metric time-series using a raw query string (v1 API).
   * Accepts epoch-second timestamps, same as the v1 /query endpoint.
   *
   * @param metric_query  Full Datadog metric query, e.g. "avg:trace.web.request.duration{service:api}"
   * @param from          Start epoch time in seconds.
   * @param to            End epoch time in seconds.
   */
  async queryMetrics(metric_query: string, from: number, to: number): Promise<MetricSeries[]> {
    const { data } = await this.http.get("/api/v1/query", {
      params: { metric: metric_query, from, to },
    });

    return ((data.series ?? []) as Record<string, any>[]).map((raw) => {
      const points: MetricPoint[] = ((raw["pointlist"] ?? []) as [number, number | null][]).map(
        ([ts, val]) => ({ timestamp: ts, value: val ?? 0 }),
      );
      const avg = points.length
        ? points.reduce((s, p) => s + p.value, 0) / points.length
        : 0;
      return { metric: raw["metric"] ?? metric_query, scope: raw["scope"] ?? "", points, avg };
    });
  }
}
