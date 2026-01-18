#!/usr/bin/env tsx
/**
 * Incident simulation script — demonstrates the full AI-assisted incident
 * response workflow by calling MCP tools in sequence and generating a postmortem.
 *
 * Run:
 *   npm run simulate
 *   # or directly:
 *   npx tsx scripts/simulate-incident.ts
 *
 * Requirements:
 *   MCP server running on MCP_SERVER_URL (default http://localhost:3000)
 *
 * Note: Tools that require real API credentials (PagerDuty, Datadog, GitHub)
 * fall back to realistic mock data so the simulation always completes.
 */

import "dotenv/config";

const MCP_URL = process.env.MCP_SERVER_URL ?? "http://localhost:3000";

// ── Scenarios ─────────────────────────────────────────────────────────────────

const SCENARIOS = [
  // SEV1 - Critical
  {
    service: "payment-service",
    title: "payment-service: complete checkout failure",
    severity: "SEV1",
    root_cause: "DB connection pool reduced from 50 to 10 causing exhaustion",
    resolution: "Reverted commit a3f9c21, pool restored to 50",
    duration_minutes: 9,
    error_pattern: "connection pool exhausted — all 10 connections in use",
  },
  {
    service: "auth-service",
    title: "auth-service: JWT validation failing globally",
    severity: "SEV1",
    root_cause: "JWT secret rotation not propagated to downstream services",
    resolution: "Restarted all downstream services to pick up new secret",
    duration_minutes: 12,
    error_pattern: "JWT signature verification failed",
  },
  {
    service: "api-gateway",
    title: "api-gateway: all traffic returning 503",
    severity: "SEV1",
    root_cause: "Nginx misconfiguration after cert renewal wiped upstream config",
    resolution: "Restored nginx config from backup and reloaded service",
    duration_minutes: 14,
    error_pattern: "upstream connect error or disconnect/reset before headers",
  },
  {
    service: "payment-service",
    title: "payment-service: double charge race condition",
    severity: "SEV1",
    root_cause: "Non-atomic idempotency check allowing duplicate charges under load",
    resolution: "Deployed hotfix with atomic DB transaction for idempotency check",
    duration_minutes: 18,
    error_pattern: "duplicate key value violates unique constraint idempotency_key",
  },
  {
    service: "user-service",
    title: "user-service: complete login unavailable",
    severity: "SEV1",
    root_cause: "Postgres primary failed over but app still pointing to old primary",
    resolution: "Updated connection string to new primary, service recovered",
    duration_minutes: 11,
    error_pattern: "ECONNREFUSED 5432 — connection to server failed",
  },
  {
    service: "checkout-service",
    title: "checkout-service: orders not persisting",
    severity: "SEV1",
    root_cause: "Kafka producer misconfigured after broker migration, events dropped",
    resolution: "Fixed broker endpoint config, replayed dropped events from DLQ",
    duration_minutes: 22,
    error_pattern: "KafkaProducerException: broker not available at bootstrap endpoint",
  },

  // SEV2 - High
  {
    service: "order-service",
    title: "order-service: memory leak causing OOM crashes",
    severity: "SEV2",
    root_cause: "Unclosed event listeners in order processing loop",
    resolution: "Deployed hotfix closing event listeners on completion",
    duration_minutes: 18,
    error_pattern: "OOMKilled container restarting",
  },
  {
    service: "notification-service",
    title: "notification-service: Redis connection timeout",
    severity: "SEV2",
    root_cause: "Redis maxmemory limit hit, evicting active session keys",
    resolution: "Increased Redis memory limit and flushed stale keys",
    duration_minutes: 15,
    error_pattern: "ETIMEDOUT connecting to Redis",
  },
  {
    service: "inventory-service",
    title: "inventory-service: database deadlock spike",
    severity: "SEV2",
    root_cause: "Missing composite index causing full table scans and deadlocks",
    resolution: "Added index on (product_id, warehouse_id)",
    duration_minutes: 22,
    error_pattern: "deadlock detected on relation inventory",
  },
  {
    service: "search-service",
    title: "search-service: Elasticsearch cluster degraded",
    severity: "SEV2",
    root_cause: "Elasticsearch heap pressure from unoptimized aggregation query",
    resolution: "Killed runaway query, added circuit breaker for heavy aggregations",
    duration_minutes: 20,
    error_pattern: "EsRejectedExecutionException: rejected execution of coordinating operation",
  },
  {
    service: "recommendation-service",
    title: "recommendation-service: high latency spike",
    severity: "SEV2",
    root_cause: "ML model inference timeout after model version mismatch on deploy",
    resolution: "Rolled back model version, latency returned to baseline",
    duration_minutes: 25,
    error_pattern: "ModelInferenceTimeoutError: inference exceeded 5000ms threshold",
  },
  {
    service: "shipping-service",
    title: "shipping-service: address validation failing",
    severity: "SEV2",
    root_cause: "Third party address API key expired, all validations returning 403",
    resolution: "Rotated API key in secrets manager, service recovered",
    duration_minutes: 17,
    error_pattern: "AddressValidationError: upstream returned 403 Forbidden",
  },
  {
    service: "pricing-service",
    title: "pricing-service: stale prices serving",
    severity: "SEV2",
    root_cause: "Redis cache TTL set to 0 after config deploy, prices never refreshing",
    resolution: "Fixed TTL config to 300s, cache warmed up within 5 minutes",
    duration_minutes: 19,
    error_pattern: "CacheWarningStaleRead: TTL=0 detected on pricing key",
  },
  {
    service: "cart-service",
    title: "cart-service: items disappearing from carts",
    severity: "SEV2",
    root_cause: "Session store migration left old keys unreadable by new service version",
    resolution: "Ran migration script to convert old session format, data recovered",
    duration_minutes: 28,
    error_pattern: "SessionDeserializationError: unknown key format version 1",
  },

  // SEV3 - Medium
  {
    service: "email-service",
    title: "email-service: delivery queue backed up",
    severity: "SEV3",
    root_cause: "SMTP rate limit hit after bulk campaign triggered send storm",
    resolution: "Throttled outbound queue to 100/min, backlog cleared in 2 hours",
    duration_minutes: 35,
    error_pattern: "SMTPResponseError: 550 rate limit exceeded — slow down",
  },
  {
    service: "analytics-service",
    title: "analytics-service: dashboard data stale",
    severity: "SEV3",
    root_cause: "Kafka consumer lag spiked after partition rebalance during deploy",
    resolution: "Restarted consumer group, lag cleared within 30 minutes",
    duration_minutes: 40,
    error_pattern: "consumer lag 2.4M messages on analytics-events partition 0",
  },
  {
    service: "cdn-service",
    title: "cdn-service: cache hit rate dropped to 12%",
    severity: "SEV3",
    root_cause: "Cache key misconfiguration after A/B test deployment invalidated all keys",
    resolution: "Fixed cache key generation, hit rate recovered to 94%",
    duration_minutes: 28,
    error_pattern: "CacheMissStorm: hit_rate=0.12 origin requests spiking",
  },
  {
    service: "reporting-service",
    title: "reporting-service: nightly reports not generating",
    severity: "SEV3",
    root_cause: "Cron job timezone misconfigured after daylight saving time change",
    resolution: "Fixed cron schedule to UTC, manually triggered missed reports",
    duration_minutes: 45,
    error_pattern: "CronJobMissed: expected execution at 02:00 UTC never triggered",
  },
  {
    service: "audit-service",
    title: "audit-service: logs ingestion falling behind",
    severity: "SEV3",
    root_cause: "Disk I/O bottleneck after log verbosity increased in last deploy",
    resolution: "Reduced log verbosity back to INFO level, ingestion caught up",
    duration_minutes: 32,
    error_pattern: "IngestionLag: write throughput 12MB/s below required 80MB/s",
  },
  {
    service: "webhook-service",
    title: "webhook-service: delivery retry storm",
    severity: "SEV3",
    root_cause: "Exponential backoff misconfigured, causing thundering herd on retries",
    resolution: "Fixed backoff config with jitter, retry storm subsided",
    duration_minutes: 38,
    error_pattern: "RetryStorm: 48000 webhook deliveries queued simultaneously",
  },
];

