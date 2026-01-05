import { z, ZodError } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { PagerDutyClient } from "../integrations/pagerduty.js";
import * as cache from "../cache/redis.js";
import { mockAlerts } from "../mocks/incident.js";

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

function runtimeError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ── PagerDuty client (lazy singleton) ─────────────────────────────────────────

let _pd: PagerDutyClient | null = null;

function getPd(): PagerDutyClient {
  if (!_pd) {
    const token = process.env.PAGERDUTY_TOKEN;
    if (!token) throw new Error("PAGERDUTY_TOKEN env var is not set");
    _pd = new PagerDutyClient(token, process.env.PAGERDUTY_FROM_EMAIL);
  }
  return _pd;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const SeverityEnum = z.enum(["critical", "high", "low", "info"]);

const AlertGetActiveSchema = z.object({
  severities: z
    .array(SeverityEnum)
    .optional()
    .describe("Filter by severity level(s). Omit to return all active incidents."),
  service_ids: z
    .array(z.string().min(1))
    .optional()
    .describe("Restrict to specific PagerDuty service IDs."),
  limit: z
    .number()
    .int()
    .min(1, "limit must be at least 1")
    .max(100, "limit cannot exceed 100")
    .default(25),
});

const AlertGetTimelineSchema = z.object({
  incident_id: z.string().min(1, "incident_id must be a non-empty string"),
});

const AlertAcknowledgeSchema = z.object({
  incident_id: z.string().min(1, "incident_id must be a non-empty string"),
  message: z
    .string()
    .min(1, "message must not be empty")
    .max(500, "message must be 500 characters or fewer")
    .describe("Short acknowledgement message attached as a note to the incident."),
});

const AlertGetServiceHealthSchema = z.object({
  include_oncall: z
    .boolean()
    .default(true)
    .describe("Whether to include the current on-call person for each service."),
});

// ── Tool definitions ──────────────────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "alert_get_active",
    description:
      "Fetch currently active (triggered or acknowledged) PagerDuty incidents. " +
      "Results are cached in Redis for 30 seconds to avoid rate-limiting during high-tempo incidents.",
    inputSchema: {
      type: "object",
      properties: {
        severities: {
          type: "array",
          items: { type: "string", enum: ["critical", "high", "low", "info"] },
          description: "Filter to incidents of these severity levels. Omit to return all.",
        },
        service_ids: {
          type: "array",
          items: { type: "string" },
          description: "Restrict to these PagerDuty service IDs.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 100,
          default: 25,
          description: "Maximum number of incidents to return (1–100, default 25).",
        },
      },
    },
  },
  {
    name: "alert_get_timeline",
    description:
      "Return the full chronological event log for a PagerDuty incident — " +
      "assignments, acknowledgements, notes, escalations, and resolving events.",
    inputSchema: {
      type: "object",
      required: ["incident_id"],
      properties: {
        incident_id: {
          type: "string",
          description: "PagerDuty incident ID (e.g. 'Q1234ABCD').",
        },
      },
    },
  },
  {
    name: "alert_acknowledge",
    description:
      "Acknowledge a PagerDuty incident and attach a short explanatory message as a note. " +
      "Requires PAGERDUTY_FROM_EMAIL to be set for account-level API tokens.",
    inputSchema: {
      type: "object",
      required: ["incident_id", "message"],
      properties: {
        incident_id: {
          type: "string",
          description: "PagerDuty incident ID.",
        },
        message: {
          type: "string",
          maxLength: 500,
          description:
            "Acknowledgement note (e.g. 'Investigating high latency — @alice on it').",
        },
      },
    },
  },
  {
    name: "alert_get_service_health",
    description:
      "Return a health summary for every PagerDuty service: active incident counts " +
      "broken down by urgency, overall service status, and (optionally) the current on-call person.",
    inputSchema: {
      type: "object",
      properties: {
        include_oncall: {
          type: "boolean",
          default: true,
          description: "Include the level-1 on-call person for each service (default true).",
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
    switch (name) {
      case "alert_get_active":
        return text({ count: 1, incidents: mockAlerts() });
      case "alert_get_timeline":
        return text({ incident_id: args.incident_id, entry_count: 1, timeline: [
          { type: "notify_log_entry", created_at: new Date().toISOString(), summary: "Mock: incident triggered" },
        ]});
      case "alert_acknowledge":
        return text({ acknowledged: true, incident_id: args.incident_id, new_status: "acknowledged", message: args.message });
      case "alert_get_service_health":
        return text({ service_count: 1, services: [{ id: "MOCK-SVC-1", name: "payment-service", status: "critical",
          active_incidents: { high_urgency: 1, low_urgency: 0, total: 1 }, oncall: "on-call-engineer" }] });
      default:
        return text({ mock: true, tool: name, status: "acknowledged" });
    }
  }

  try {
    switch (name) {
      case "alert_get_active":
        return await alertGetActive(args);
      case "alert_get_timeline":
        return await alertGetTimeline(args);
      case "alert_acknowledge":
        return await alertAcknowledge(args);
      case "alert_get_service_health":
        return await alertGetServiceHealth(args);
      default:
        return runtimeError(`Unknown alerts tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof ZodError) return validationError(err);
    throw err; // let server.ts handle unexpected errors
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function alertGetActive(raw: Record<string, unknown>): Promise<ToolResult> {
  const input = AlertGetActiveSchema.parse(raw);

  // Stable cache key — sort arrays so key is order-independent.
  const cacheKey = `alert:active:${JSON.stringify({
    severities: [...(input.severities ?? [])].sort(),
    service_ids: [...(input.service_ids ?? [])].sort(),
    limit: input.limit,
  })}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as unknown;
    return text({ cached: true, ...((parsed as Record<string, unknown>) ?? {}) });
  }

  const incidents = await getPd().getIncidents({
    statuses: ["triggered", "acknowledged"],
    severities: input.severities,
    serviceIds: input.service_ids,
    limit: input.limit,
  });

  const payload = { cached: false, count: incidents.length, incidents };
  await cache.set(cacheKey, JSON.stringify(payload), 30);
  return text(payload);
}

async function alertGetTimeline(raw: Record<string, unknown>): Promise<ToolResult> {
  const { incident_id } = AlertGetTimelineSchema.parse(raw);
  const entries = await getPd().getIncidentTimeline(incident_id);
  return text({ incident_id, entry_count: entries.length, timeline: entries });
}

async function alertAcknowledge(raw: Record<string, unknown>): Promise<ToolResult> {
  const { incident_id, message } = AlertAcknowledgeSchema.parse(raw);
  const incident = await getPd().acknowledgeIncident(incident_id, message);
  return text({
    acknowledged: true,
    incident_id,
    new_status: incident.status,
    message,
  });
}

async function alertGetServiceHealth(raw: Record<string, unknown>): Promise<ToolResult> {
  const { include_oncall } = AlertGetServiceHealthSchema.parse(raw);
  const pd = getPd();

  // Fan-out: services + active incidents in parallel.
  const [services, activeIncidents] = await Promise.all([
    pd.getServices(),
    pd.getIncidents({ statuses: ["triggered", "acknowledged"], limit: 100 }),
  ]);

  // Map escalation-policy-id → on-call user name (optional extra call).
  const oncallMap = new Map<string, string>();
  if (include_oncall) {
    const policyIds = services.map((s) => s.escalation_policy.id);
    const oncalls = await pd.getOnCalls(policyIds);
    for (const oc of oncalls) {
      // Keep only the first (lowest escalation level 1) entry per policy.
      if (!oncallMap.has(oc.escalation_policy.id)) {
        oncallMap.set(oc.escalation_policy.id, oc.user.summary);
      }
    }
  }

  // Group active incidents by service ID.
  const incidentsByService = new Map<string, { high: number; low: number }>();
  for (const inc of activeIncidents) {
    const sid = inc.service.id;
    if (!incidentsByService.has(sid)) incidentsByService.set(sid, { high: 0, low: 0 });
    const bucket = incidentsByService.get(sid)!;
    if (inc.urgency === "high") bucket.high += 1;
    else bucket.low += 1;
  }

  const summary = services.map((svc) => {
    const counts = incidentsByService.get(svc.id) ?? { high: 0, low: 0 };
    const entry: Record<string, unknown> = {
      id: svc.id,
      name: svc.name,
      status: svc.status,
      active_incidents: { high_urgency: counts.high, low_urgency: counts.low, total: counts.high + counts.low },
    };
    if (include_oncall) {
      entry.oncall = oncallMap.get(svc.escalation_policy.id) ?? null;
    }
    return entry;
  });

  // Sort: services with most high-urgency incidents first.
  summary.sort(
    (a, b) =>
      ((b.active_incidents as { high_urgency: number }).high_urgency) -
      ((a.active_incidents as { high_urgency: number }).high_urgency),
  );

  return text({ service_count: summary.length, services: summary });
}
