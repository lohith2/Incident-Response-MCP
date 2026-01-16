#!/usr/bin/env tsx
/**
 * Seed script — loads 10 realistic historical incidents into Pinecone
 * so that the vector similarity search has data to work with from day one.
 *
 * Run:
 *   npm run seed
 *   # or directly:
 *   npx tsx scripts/seed-incidents.ts
 *
 * Requirements:
 *   PINECONE_API_KEY, AWS credentials (for Bedrock Titan embeddings),
 *   and optionally DATABASE_URL (Postgres writes are best-effort).
 */

import "dotenv/config";
import { Pinecone } from "@pinecone-database/pinecone";
import { storeIncident, type IncidentRecord } from "../src/vectordb/incident-store.js";
import { storeLogPattern, type LogPatternRecord } from "../src/vectordb/log-patterns.js";

// ── Seed data ────────────────────────────────────────────────────────────────

const INCIDENTS: IncidentRecord[] = [
  // ── 1. DB connection pool exhausted ────────────────────────────────────────
  {
    incident_id: "INC-001",
    title: "Payment service DB connection pool exhausted",
    service: "payment-service",
    root_cause: "A deploy of payment-service v4.2.1 changed the default pg pool size from 20 to 5. " +
      "Under normal Black Friday traffic the pool was saturated within 90 seconds, " +
      "causing all new requests to queue and eventually time out.",
    resolution: "Rolled back to v4.2.0 via a one-line deploy. Pool size restored to 20. " +
      "Traffic recovered within 4 minutes of rollback completion.",
    duration_minutes: 38,
    postmortem: `# Postmortem INC-001 — Payment DB Pool Exhaustion

## Summary
A misconfigured connection pool size shipped in payment-service v4.2.1 caused all database
connections to be exhausted 90 seconds after the deploy, resulting in a complete payment
outage lasting 38 minutes on Black Friday.

## Impact
- 100% of checkout requests failed for 38 minutes.
- Estimated $140,000 revenue impact.
- 22,000 customers received error pages at checkout.

## Timeline
- 14:02 UTC: payment-service v4.2.1 deployed to production.
- 14:03 UTC: First connection-pool-exhausted errors in logs.
- 14:05 UTC: PagerDuty SEV1 alert fired on payment error rate > 50%.
- 14:08 UTC: On-call engineer paged, began investigation.
- 14:18 UTC: Root cause identified via pg pool metrics in Datadog.
- 14:28 UTC: Rollback initiated.
- 14:40 UTC: Traffic fully recovered.

## Root Cause Analysis
The pool size constant was changed from 20 to 5 in a refactor that intended to reduce
idle connections in staging, but the change was accidentally included in the production build.

## Contributing Factors
- No automated check on pg pool size in CI.
- Staging traffic is 50× lower than production, so the bug was not caught in staging.
- Deploy did not include a canary phase.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Add pool-size diff alert to deploy pipeline | platform-team | 1 week |
| Enforce canary deploys for payment-service | sre-team | 2 weeks |
| Add pg_pool_size to Datadog dashboard | backend-team | 3 days |

## Lessons Learned
Config values that differ between environments must be explicitly environment-scoped.
A 5-minute canary would have caught this before full rollout.`,
    rag_enhanced: false
  },

  // ── 2. Memory leak in Node.js service ──────────────────────────────────────
  {
    incident_id: "INC-002",
    title: "Auth service OOM crash loop from unclosed event listeners",
    service: "auth-service",
    root_cause: "A new middleware added to auth-service v2.8.0 registered an 'error' event listener " +
      "on the request object inside a hot code path but never removed it. " +
      "After 6 hours of traffic the listener count per process reached Node's default limit " +
      "of 10, emitting MaxListenersExceededWarning, and heap grew at ~50 MB/h until OOM.",
    resolution: "Identified the leaking middleware via heapdump analysis. " +
      "Added emitter.removeListener() calls. Deployed v2.8.1 with the fix.",
    duration_minutes: 95,
    postmortem: `# Postmortem INC-002 — Auth Service Memory Leak

## Summary
An unclosed Node.js event listener introduced in auth-service v2.8.0 caused a slow
memory leak that triggered OOM restarts every ~6 hours over a 4-day period before the
root cause was identified.

## Impact
- Auth service restarted 7 times over 4 days, causing 30–90 s of auth unavailability each time.
- ~3% of login attempts failed during restart windows.

## Timeline
- Day 0 08:00: v2.8.0 deployed.
- Day 1 02:15: First OOM restart. Treated as transient.
- Day 2 08:30: Second OOM restart. Memory growth pattern noticed in Datadog.
- Day 4 14:00: Heap dump captured before OOM. Root cause identified.
- Day 4 16:35: v2.8.1 deployed. Memory stable since.

## Root Cause Analysis
The JWT verification middleware called \`req.on('error', handler)\` on every request
without calling \`req.removeListener\` after resolution. Node.js EventEmitter retains
all registered listeners, causing the heap to grow proportionally to request volume.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Add heap memory alert at 80% of container limit | sre-team | 2 days |
| Lint rule: require removeListener paired with on() | backend-team | 1 week |
| Schedule weekly heapdump review for long-running services | platform-team | 1 month |`,
    rag_enhanced: false
  },

  // ── 3. Redis cache stampede ─────────────────────────────────────────────────
  {
    incident_id: "INC-003",
    title: "Recommendation engine cache stampede after mass TTL expiry",
    service: "recommendation-service",
    root_cause: "All recommendation cache keys were set with an identical 3600-second TTL during a " +
      "cache warm-up job that ran at 00:00 UTC. Exactly 1 hour later every key expired " +
      "simultaneously. The surge of cache misses sent 8,000 concurrent queries to the " +
      "underlying ML scoring service, which fell over under the load.",
    resolution: "Deployed a jittered TTL (3600 ± 600 s). Restarted the ML scoring service. " +
      "Added circuit-breaker with stale-while-revalidate to prevent future stampedes.",
    duration_minutes: 22,
    postmortem: `# Postmortem INC-003 — Cache Stampede

## Summary
A thundering herd of simultaneous cache misses overwhelmed the ML scoring backend,
causing recommendation failures for 22 minutes at 01:00 UTC.

## Impact
- Recommendation widget returned empty results for 22 minutes.
- No revenue impact quantified (recommendations are non-blocking).
- ML scoring service CPU spiked to 100% and became unresponsive.

## Root Cause Analysis
Cache warm-up used a fixed TTL, meaning all keys expired at the same wall-clock time.
The fix is jitter: \`TTL = base + random(-jitter, jitter)\`.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Enforce jittered TTL in cache library wrapper | backend-team | 3 days |
| Add stale-while-revalidate to recommendation cache | backend-team | 1 week |
| Alert on cache hit-rate drop > 20% in 5 min window | sre-team | 2 days |`,
    rag_enhanced: false
  },

  // ── 4. Third-party API timeout cascade ─────────────────────────────────────
  {
    incident_id: "INC-004",
    title: "SMS notification cascade timeout from Twilio degradation",
    service: "notification-service",
    root_cause: "Twilio's SMS API entered a partial degradation with p99 response times exceeding 45 s. " +
      "The notification-service had no per-request timeout configured for outbound HTTP calls, " +
      "so worker threads blocked indefinitely. Within 10 minutes the thread pool was saturated " +
      "and the service stopped processing any notifications including email and push.",
    resolution: "Added a 10-second HTTP timeout for all outbound vendor API calls. " +
      "Deployed vendor-specific circuit breakers. Notifications self-recovered after deploy.",
    duration_minutes: 47,
    postmortem: `# Postmortem INC-004 — Third-Party Timeout Cascade

## Summary
Missing HTTP timeouts on outbound Twilio calls allowed a Twilio degradation to cascade
into a full notification-service outage lasting 47 minutes.

## Impact
- All notification channels (SMS, email, push) failed for 47 minutes.
- Password reset and 2FA flows were completely blocked.
- ~8,000 notifications queued and delivered after recovery.

## Root Cause Analysis
The \`axios\` instance used for vendor calls had no \`timeout\` set.
Default Node.js behavior: no timeout — sockets block until the OS TCP timeout (~120 s).
Solution: always set a tight per-vendor timeout and implement exponential retry with circuit-breaker.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Mandate timeout on all outbound HTTP clients (lint rule) | platform-team | 1 week |
| Implement circuit-breaker per vendor | backend-team | 2 weeks |
| Subscribe to Twilio status-page webhook | infra-team | 2 days |`,
    rag_enhanced: false
  },

  // ── 5. DNS resolution failure ───────────────────────────────────────────────
  {
    incident_id: "INC-005",
    title: "Order service unable to resolve internal RDS hostname after Route 53 change",
    service: "order-service",
    root_cause: "A Route 53 private hosted zone record for the RDS cluster CNAME was deleted " +
      "during a Terraform refactor that replaced individual resource records with a module. " +
      "The module created a new record with a 5-minute TTL but the deletion happened before " +
      "propagation, leaving a 6-minute window where DNS resolution returned NXDOMAIN.",
    resolution: "Re-created the missing Route 53 CNAME. Confirmed resolution from all AZs. " +
      "Order service reconnected automatically on next connection attempt.",
    duration_minutes: 14,
    postmortem: `# Postmortem INC-005 — DNS Resolution Failure

## Summary
A Terraform apply deleted and re-created a Route 53 CNAME record for the production
RDS cluster, creating a 14-minute window where order-service could not resolve the
database hostname.

## Impact
- 100% of order creation and lookup requests failed for 14 minutes.
- ~900 orders could not be placed.
- No data loss — all transactions were client-side retry-safe.

## Root Cause Analysis
Terraform's plan showed a destroy + create for the record, but the operator did not
recognise this as a risk because the final state appeared identical. The short propagation
gap caused NXDOMAIN responses to be cached by application-level DNS resolvers.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Add destroy-protection to production DNS records in Terraform | infra-team | 1 week |
| Require explicit approval for any Route 53 destroy in CI | platform-team | 1 week |
| Add DNS resolution smoke test to deploy healthcheck | sre-team | 2 weeks |`,
    rag_enhanced: false
  },

  // ── 6. Certificate expiry ───────────────────────────────────────────────────
  {
    incident_id: "INC-006",
    title: "mTLS certificate expiry broke service-to-service auth between gateway and API",
    service: "api-gateway",
    root_cause: "The mutual TLS client certificate used by api-gateway to authenticate to the internal " +
      "api-core service expired at 03:14 UTC. Certificate rotation was a manual process with " +
      "no automated expiry alert. The certificate had been valid for 1 year and the rotation " +
      "was simply missed.",
    resolution: "Issued a new 2-year certificate, deployed to api-gateway secret store. " +
      "Automated cert-manager to rotate 30 days before expiry.",
    duration_minutes: 73,
    postmortem: `# Postmortem INC-006 — Certificate Expiry

## Summary
A manually managed mTLS certificate expired at 03:14 UTC, causing all traffic through
the API gateway to return 401 Unauthorized for 73 minutes until the on-call engineer
was paged, diagnosed the issue, and deployed a renewed certificate.

## Impact
- 100% of API traffic failed with 401 errors for 73 minutes.
- Mobile app and web frontend were completely non-functional.
- Estimated $280,000 revenue impact.

## Root Cause Analysis
Certificate lifecycle management was entirely manual with no automation or alerting.
The previous rotation was documented in a Confluence page that no one monitored.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Deploy cert-manager with automatic rotation 30 days before expiry | infra-team | 1 week |
| Alert when any cert has < 30 days remaining | sre-team | 3 days |
| Audit all service-to-service certificates for expiry dates | security-team | 2 days |`,
    rag_enhanced: false
  },

  // ── 7. Disk space exhaustion ────────────────────────────────────────────────
  {
    incident_id: "INC-007",
    title: "Log aggregator disk full — log pipeline stopped ingesting",
    service: "log-aggregation",
    root_cause: "A misconfigured log rotation policy on the Fluent Bit log aggregation nodes " +
      "set maxSize to 50 GB but the nodes only had 40 GB of disk. " +
      "A verbose-logging deployment of the search service three days prior " +
      "accelerated disk fill. At 97% full, Fluent Bit stopped writing new logs " +
      "from all services.",
    resolution: "Deleted 7-day-old compressed log archives to recover 15 GB. " +
      "Corrected maxSize to 30 GB. Increased instance disk to 100 GB via Terraform.",
    duration_minutes: 58,
    postmortem: `# Postmortem INC-007 — Disk Space Exhaustion

## Summary
Misconfigured log rotation combined with a verbose-logging service caused the log
aggregation cluster's disk to fill completely, silently dropping logs from all services
for 58 minutes.

## Impact
- All application logs were dropped for 58 minutes (no data loss to customers).
- On-call had no log visibility during an unrelated auth incident, severely hampering diagnosis.
- Log gap caused 2-hour delay in a separate postmortem investigation.

## Root Cause Analysis
The maxSize in Fluent Bit config was set to 50 GB on a 40 GB disk.
The search-service verbose logging introduced in a deploy 3 days prior went undetected
because there was no disk-fill rate alerting.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Alert when disk utilisation exceeds 70% on log nodes | sre-team | 1 day |
| Validate maxSize against actual disk in Terraform module | infra-team | 1 week |
| Require log-level PR review approval for production deploys | platform-team | 2 weeks |`,
    rag_enhanced: false
  },

  // ── 8. CPU spike from infinite loop ────────────────────────────────────────
  {
    incident_id: "INC-008",
    title: "Data pipeline CPU 100% from recursive transform bug on malformed input",
    service: "data-pipeline",
    root_cause: "A new JSON transform function in data-pipeline v3.1.0 handled circular references " +
      "by recursing without a visited-set guard. A malformed event from a third-party webhook " +
      "containing a circular JSON structure triggered an infinite recursion, consuming 100% " +
      "of all 4 vCPUs and causing the process to become unresponsive.",
    resolution: "Added a visited-set guard to the transform function. Deployed v3.1.1. " +
      "Added input schema validation at the webhook ingestion boundary to reject malformed events.",
    duration_minutes: 31,
    postmortem: `# Postmortem INC-008 — Infinite Loop CPU Spike

## Summary
A recursive JSON transform function without a cycle guard entered an infinite loop
when processing a malformed webhook event with circular references, consuming 100% CPU
and making the data pipeline unresponsive for 31 minutes.

## Impact
- Data pipeline stopped processing events for 31 minutes.
- ~18,000 events queued in SQS; all delivered after recovery.
- No data loss due to SQS at-least-once delivery.

## Root Cause Analysis
Recursive algorithms on untrusted input must always include a cycle-detection mechanism.
The function was tested against valid inputs only; no fuzz testing was performed.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Add cycle detection to all recursive data transformers | backend-team | 1 week |
| Implement JSON schema validation at all external ingestion boundaries | backend-team | 2 weeks |
| Add fuzz testing to CI for data transform functions | platform-team | 3 weeks |`,
    rag_enhanced: false
  },

  // ── 9. Race condition in payment processing ─────────────────────────────────
  {
    incident_id: "INC-009",
    title: "Double-charge race condition in payment-service concurrent checkout",
    service: "payment-service",
    root_cause: "Two simultaneous checkout requests for the same cart ID, caused by a client-side " +
      "double-tap on the mobile checkout button, both passed the idempotency check before " +
      "either had committed the order record. The check-then-act was not atomic — the " +
      "idempotency key lookup and the charge were not wrapped in a database transaction " +
      "with a unique constraint on the idempotency key.",
    resolution: "Added a database-level UNIQUE constraint on the idempotency_key column of the " +
      "charges table. Wrapped the check+charge in a serializable transaction. " +
      "Issued refunds to 7 affected customers.",
    duration_minutes: 210,
    postmortem: `# Postmortem INC-009 — Payment Double-Charge Race Condition

## Summary
A race condition in the payment checkout flow allowed 7 customers to be charged twice
for the same order due to a non-atomic idempotency check. The bug existed for 3 weeks
before being reported by customers.

## Impact
- 7 customers double-charged (total $1,240 in erroneous charges).
- All 7 refunded within 4 hours of discovery.
- Reputational impact from customer complaints.

## Root Cause Analysis
Idempotency checks must be enforced at the database level with a UNIQUE constraint,
not only in application code. Application-level checks have an inherent TOCTOU window.
The serializable isolation level or INSERT ... ON CONFLICT DO NOTHING must be used.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Add UNIQUE constraint on idempotency_key in charges table | backend-team | immediate |
| Wrap all charge operations in serializable transactions | backend-team | 1 week |
| Add duplicate-charge monitoring alert | sre-team | 3 days |
| Pen-test all payment flows for race conditions | security-team | 1 month |`,
    rag_enhanced: false
  },

  // ── 10. Config change broke authentication ─────────────────────────────────
  {
    incident_id: "INC-010",
    title: "JWT secret rotation broke all session validation across services",
    service: "auth-service",
    root_cause: "A security team rotation of the JWT signing secret updated the secret in AWS Secrets " +
      "Manager but the auth-service and three downstream services cached the old secret in " +
      "memory at startup. Only auth-service was restarted after the rotation; the downstream " +
      "services continued validating tokens signed with the new secret against the old cached " +
      "secret, rejecting all authenticated requests with 401.",
    resolution: "Restarted all services that consume the JWT secret. " +
      "Implemented dynamic secret reload via AWS Secrets Manager rotation hook + SIGHUP handler " +
      "so future rotations do not require restarts.",
    duration_minutes: 52,
    postmortem: `# Postmortem INC-010 — JWT Secret Rotation Auth Breakage

## Summary
A JWT signing secret was rotated in AWS Secrets Manager but only auth-service was
restarted. Three downstream services continued using the cached old secret, rejecting
all authenticated API requests with 401 for 52 minutes.

## Impact
- 100% of authenticated API requests returned 401 for 52 minutes.
- All logged-in users were effectively logged out.
- ~45,000 user sessions invalidated.

## Root Cause Analysis
Secret rotation runbooks must enumerate every consumer of the secret and coordinate
restarts. The runbook listed only auth-service, not the three downstream validators.
The fix is dynamic reload: services should re-fetch the secret on rotation without requiring
a restart, using the Secrets Manager rotation event.

## Action Items
| Action | DRI | Deadline |
|--------|-----|----------|
| Implement SIGHUP-triggered secret reload in all JWT consumers | backend-team | 2 weeks |
| Update rotation runbook to list all secret consumers | security-team | 1 day |
| Add integration test: rotate secret → verify all services still accept new tokens | platform-team | 3 weeks |
| Use AWS Secrets Manager rotation hook to trigger reload via SNS | infra-team | 2 weeks |`,
    rag_enhanced: false
  },
];

