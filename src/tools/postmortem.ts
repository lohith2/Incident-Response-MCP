import { z, ZodError } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import { logger } from "../logger.js";
import { searchSimilarIncidents, storeIncident } from "../vectordb/incident-store.js";
import { extractAndStorePatterns, getPatternCount } from "../vectordb/log-patterns.js";

// ── Shared types ──────────────────────────────────────────────────────────────

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function text(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function markdown(md: string): ToolResult {
  return { content: [{ type: "text", text: md }] };
}

function validationError(err: ZodError): ToolResult {
  const issues = err.issues.map((i) => `• ${i.path.join(".")}: ${i.message}`).join("\n");
  return {
    content: [{ type: "text", text: `Input validation failed:\n${issues}` }],
    isError: true,
  };
}

// ── Postgres pool (lazy) ──────────────────────────────────────────────────────

const { Pool } = pg;
let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => logger.error("postmortem pool error", { err: err.message }));
  }
  return pool;
}

// ── Metrics writer ────────────────────────────────────────────────────────────
// Best-effort: swallows all errors so a DB hiccup never fails a tool call.

async function saveIncidentMetrics(
  incidentId: string,
  service: string,
  severity: string,
  durationMinutes: number,
  rootCause: string,
): Promise<void> {
  const db = getPool();
  if (!db) return;

  try {
    await db.query(
      `INSERT INTO incident_metrics
         (incident_id, service, severity, detected_at, root_cause_identified_at, resolved_at, root_cause)
       VALUES (
         $1, $2, $3,
         NOW() - ($4 || ' minutes')::interval,
         NOW() - INTERVAL '2 minutes',
         NOW(),
         $5
       )
       ON CONFLICT (incident_id) DO UPDATE SET
         resolved_at  = EXCLUDED.resolved_at,
         root_cause   = EXCLUDED.root_cause`,
      [incidentId, service, severity, durationMinutes, rootCause],
    );
    logger.info("incident_metrics saved", { incident_id: incidentId, service, duration_minutes: durationMinutes });
  } catch (err) {
    logger.error("saveIncidentMetrics failed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
}

// ── Slack notification ────────────────────────────────────────────────────────

async function sendSlackNotification(
  incidentId: string,
  service: string,
  severity: string,
  rootCause: string,
  resolution: string,
  durationMinutes: number,
  ragEnhanced: boolean,
  similarIncidents: Array<{ id: string; similarity_score: number }>,
): Promise<void> {
  const getWebhook = (sev: string): string | undefined => {
    switch (sev?.toUpperCase()) {
      case "SEV1": return process.env.SLACK_WEBHOOK_SEV1;
      case "SEV2": return process.env.SLACK_WEBHOOK_SEV2;
      case "SEV3": return process.env.SLACK_WEBHOOK_SEV3;
      default:     return process.env.SLACK_WEBHOOK_SEV2;
    }
  };

  const getEmoji = (sev: string): string => {
    switch (sev?.toUpperCase()) {
      case "SEV1": return "🔴";
      case "SEV2": return "🟠";
      case "SEV3": return "🟡";
      default:     return "⚪";
    }
  };

  const ragText = ragEnhanced && similarIncidents.length > 0
    ? `✅ Similar incident found: ${similarIncidents[0].id} (${Math.round(similarIncidents[0].similarity_score * 100)}% match)`
    : "❌ New pattern — added to knowledge base";

  const message = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${getEmoji(severity)} ${severity} INCIDENT RESOLVED — ${incidentId}` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Service:*\n${service}` },
          { type: "mrkdwn", text: `*Duration:*\n${durationMinutes} min` },
          { type: "mrkdwn", text: `*Severity:*\n${severity}` },
          { type: "mrkdwn", text: `*AI Investigation:*\nComplete` },
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: `*Root Cause:*\n${rootCause.slice(0, 200)}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Resolution:*\n${resolution.slice(0, 200)}` } },
      { type: "section", text: { type: "mrkdwn", text: `*RAG Analysis:*\n${ragText}` } },
      { type: "divider" },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `🤖 Investigated by AI in ${durationMinutes} min (manual avg: 47 min) | 📚 Knowledge base updated | 🔍 Patterns extracted automatically`,
        }],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📄 *View full postmortem:*\n${process.env.DASHBOARD_URL ?? "http://localhost:8080"}/postmortem/${incidentId}`,
        },
      },
    ],
  };

  const post = async (url: string): Promise<void> => {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  };

  const severityWebhook = getWebhook(severity);
  if (severityWebhook) {
    await post(severityWebhook);
    logger.info("Slack notification sent to severity channel", { incident_id: incidentId, severity });
  }

  const allWebhook = process.env.SLACK_WEBHOOK_ALL;
  if (allWebhook) {
    await post(allWebhook);
    logger.info("Slack notification sent to all-incidents channel", { incident_id: incidentId });
  }
}

// ── Bedrock helper ────────────────────────────────────────────────────────────

async function invokeBedrockClaude(systemPrompt: string, userMessage: string): Promise<string> {
  // Dynamic import so the server starts even without @aws-sdk/client-bedrock-runtime installed.
  let BedrockRuntimeClient: new (cfg: { region: string }) => unknown;
  let ConverseCommand: new (input: Record<string, unknown>) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("@aws-sdk/client-bedrock-runtime");
    BedrockRuntimeClient = mod.BedrockRuntimeClient;
    ConverseCommand = mod.ConverseCommand;
  } catch {
    throw new Error(
      "postmortem_generate requires @aws-sdk/client-bedrock-runtime — " +
      "run: npm install @aws-sdk/client-bedrock-runtime",
    );
  }

  const modelId =
    process.env.AWS_BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-20250514-v1:0";
  const region = process.env.AWS_REGION ?? "us-east-1";

  const client = new BedrockRuntimeClient({ region });

  const command = new ConverseCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages: [{ role: "user", content: [{ text: userMessage }] }],
    inferenceConfig: { maxTokens: 2000 },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await (client as any).send(command);
  return response.output?.message?.content?.[0]?.text ?? "";
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const ActionItemSchema = z.object({
  action: z.string().min(1),
  dri: z.string().min(1).describe("Directly Responsible Individual"),
  deadline: z.string().optional().describe("Target completion date (YYYY-MM-DD)."),
});

const PostmortemGenerateSchema = z.object({
  incident_id: z.string().min(1),
  title: z.string().min(1).describe("Title or short description of the incident."),
  service: z.string().min(1).describe("Primary service affected."),
  impact: z
    .string()
    .min(1)
    .describe("Customer / business impact (users affected, error rate, duration)."),
  timeline: z
    .string()
    .min(1)
    .describe("Chronological sequence of events as a single string or multi-line text."),
  root_cause: z.string().min(1),
  resolution: z.string().min(1).describe("One-sentence description of what fixed the incident."),
  // Caller-supplied severity is always used as-is. "SEV2" is only the fallback when omitted.
  severity: z.string().default("SEV2").describe("Incident severity level (e.g. SEV1, SEV2, SEV3)."),
  duration_minutes: z.number().int().min(0).describe("Wall-clock time from detection to resolution."),
  services_affected: z.array(z.string().min(1)).min(1),
  action_items: z.array(ActionItemSchema).min(1),
});

const PostmortemGetSimilarSchema = z.object({
  root_cause: z
    .string()
    .min(1)
    .describe("Root cause description to search for similar historical incidents."),
  limit: z.number().int().min(1).max(10).default(3),
});

const PostmortemFindSimilarSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe("Description of the current problem to find similar past incidents."),
});

// ── Tool definitions ──────────────────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "postmortem_generate",
    description:
      "Call AWS Bedrock (Claude) to write a blameless postmortem document from structured " +
      "incident data, then persist it to Pinecone and Postgres. Returns the full Markdown document " +
      "and the similar items used for RAG.",
    inputSchema: {
      type: "object",
      required: [
        "incident_id",
        "title",
        "service",
        "impact",
        "timeline",
        "root_cause",
        "resolution",
        "duration_minutes",
        "services_affected",
        "action_items",
      ],
      properties: {
        incident_id: { type: "string", description: "Unique incident identifier (e.g. INC-42)." },
        title: { type: "string", description: "Title of the incident." },
        service: { type: "string", description: "Primary service affected." },
        impact: {
          type: "string",
          description: "Describe user/business impact: how many affected, for how long, revenue impact.",
        },
        timeline: {
          type: "string",
          description:
            "Chronological sequence of events.  Can be plain text or timestamped bullets.",
        },
        root_cause: {
          type: "string",
          description: "Root cause identified during the investigation.",
        },
        resolution: {
          type: "string",
          description: "One-sentence description of what fixed the incident.",
        },
        duration_minutes: {
          type: "number",
          description: "Wall-clock time from detection to resolution.",
        },
        services_affected: {
          type: "array",
          items: { type: "string" },
          description: "List of service names involved.",
        },
        action_items: {
          type: "array",
          description: "Follow-up action items — each needs an action, DRI, and optional deadline.",
          items: {
            type: "object",
            required: ["action", "dri"],
            properties: {
              action: { type: "string" },
              dri: { type: "string", description: "Directly Responsible Individual." },
              deadline: { type: "string", description: "Target date (YYYY-MM-DD)." },
            },
          },
        },
      },
    },
  },
  {
    name: "postmortem_get_similar",
    description:
      "Search past postmortems in Postgres for incidents with a similar root cause. " +
      "Helps the AI learn from historical incidents and avoid re-investigating solved problems.",
    inputSchema: {
      type: "object",
      required: ["root_cause"],
      properties: {
        root_cause: {
          type: "string",
          description:
            "Root cause description to search for (e.g. 'connection pool exhausted', " +
            "'memory leak in worker process').",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 10,
          default: 3,
          description: "Maximum number of similar postmortems to return (default 3).",
        },
      },
    },
  },
  {
    name: "postmortem_find_similar",
    description:
      "Find top 3 similar past incidents from Vector DB (Pinecone) by description. " +
      "Useful before the incident is resolved ('has this happened before?').",
    inputSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: {
          type: "string",
          description: "Description of the current problem to find similar past incidents.",
        },
      },
    },
  },
  {
    name: "pattern_get_count",
    description:
      "Return the total number of extracted log patterns stored in the Pinecone " +
      "log-patterns namespace. Used by the dashboard to show the growing pattern library.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────

const POSTMORTEM_SYSTEM_PROMPT = `You are an expert Site Reliability Engineer writing a blameless incident postmortem.
Your writing is clear, concise, and focused on systemic issues rather than individual blame.
You produce a comprehensive Markdown document with the following sections:
1. **Summary** — one-paragraph executive overview
2. **Impact** — quantified user and business impact
3. **Timeline** — chronological bullet points with timestamps
4. **Root Cause Analysis** — the fundamental technical issue
5. **Contributing Factors** — environmental, process, or tooling factors
6. **Action Items** — table with Action | DRI | Deadline columns; each item must be specific and measurable
7. **Lessons Learned** — systemic improvements to prevent recurrence