// Pick random scenario each run:
const SCENARIO = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];

const INCIDENT = {
  incident_id: `INC-SIM-${Date.now()}`,
  service: SCENARIO.service,
  severity: SCENARIO.severity,
  title: SCENARIO.title,
};

// ── Mock fallbacks (used when real API credentials are absent) ────────────────

const MOCK_ALERTS = JSON.stringify({
  count: 1,
  incidents: [{
    id: "PD-DEMO-001",
    title: SCENARIO.title,
    severity: SCENARIO.severity,
    service: SCENARIO.service,
    status: "triggered",
    created_at: new Date().toISOString(),
  }],
}, null, 2);

const MOCK_LOGS = JSON.stringify({
  count: 47,
  logs: [
    { timestamp: new Date(Date.now() - 120_000).toISOString(), level: "error", message: `${SCENARIO.error_pattern} — request aborted`, status: 500 },
    { timestamp: new Date(Date.now() - 110_000).toISOString(), level: "error", message: `${SCENARIO.error_pattern} — retry 1 of 3`, status: 500 },
    { timestamp: new Date(Date.now() -  90_000).toISOString(), level: "error", message: `Request timeout after 30000ms — ${SCENARIO.service} endpoint`, status: 500 },
    { timestamp: new Date(Date.now() -  60_000).toISOString(), level: "error", message: `${SCENARIO.error_pattern} — circuit breaker open`, status: 500 },
  ],
}, null, 2);

