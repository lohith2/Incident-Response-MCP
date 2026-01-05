import { z, ZodError } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { DatadogClient } from "../integrations/datadog.js";
import * as cache from "../cache/redis.js";
import { findSimilarLogPattern } from "../vectordb/log-patterns.js";
import { mockLogs } from "../mocks/incident.js";

// ── Shared types ──────────────────────────────────────────────────────────────

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function validationError(err: ZodError): ToolResult {
  const issues = err.issues.map((i) => `• ${i.path.join(".")}: ${i.message}`).join("\n");
  return {
    content: [{ type: "text", text: `Input validation failed:\n${issues}` }],
    isError: true,
  };
}

// ── DatadogClient (lazy singleton) ────────────────────────────────────────────

let _dd: DatadogClient | null = null;

function getDd(): DatadogClient {
  if (!_dd) {
    const apiKey = process.env.DATADOG_API_KEY;
    const appKey = process.env.DATADOG_APP_KEY;
    if (!apiKey || !appKey)
      throw new Error("DATADOG_API_KEY and DATADOG_APP_KEY env vars are required");
    _dd = new DatadogClient(apiKey, appKey);
  }
  return _dd;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const LogQuerySchema = z.object({
  service: z.string().min(1, "service must be a non-empty string"),
  query: z.string().default("").describe("Additional DDog filter (e.g. 'status:error @http.status:500'). Leave empty for all logs."),
  from_minutes_ago: z
    .number()
    .int()
    .min(1, "from_minutes_ago must be at least 1")
    .max(1440, "from_minutes_ago cannot exceed 1440 (24 h)")
    .default(60),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500, "limit cannot exceed 500")
    .default(100),
});

const LogGetErrorSpikeSchema = z.object({
  service: z.string().min(1),
  minutes: z
    .number()
    .int()
    .min(1, "minutes must be at least 1")
    .max(60, "minutes cannot exceed 60")
    .default(15)
    .describe("Comparison window size. Current [0, minutes] vs baseline [minutes, 2×minutes]."),
});

const LogGetMetricsSchema = z.object({
  service: z.string().min(1),
  from_minutes_ago: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(60)
    .describe("Window size for all metric calculations."),
});

const LogFindPatternSchema = z.object({
  service: z.string().min(1),
  from_minutes_ago: z.number().int().min(1).max(1440).default(60),
  error_only: z
    .boolean()
    .default(true)
    .describe("When true only analyse error-level log lines; false includes all levels."),
});