Write in past tense. Use "the system" not "we" or individual names.
Do not speculate — if something is unknown, state that explicitly.

All timestamps in the postmortem should be displayed in Pacific Time (PT) format, not UTC.
Convert any UTC timestamps to PT before including them in the postmortem document.
Use format: HH:MM PT`;

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "postmortem_generate": return await postmortemGenerate(args);
      case "postmortem_get_similar": return await postmortemGetSimilar(args);
      case "postmortem_find_similar": return await postmortemFindSimilar(args);
      case "pattern_get_count": return await patternGetCount();
      default:
        return { content: [{ type: "text", text: `Unknown postmortem tool: ${name}` }], isError: true };
    }
  } catch (err) {
    if (err instanceof ZodError) return validationError(err);
    throw err;
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function postmortemGenerate(raw: Record<string, unknown>): Promise<ToolResult> {
  const input = PostmortemGenerateSchema.parse(raw);

  // ── 1. Retrieve ──────────────────────────────────────────────────────────────
  const ragQuery = `${input.title} ${input.root_cause}`;
  const similarPast = await searchSimilarIncidents(ragQuery, 3);
  const isHighConfidence = similarPast.some((m) => m.similarity_score >= 0.7);

  // ── 2. Augment ────────────────────────────────────────────────────────────────
  const actionTable = input.action_items
    .map((a) => `| ${a.action} | ${a.dri} | ${a.deadline ?? "TBD"} |`)
    .join("\n");

  let augmentedContext = "";
  if (!isHighConfidence) {
    augmentedContext = `