const MOCK_DEPLOY = JSON.stringify({
  found: true,
  deployment: {
    id: "deploy-a3f9c21",
    sha: "a3f9c21b",
    ref: "v4.2.1",
    environment: "production",
    created_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
    description: `${SCENARIO.service} v4.2.1 — ${SCENARIO.root_cause}`,
    creator: "john.doe",
  },
  minutes_before_incident: 8,
}, null, 2);

const MOCK_POSTMORTEM = `# Postmortem ${INCIDENT.incident_id} — ${SCENARIO.title}

## Summary
${SCENARIO.root_cause} in ${SCENARIO.service} caused a ${SCENARIO.severity} incident. The issue
was detected automatically and resolved via the following action: ${SCENARIO.resolution}.
Total time to resolution was approximately 15 minutes.

## Impact
- ${SCENARIO.service} unavailable or degraded for ~15 minutes.
- Estimated 40%+ of requests failed during the window.
- Multiple downstream consumers affected.

## Timeline
- T+0:00  Automated alert fired — ${SCENARIO.title}.
- T+0:02  On-call engineer paged via PagerDuty (${SCENARIO.severity}).
- T+0:05  Log query confirmed error pattern: "${SCENARIO.error_pattern}".
- T+0:08  Git deploy lookup identified culprit commit 8 minutes before incident.
- T+0:12  AI root cause analysis completed. Remediation initiated.
- T+0:15  Service recovered. Error rate returned to baseline.

## Root Cause Analysis
${SCENARIO.root_cause}. Under production load, the issue manifested within minutes
of the triggering change reaching full traffic. The error pattern "${SCENARIO.error_pattern}"
appeared consistently across all affected instances.

## Contributing Factors
- No automated validation of the changed configuration in CI/CD pipeline.
- Staging environment runs at significantly lower traffic, masking the issue pre-deploy.
- No canary rollout — change went directly to 100% of production traffic.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Add automated check for root cause class in CI | platform-team | +7 days |
| Enforce canary deploys for ${SCENARIO.service} | sre-team | +14 days |
| Add alert with burn-rate threshold for ${SCENARIO.service} errors | sre-team | +3 days |

## Lessons Learned
The root cause (${SCENARIO.root_cause}) should have been caught before reaching production.
A canary phase would have contained the blast radius at negligible operational cost.`;

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  fallback?: string,
): Promise<string> {
  try {
    const res = await fetch(`${MCP_URL}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as ToolResult;
    if (body.isError) {
      throw new Error(body.content.map((c) => c.text).join(" "));
    }
    return body.content.map((c) => c.text).join("\n");
  } catch (err) {
    if (fallback !== undefined) {
      console.log(`      ⚠ ${name} unavailable (${(err as Error).message.slice(0, 60)}) — using mock data`);
      return fallback;
    }
    throw err;
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────

const DIVIDER = "=".repeat(56);
const THIN    = "-".repeat(56);

function step(n: number, label: string) {
  console.log(`\n[${n}/4] ${label}…`);
}

function ok(label: string, raw: string) {
  const preview = raw.replace(/\s+/g, " ").trim().slice(0, 80);
  console.log(`      ✓ ${label}: ${preview}${raw.replace(/\s+/g, " ").length > 80 ? "…" : ""}`);
}

// ── Main simulation ───────────────────────────────────────────────────────────

async function simulate() {
  console.log("\n" + DIVIDER);
  console.log("  INCIDENT RESPONSE SIMULATION STARTING");
  console.log(DIVIDER);
  console.log(`  Incident : ${INCIDENT.incident_id}`);
  console.log(`  Service  : ${SCENARIO.service}`);
  console.log(`  Severity : ${SCENARIO.severity}`);
  console.log(`  Title    : ${SCENARIO.title}`);
  console.log(DIVIDER + "\n");

  const startMs = Date.now();

  // ── Step 1: active alerts ──────────────────────────────────────────────────
  step(1, "Fetching active alerts");
  const alertsRaw = await callTool(
    "alert_get_active",
    { severity: SCENARIO.severity.toLowerCase(), limit: 5 },
    MOCK_ALERTS,
  );
  ok("alerts", alertsRaw);

  // ── Step 2: recent error logs ──────────────────────────────────────────────
  step(2, `Querying recent error logs for ${SCENARIO.service}`);
  const logsRaw = await callTool(
    "log_query",
    { service: SCENARIO.service, query: "status:error @http.status_code:500", from_minutes_ago: 30, limit: 20 },
    MOCK_LOGS,
  );
  ok("logs", logsRaw);

  // ── Step 3: deploy before incident ────────────────────────────────────────
  step(3, "Looking up last deploy before incident");
  const repo = process.env.GITHUB_REPO ?? `demo-org/${SCENARIO.service}`;
  const deploysRaw = await callTool(
    "git_get_deploy_before_incident",
    { repo, incident_timestamp: new Date().toISOString(), look_back_hours: 24 },
    MOCK_DEPLOY,
  );
  ok("deploy", deploysRaw);

  // ── Step 4: generate postmortem ───────────────────────────────────────────
  step(4, "Generating AI postmortem via Bedrock");

  const rootCause =
    `${SCENARIO.root_cause} on ${SCENARIO.service} detected after the most recent deploy. ` +
    `Error logs show: "${SCENARIO.error_pattern}". ` +
    `Deploy context: ${deploysRaw.slice(0, 200)}`;

  const postmortemRaw = await callTool("postmortem_generate", {
    incident_id: INCIDENT.incident_id,
    title: INCIDENT.title,
    service: INCIDENT.service,
    severity: INCIDENT.severity,
    impact:
      `${SCENARIO.service} unavailable or severely degraded. ` +
      `Estimated 40%+ of requests failing. Error pattern observed: "${SCENARIO.error_pattern}".`,
    timeline:
      `T+0:00  Automated alert fired — ${SCENARIO.title}.\n` +
      `T+0:02  On-call engineer paged via PagerDuty (${SCENARIO.severity}).\n` +
      `T+0:05  Log query confirmed error pattern: "${SCENARIO.error_pattern}".\n` +
      `T+0:08  Git deploy lookup identified culprit release: ${deploysRaw.slice(0, 100)}\n` +
      `T+0:12  AI root cause analysis completed. Remediation initiated.\n` +
      `T+0:15  Service recovered. Error rate returned to baseline.`,
    root_cause: rootCause,
    resolution: SCENARIO.resolution,
    duration_minutes: SCENARIO.duration_minutes,
    services_affected: [SCENARIO.service],
    action_items: [
      {
        action: `Automate validation to catch: ${SCENARIO.root_cause}`,
        dri: "platform-team",
        deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      },
      {
        action: `Enforce canary deploys for ${SCENARIO.service}`,
        dri: "sre-team",
        deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      },
      {
        action: `Add burn-rate alert for ${SCENARIO.service} error spike`,
        dri: "sre-team",
        deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      },
    ],
  }, MOCK_POSTMORTEM);

  ok("postmortem", postmortemRaw);

  // ── Stop timer ────────────────────────────────────────────────────────────
  const elapsedMs  = Date.now() - startMs;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  const elapsedMin = (elapsedMs / 60000).toFixed(2);

  // ── Extract root cause summary from generated postmortem ─────────────────
  const rcMatch =
    postmortemRaw.match(/##\s*Root Cause[^\n]*\n+([\s\S]*?)(?=\n##|\n---|\n===|$)/) ??
    postmortemRaw.match(/root.cause[:\s]+(.{20,120})/i);
  const rootCauseSummary = rcMatch
    ? rcMatch[1].replace(/\s+/g, " ").trim().slice(0, 120)
    : rootCause.slice(0, 120);

  // ── Results banner ────────────────────────────────────────────────────────
  const baselineMin    = 47;
  const improvementPct = (((baselineMin - parseFloat(elapsedMin)) / baselineMin) * 100).toFixed(0);

  console.log("\n" + DIVIDER);
  console.log("  INCIDENT SIMULATION COMPLETE");
  console.log(DIVIDER);
  console.log(`  Incident              : ${INCIDENT.incident_id}`);
  console.log(`  Service               : ${SCENARIO.service}`);
  console.log(`  Root Cause            : ${rootCauseSummary}`);
  console.log(`  Time taken            : ${elapsedSec} seconds`);
  console.log(THIN);
  console.log(`  Manual MTTR baseline  : 47 minutes`);
  console.log(`  AI-Assisted time      : ${elapsedMin} minutes`);
  console.log(`  Improvement           : ${improvementPct}%`);
  console.log(DIVIDER);

  console.log("\n── GENERATED POSTMORTEM ──────────────────────────────────\n");
  console.log(postmortemRaw);
  console.log("\n" + DIVIDER + "\n");
}

simulate().catch((err) => {
  console.error("\n✗ Simulation failed:", (err as Error).message);
  console.error("  Make sure the MCP server is running on", MCP_URL);
  process.exit(1);
});