// ── Tool definitions ──────────────────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "log_query",
    description:
      "Query Datadog logs for a service within a rolling time window. " +
      "Results are cached in Redis for 60 seconds.",
    inputSchema: {
      type: "object",
      required: ["service"],
      properties: {
        service: { type: "string", description: "Datadog service name tag." },
        query: {
          type: "string",
          description:
            "Additional Datadog filter expression applied after the service tag " +
            "(e.g. 'status:error @http.status_code:500'). Empty string returns all logs.",
        },
        from_minutes_ago: {
          type: "number",
          minimum: 1,
          maximum: 1440,
          default: 60,
          description: "How many minutes back the search window starts (default 60).",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          default: 100,
          description: "Maximum number of log lines to return (default 100).",
        },
      },
    },
  },
  {
    name: "log_get_error_spike",
    description:
      "Detect an error spike by comparing the current window's error rate to the " +
      "equivalent prior window.  Returns spike=true when current > 2× baseline.",
    inputSchema: {
      type: "object",
      required: ["service"],
      properties: {
        service: { type: "string", description: "Datadog service name tag." },
        minutes: {
          type: "number",
          minimum: 1,
          maximum: 60,
          default: 15,
          description:
            "Window size in minutes.  Current: [0, N] vs baseline: [N, 2N] (default 15).",
        },
      },
    },
  },
  {
    name: "log_get_metrics",
    description:
      "Return p50 / p95 / p99 latency (ms), error rate, and throughput (RPS) " +
      "for a service from Datadog APM metrics. Cached for 60 s.",
    inputSchema: {
      type: "object",
      required: ["service"],
      properties: {
        service: { type: "string", description: "Datadog service name tag." },
        from_minutes_ago: {
          type: "number",
          minimum: 1,
          maximum: 1440,
          default: 60,
          description: "Window size for all metric calculations (default 60 min).",
        },
      },
    },
  },
  {
    name: "log_find_pattern",
    description:
      "Cluster recent log messages by normalising variable tokens (numbers, UUIDs, " +
      "paths, quoted strings) and return the top 5 patterns by frequency. " +
      "Useful for quickly identifying the dominant error type during an incident.",
    inputSchema: {
      type: "object",
      required: ["service"],
      properties: {
        service: { type: "string", description: "Datadog service name tag." },
        from_minutes_ago: {
          type: "number",
          minimum: 1,
          maximum: 1440,
          default: 60,
          description: "Look-back window in minutes (default 60).",
        },
        error_only: {
          type: "boolean",
          default: true,
          description:
            "Restrict clustering to error-level lines only (default true). " +
            "Set false to analyse all log levels.",
        },
      },
    },
  },
];

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (process.env.USE_MOCK === "true") {
    const service = (args.service as string | undefined) ?? "payment-service";
    switch (name) {
      case "log_query":
        return text({ cached: false, count: 4, service, logs: mockLogs() });
      case "log_get_error_spike":
        return text({ spike: true, service, window_minutes: args.minutes ?? 9,
          duration_minutes: 9,
          current: { error_count: 42, hit_count: 100, error_rate: 0.42 },
          baseline: { error_count: 1, hit_count: 100, error_rate: 0.01 },
          peak_error_rate: 0.42, baseline_error_rate: 0.01,
          spike_factor: 4.2, summary: "Error spike detected — current rate is 4.2× higher than baseline" });
      case "log_get_metrics":
        return text({ cached: false, service, window_minutes: args.from_minutes_ago ?? 60,
          latency_ms: { p50: 180, p95: 1200, p99: 4800 },
          error_rate: 0.42, error_count: 420, hit_count: 1000, throughput_rps: 95 });
      case "log_find_pattern":
        return text({ service, window_minutes: args.from_minutes_ago ?? 60, total_logs_analysed: 4, error_only: true,
          top_patterns: [{ pattern: "Connection pool exhausted — all <N> connections in use", count: 2, examples: mockLogs().slice(0, 1).map(l => l.message) }] });
      default:
        return text({ mock: true, tool: name, status: "ok" });
    }
  }

  try {
    switch (name) {
      case "log_query": return await logQuery(args);
      case "log_get_error_spike": return await logGetErrorSpike(args);
      case "log_get_metrics": return await logGetMetrics(args);
      case "log_find_pattern": return await logFindPattern(args);
      default:
        return { content: [{ type: "text", text: `Unknown log tool: ${name}` }], isError: true };
    }
  } catch (err) {
    if (err instanceof ZodError) return validationError(err);
    throw err;
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function logQuery(raw: Record<string, unknown>): Promise<ToolResult> {
  const input = LogQuerySchema.parse(raw);
  const cacheKey = `log:query:${JSON.stringify(input)}`;

  const cached = await cache.get(cacheKey);
  if (cached) return text({ cached: true, ...JSON.parse(cached) });

  const logs = await getDd().queryLogs(input.service, input.query, input.from_minutes_ago, input.limit);

  const formatted = logs.map((l) => ({
    timestamp: l.timestamp,
    status: l.status,
    message: l.message,
    host: l.host,
    tags: l.tags,
  }));
  const payload = { count: logs.length, service: input.service, logs: formatted };
  await cache.set(cacheKey, JSON.stringify(payload), 60);
  return text({ cached: false, ...payload });
}

async function logGetErrorSpike(raw: Record<string, unknown>): Promise<ToolResult> {
  const { service, minutes } = LogGetErrorSpikeSchema.parse(raw);

  // current window: [0, minutes] from now
  // baseline window: [minutes, 2*minutes] from now
  const [current, baseline] = await Promise.all([
    getDd().getErrorRate(service, minutes, 0),
    getDd().getErrorRate(service, minutes, minutes),
  ]);

  const spikeDetected = baseline.error_rate > 0
    ? current.error_rate > baseline.error_rate * 2
    : current.error_count > 5; // if no baseline data, flag if >5 errors

  const spikeFactor =
    baseline.error_rate > 0 ? current.error_rate / baseline.error_rate : null;

  return text({
    spike: spikeDetected,
    service,
    window_minutes: minutes,
    current: { error_count: current.error_count, hit_count: current.hit_count, error_rate: current.error_rate },
    baseline: { error_count: baseline.error_count, hit_count: baseline.hit_count, error_rate: baseline.error_rate },
    spike_factor: spikeFactor,
    summary: spikeDetected
      ? `Error spike detected — current rate is ${spikeFactor ? `${spikeFactor.toFixed(1)}×` : "significantly"} higher than baseline`
      : "No error spike detected",
  });
}

async function logGetMetrics(raw: Record<string, unknown>): Promise<ToolResult> {
  const { service, from_minutes_ago } = LogGetMetricsSchema.parse(raw);
  const cacheKey = `log:metrics:${service}:${from_minutes_ago}`;

  const cached = await cache.get(cacheKey);
  if (cached) return text({ cached: true, ...JSON.parse(cached) });

  const [p50, p95, p99, errorRate, hits] = await Promise.all([
    getDd().getMetrics("avg:trace.web.request.duration.by.resource_service.50p", service, from_minutes_ago),
    getDd().getMetrics("avg:trace.web.request.duration.by.resource_service.95p", service, from_minutes_ago),
    getDd().getMetrics("avg:trace.web.request.duration.by.resource_service.99p", service, from_minutes_ago),
    getDd().getErrorRate(service, from_minutes_ago),
    getDd().getMetrics("sum:trace.web.request.hits{}", service, from_minutes_ago),
  ]);

  // throughput: total hits / window seconds → RPS
  const windowSeconds = from_minutes_ago * 60;
  const throughputRps = windowSeconds > 0 ? hits.points.reduce((s, p) => s + p.value, 0) / windowSeconds : 0;

  const payload = {
    service,
    window_minutes: from_minutes_ago,
    latency_ms: { p50: p50.avg, p95: p95.avg, p99: p99.avg },
    error_rate: errorRate.error_rate,
    error_count: errorRate.error_count,
    hit_count: errorRate.hit_count,
    throughput_rps: throughputRps,
  };
  await cache.set(cacheKey, JSON.stringify(payload), 60);
  return text({ cached: false, ...payload });
}

async function logFindPattern(raw: Record<string, unknown>): Promise<ToolResult> {
  const { service, from_minutes_ago, error_only } = LogFindPatternSchema.parse(raw);
  const query = error_only ? "status:error" : "";

  const logs = await getDd().queryLogs(service, query, from_minutes_ago, 500);

  // Cluster by normalising variable tokens to placeholders.
  const patternMap = new Map<string, { count: number; examples: string[] }>();
  for (const log of logs) {
    const pattern = extractPattern(log.message);
    const entry = patternMap.get(pattern) ?? { count: 0, examples: [] };
    entry.count += 1;
    if (entry.examples.length < 3) entry.examples.push(log.message);
    patternMap.set(pattern, entry);
  }

  const top5Raw = Array.from(patternMap.entries())
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 5)
    .map(([pattern, { count, examples }]) => ({ pattern, count, examples }));

  const top5 = await Promise.all(
    top5Raw.map(async (item) => {
      // Use the first concrete example as the search query
      const queryText = item.examples[0] ?? item.pattern;
      const similar = await findSimilarLogPattern(queryText);

      // If confidence > 0.8, include historical context
      if (similar && similar.confidence >= 0.8) {
        return {
          ...item,
          historical_context: {
            message: `This error pattern was seen before.\nRoot cause was: ${similar.root_cause}\nFix applied: ${similar.fix_applied}`,
            root_cause: similar.root_cause,
            fix_applied: similar.fix_applied,
            confidence: similar.confidence
          }
        };
      }
      return item;
    })
  );

  return text({
    service,
    window_minutes: from_minutes_ago,
    total_logs_analysed: logs.length,
    error_only,
    top_patterns: top5,
  });
}

// ── Pattern extraction helper ─────────────────────────────────────────────────

function extractPattern(message: string): string {
  return message
    // UUIDs
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>")
    // IPv4
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<IP>")
    // Unix timestamps / long numeric IDs
    .replace(/\b\d{10,}\b/g, "<TS>")
    // Quoted strings
    .replace(/"[^"]{1,120}"/g, '"<STR>"')
    // File-system paths (keep the leading slash so the pattern is still readable)
    .replace(/(?<=\s|^)(\/[a-zA-Z0-9._\-/]+)/g, "<PATH>")
    // Remaining integers
    .replace(/\b\d+\b/g, "<N>")
    .replace(/\s+/g, " ")
    .trim();
}