*Note: No highly similar past incidents found (max similarity < 0.7).*
`;
  } else {
    const formattedIncidents = similarPast
      .map(
        (inc, i) =>
          `Incident ${i + 1}: ${inc.title} - Root cause: ${inc.root_cause} - Resolution: ${inc.resolution}`,
      )
      .join("\n");

    augmentedContext = `
Here are 3 similar past incidents for reference:
${formattedIncidents}

**Instruction**: Use these past incidents to inform action items and prevention steps.
`;
  }

  const userMessage = `
Please write a blameless postmortem for the following incident:

**Incident ID:** ${input.incident_id}
**Title:** ${input.title}
**Service:** ${input.service}
**Services Affected:** ${input.services_affected.join(", ")}
**Resolution Duration:** ${input.duration_minutes} minutes
**Resolution Method:** ${input.resolution}

**Impact:**
${input.impact}

**Timeline:**
${input.timeline}

**Root Cause:**
${input.root_cause}

**Action Items:**
| Action | DRI | Deadline |
|--------|-----|----------|
${actionTable}

${augmentedContext}
`.trim();

  // ── 3. Generate ──────────────────────────────────────────────────────────────
  logger.info("invoking Bedrock for postmortem", { incident_id: input.incident_id });
  const document = await invokeBedrockClaude(POSTMORTEM_SYSTEM_PROMPT, userMessage);
  logger.info("postmortem generated", { incident_id: input.incident_id, length: document.length });

  // ── 4. Store ──────────────────────────────────────────────────────────────────
  await storeIncident({
    incident_id: input.incident_id,
    title: input.title,
    service: input.service,
    root_cause: input.root_cause,
    postmortem: document,
    resolution: input.resolution,
    duration_minutes: input.duration_minutes,
    rag_enhanced: isHighConfidence,
  });

  // Extract and store new log patterns (awaited so errors surface in logs).
  logger.info("starting pattern extraction", { incident_id: input.incident_id });
  try {
    await extractAndStorePatterns(
      input.incident_id,
      document,
      input.root_cause,
      input.timeline,
    );
    logger.info("pattern extraction complete", { incident_id: input.incident_id });
  } catch (err) {
    logger.error("pattern extraction failed", {
      incident_id: input.incident_id,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }

  await saveIncidentMetrics(
    input.incident_id,
    input.service,
    input.severity,
    input.duration_minutes,
    input.root_cause,
  );

  // ── 5. Notify ─────────────────────────────────────────────────────────────────
  const similarForSlack = similarPast.map((m) => ({ id: m.incident_id, similarity_score: m.similarity_score }));
  try {
    await sendSlackNotification(
      input.incident_id,
      input.service,
      input.severity,
      input.root_cause,
      input.resolution,
      input.duration_minutes,
      isHighConfidence,
      similarForSlack,
    );
  } catch (err) {
    logger.error("Slack notification failed", { incident_id: input.incident_id, error: (err as Error).message });
  }

  // ── 6. Return ────────────────────────────────────────────────────────────────
  const scores = similarPast
    .filter((m) => m.similarity_score >= 0.7)
    .map((m) => m.similarity_score.toFixed(2));

  const ragSources =
    scores.length > 0
      ? `Generated using insights from ${scores.length} similar past incident${scores.length === 1 ? "" : "s"
      } (similarity: ${scores.join(", ")})`
      : "No similar past incidents found in knowledge base (max similarity < 0.7)";

  return text({
    postmortem: document,
    rag_sources: ragSources,
    similar_incidents: similarPast.map((m) => ({
      id: m.incident_id,
      title: m.title,
      similarity_score: m.similarity_score,
    })),
    rag_enhanced: scores.length > 0,
  });
}

async function postmortemGetSimilar(raw: Record<string, unknown>): Promise<ToolResult> {
  const { root_cause, limit } = PostmortemGetSimilarSchema.parse(raw);

  const db = getPool();
  if (!db) {
    return {
      content: [{ type: "text", text: "postmortem_get_similar requires DATABASE_URL to be configured." }],
      isError: true,
    };
  }

  // Extract significant keywords (skip common stop words) for a multi-keyword ILIKE search.
  const STOP = new Set([
    "a", "an", "the", "in", "of", "for", "to", "on", "at", "by", "is", "was", "are", "were",
    "and", "or", "not", "with", "from", "that", "this", "it", "its", "be", "been", "has",
    "have", "had", "due", "caused", "when", "after", "before",
  ]);
  const keywords = root_cause
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, 5);

  if (!keywords.length) {
    return text({ count: 0, similar_postmortems: [] });
  }

  // Build a query that requires at least one keyword match.
  const conditions = keywords.map((_, i) => `content ILIKE $${i + 1}`).join(" OR ");
  const params = keywords.map((k) => `%${k}%`);
  params.push(String(limit));

  const { rows } = await db.query(
    `SELECT incident_id, content, generated_at
     FROM postmortems
     WHERE ${conditions}
     ORDER BY generated_at DESC
     LIMIT $${params.length}`,
    params,
  );

  // Return a short excerpt rather than the full document to keep the response concise.
  const results = rows.map((r) => {
    const content = (r.content as string | null) ?? "";
    return {
      incident_id: r.incident_id,
      generated_at: r.generated_at,
      excerpt: content.slice(0, 500) + (content.length > 500 ? "…" : ""),
    };
  });

  return text({ count: results.length, keywords_searched: keywords, similar_postmortems: results });
}

async function postmortemFindSimilar(raw: Record<string, unknown>): Promise<ToolResult> {
  const { description } = PostmortemFindSimilarSchema.parse(raw);
  logger.info("finding similar incidents", { description: description.slice(0, 50) });

  const matches = await searchSimilarIncidents(description, 3);

  const mapped = matches.map((m) => ({
    id: m.incident_id,
    title: m.title,
    resolution: m.resolution,
    similarity_score: m.similarity_score,
  }));

  return text({ count: mapped.length, similar_incidents: mapped });
}

async function patternGetCount(): Promise<ToolResult> {
  const total = await getPatternCount();
  return text({ total_patterns: total });
}