// ── Log Pattern Seed Data ─────────────────────────────────────────────────────

const LOG_PATTERNS: LogPatternRecord[] = [
  {
    error_message: "Connection pool exhausted",
    service: "database-client",
    root_cause: "pool size too small for current traffic volume",
    fix_applied: "increase pool size or add connection retry mechanism with backoff",
    occurrence_count: 145,
  },
  {
    error_message: "ECONNREFUSED",
    service: "network-client",
    root_cause: "downstream service is down or rejecting connections",
    fix_applied: "check downstream service health and implement a circuit breaker",
    occurrence_count: 312,
  },
  {
    error_message: "Out of memory",
    service: "application-runtime",
    root_cause: "memory leak or insufficient container memory limits",
    fix_applied: "take heap dump for analysis, perform rolling restart, and increase memory limits if necessary",
    occurrence_count: 45,
  },
  {
    error_message: "ETIMEDOUT",
    service: "network-client",
    root_cause: "network latency or overloaded downstream service",
    fix_applied: "increase timeout threshold temporarily and add retry logic",
    occurrence_count: 512,
  },
  {
    error_message: "MaxListenersExceededWarning",
    service: "event-emitter",
    root_cause: "event listeners are being added but never removed (memory leak)",
    fix_applied: "ensure all .on() calls have matching .removeListener() calls in the lifecycle",
    occurrence_count: 88,
  },
  {
    error_message: "Cannot read properties of undefined (reading 'id')",
    service: "api-handler",
    root_cause: "missing null check before accessing nested object properties",
    fix_applied: "add optional chaining (?.) or explicit null checks before access",
    occurrence_count: 230,
  },
  {
    error_message: "Invalid signature",
    service: "auth-service",
    root_cause: "JWT secret was rotated or token is malformed",
    fix_applied: "ensure all services are using the latest JWT secret to verify tokens",
    occurrence_count: 120,
  },
  {
    error_message: "Too Many Requests",
    service: "rate-limiter",
    root_cause: "client exceeded rate limits or sudden traffic spike",
    fix_applied: "implement backoff on the client or adjust rate limits if traffic is legitimate",
    occurrence_count: 840,
  },
  {
    error_message: "Deadlock found when trying to get lock",
    service: "database",
    root_cause: "concurrent transactions accessing resources in different orders",
    fix_applied: "ensure all transactions acquire row locks in a deterministic order",
    occurrence_count: 34,
  },
  {
    error_message: "Disk space exhausted",
    service: "log-aggregator",
    root_cause: "log rotation is misconfigured or disk size is too small",
    fix_applied: "delete old logs, configure proper log rotation (maxSize), and increase disk space",
    occurrence_count: 12,
  },
  {
    error_message: "Failed to resolve hostname",
    service: "dns-resolver",
    root_cause: "DNS record was deleted or DNS server is unreachable",
    fix_applied: "verify Route 53 or internal DNS records and ensure propagation is complete",
    occurrence_count: 55,
  },
  {
    error_message: "No space left on device",
    service: "storage",
    root_cause: "container or host disk is 100% full",
    fix_applied: "clear /tmp, prune docker images, or expand the EBS volume",
    occurrence_count: 28,
  },
  {
    error_message: "Certificate has expired",
    service: "api-gateway",
    root_cause: "mTLS or TLS certificate crossed its expiration date",
    fix_applied: "renew certificate and deploy automated rotation (e.g., cert-manager)",
    occurrence_count: 4,
  },
  {
    error_message: "Payload Too Large",
    service: "web-server",
    root_cause: "client sent a request body exceeding the configured maximum size",
    fix_applied: "increase body-parser limit or reject overly large requests at the edge",
    occurrence_count: 105,
  },
  {
    error_message: "Query execution timeout",
    service: "database",
    root_cause: "missing database index or heavily locked table",
    fix_applied: "run EXPLAIN to identify missing index, add the index, or optimize the query",
    occurrence_count: 210,
  },
  {
    error_message: "502 Bad Gateway",
    service: "load-balancer",
    root_cause: "upstream service crashed, is restarting, or has no healthy instances",
    fix_applied: "check upstream service health, scale up replicas, or review crash logs",
    occurrence_count: 430,
  },
  {
    error_message: "504 Gateway Timeout",
    service: "load-balancer",
    root_cause: "upstream service is taking too long to respond",
    fix_applied: "optimize upstream performance or increase load balancer timeout settings",
    occurrence_count: 390,
  },
  {
    error_message: "Invalid JSON payload",
    service: "api-gateway",
    root_cause: "client sent malformed JSON in request body",
    fix_applied: "add schema validation middleware to return a clean 400 Bad Request error",
    occurrence_count: 670,
  },
  {
    error_message: "Redis connection lost",
    service: "cache",
    root_cause: "Redis server restarted, network partition, or max connections reached",
    fix_applied: "ensure Redis client has auto-reconnect enabled and check Redis metrics",
    occurrence_count: 145,
  },
  {
    error_message: "Maximum call stack size exceeded",
    service: "application-runtime",
    root_cause: "infinite recursion without a base case or cycle detection",
    fix_applied: "add cycle detection logic to recursive functions and limit recursion depth",
    occurrence_count: 22,
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function seed() {
  console.log("\n" + "═".repeat(60));
  console.log("  Incident Vector Store — Seed Script");
  console.log("═".repeat(60) + "\n");

  // ── Pre-flight: check existing counts and skip if already seeded ─────────────
  let seedIncidents = true;
  let seedPatterns = true;

  const apiKey = process.env.PINECONE_API_KEY;
  if (apiKey) {
    try {
      const pc = new Pinecone({ apiKey });
      const index = pc.index(process.env.PINECONE_INDEX_NAME ?? "incident-postmortems");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stats = await index.describeIndexStats() as any;

      const incidentCount: number =
        stats.namespaces?.["__default__"]?.recordCount ??
        stats.namespaces?.[""]?.recordCount ?? 0;

      const patternCount: number =
        stats.namespaces?.["log-patterns"]?.recordCount ?? 0;

      console.log(`  Current counts — incidents: ${incidentCount}, patterns: ${patternCount}\n`);

      if (incidentCount >= 10) {
        console.log(`  ℹ Incidents already seeded (${incidentCount} found, threshold 10) — skipping`);
        seedIncidents = false;
      }

      if (patternCount >= 20) {
        console.log(`  ℹ Patterns already seeded (${patternCount} found, threshold 20) — skipping`);
        seedPatterns = false;
      }
    } catch (err) {
      console.log(`  ⚠ Could not read Pinecone stats: ${(err as Error).message} — proceeding with seed\n`);
    }
  } else {
    console.log("  ⚠ PINECONE_API_KEY not set — proceeding without pre-flight check\n");
  }

  // ── Seed incidents ────────────────────────────────────────────────────────────
  let succeeded = 0;
  let failed = 0;

  if (seedIncidents) {
    console.log(`\n  Seeding ${INCIDENTS.length} incidents…\n`);

    for (const incident of INCIDENTS) {
      process.stdout.write(`  [${incident.incident_id}] ${incident.title.slice(0, 55)}… `);
      try {
        await storeIncident(incident);
        console.log("✓");
        succeeded++;
      } catch (err) {
        console.log(`✗  ${(err as Error).message}`);
        failed++;
      }

      // Brief pause between calls to respect Bedrock and Pinecone rate limits.
      if (succeeded + failed < INCIDENTS.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  // ── Seed log patterns ─────────────────────────────────────────────────────────
  let patternSucceeded = 0;
  let patternFailed = 0;

  if (seedPatterns) {
    console.log(`\n  Seeding ${LOG_PATTERNS.length} log patterns…\n`);

    for (const pattern of LOG_PATTERNS) {
      process.stdout.write(`  [PATTERN] ${pattern.error_message.slice(0, 55)}… `);
      try {
        await storeLogPattern(pattern as any);
        console.log("✓");
        patternSucceeded++;
      } catch (err) {
        console.log(`✗  ${(err as Error).message}`);
        patternFailed++;
      }

      if (patternSucceeded + patternFailed < LOG_PATTERNS.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  if (seedIncidents) console.log(`  Incidents: ${succeeded} seeded, ${failed} failed`);
  else console.log(`  Incidents: skipped (already seeded)`);
  if (seedPatterns) console.log(`  Patterns:  ${patternSucceeded} seeded, ${patternFailed} failed`);
  else console.log(`  Patterns:  skipped (already seeded)`);
  console.log("─".repeat(60) + "\n");

  if (failed > 0 || patternFailed > 0) process.exit(1);
}

seed().catch((err) => {
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
});
