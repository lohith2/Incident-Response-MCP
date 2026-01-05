import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { DatadogClient } from "../integrations/datadog.js";

const ddClient = new DatadogClient(
  process.env.DATADOG_API_KEY ?? "",
  process.env.DATADOG_APP_KEY ?? "",
);

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "traces_query",
    description:
      "Query Datadog APM distributed traces for a service to identify errors, latency spikes, or anomalies during an incident window",
    inputSchema: {
      type: "object",
      required: ["service", "from", "to"],
      properties: {
        service: { type: "string", description: "APM service name" },
        env: {
          type: "string",
          description: "Deployment environment (e.g. production, staging)",
          default: "production",
        },
        from: {
          type: "string",
          description: "Start time in ISO 8601 format (e.g. '2024-01-01T00:00:00Z')",
        },
        to: {
          type: "string",
          description: "End time in ISO 8601 format (e.g. '2024-01-01T01:00:00Z')",
        },
        limit: {
          type: "number",
          description: "Max spans to return, grouped into traces (default 25)",
          default: 25,
        },
      },
    },
  },
  {
    name: "traces_query_metrics",
    description: "Query a Datadog metric time-series (e.g. p99 latency, error rate) over a time window",
    inputSchema: {
      type: "object",
      required: ["metric_query", "from", "to"],
      properties: {
        metric_query: {
          type: "string",
          description: "Datadog metric query (e.g. 'avg:trace.web.request.duration{service:api}')",
        },
        from: { type: "number", description: "Start epoch time in seconds" },
        to: { type: "number", description: "End epoch time in seconds" },
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
    const now = Date.now();
    switch (name) {
      case "traces_query":
        return text({
          trace_count: 1,
          error_span_count: 2,
          traces: [{
            trace_id: "mock-trace-001",
            duration_ms: 4800,
            service: args.service ?? "payment-service",
            resource: "POST /charge",
            spans: [
              { span_id: "s1", service: args.service ?? "payment-service", resource: "POST /charge",
                duration_ms: 4800, error: true, error_message: "Connection pool exhausted" },
              { span_id: "s2", service: "postgres", resource: "SELECT payments",
                duration_ms: 4750, error: true, error_message: "too many clients" },
            ],
          }],
        });
      case "traces_query_metrics":
        return text({
          series_count: 1,
          series: [{
            metric: args.metric_query,
            points: [
              { timestamp: now - 60_000, value: 4800 },
              { timestamp: now,          value: 5200 },
            ],
          }],
        });
      default:
        return text({ mock: true, tool: name, status: "ok" });
    }
  }

  switch (name) {
    case "traces_query": {
      const { service, env = "production", from, to, limit = 25 } = args as {
        service: string;
        env?: string;
        from: string;
        to: string;
        limit?: number;
      };
      if (!service || !from || !to) return err("service, from, and to are required");
      const traces = await ddClient.queryTraces(service, env, from, to, limit);
      const errorCount = traces.reduce(
        (acc, t) => acc + t.spans.filter((s) => s.error).length,
        0,
      );
      return text({ trace_count: traces.length, error_span_count: errorCount, traces });
    }

    case "traces_query_metrics": {
      const { metric_query, from, to } = args as {
        metric_query: string;
        from: number;
        to: number;
      };
      if (!metric_query || !from || !to) return err("metric_query, from, and to are required");
      const series = await ddClient.queryMetrics(metric_query, from, to);
      return text({ series_count: series.length, series });
    }

    default:
      return err(`Unknown traces tool: ${name}`);
  }
}
