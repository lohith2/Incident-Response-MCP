# Incident Response MCP
> An AI-powered incident response system that connects any MCP-compatible AI client directly to your observability stack — turning hours of manual investigation into minutes of guided root cause analysis.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6.svg)](https://typescriptlang.org)
[![Python](https://img.shields.io/badge/Python-3.11-blue.svg)](https://python.org)
[![LangGraph](https://img.shields.io/badge/LangGraph-0.2-orange.svg)](https://langchain.com)
[![AWS Bedrock](https://img.shields.io/badge/AWS-Bedrock-FF9900.svg)](https://aws.amazon.com/bedrock)

---

## What It Does

When a SEV1 fires at 2am, this system lets an on-call engineer describe the incident in plain English and get back correlated insights from across the entire observability stack — logs, traces, alerts, deploys, and historical incidents — in a single response.

```
Engineer → Any MCP Client → MCP Server → [Datadog · CloudWatch · PagerDuty · Pinecone · PostgreSQL]
                                                  ↓
                                      LangGraph Investigation Pipeline
                                                  ↓
                               Root cause · Remediation · Postmortem · Slack Alert
```

> **Client flexibility**: This demo uses Claude Desktop as the MCP client, but the server is fully compatible with any MCP-compatible client — Cursor, Zed, Continue, or any custom implementation. The MCP server exposes a standard SSE + Streamable HTTP transport.

> **No client needed in production**: When real PagerDuty, Datadog, and GitHub credentials are configured (`USE_MOCK=false`), the LangGraph workflow triggers automatically via webhook — zero human input required until the postmortem is ready for review.

---

## Two Modes

### Mode 1 — Interactive (Demo/Development)
```
Engineer types incident in Claude Desktop (or any MCP client)
        ↓
Claude autonomously calls MCP tools
        ↓
Agentic RAG: Claude decides which tools to call and in what order
        ↓
Postmortem generated → Dashboard updates → Slack notified
```

### Mode 2 — Automatic (Production)
```
PagerDuty webhook fires → POST /trigger-workflow
        ↓
LangGraph pipeline runs automatically:
  fetch alerts → query logs → check deploys → 
  search history → generate postmortem → notify
        ↓
Slack notification fired → Dashboard updated
Zero human input required
```

To enable production mode:
```bash
USE_MOCK=false
PAGERDUTY_TOKEN=your_real_token
DATADOG_API_KEY=your_real_key
GITHUB_TOKEN=your_real_token
```

---

## Architecture

**Three layers working together:**

**1. TypeScript MCP Server** — 19 tools exposed via Model Context Protocol (SSE + Streamable HTTP transport). Any MCP-compatible client can connect. Claude Desktop used for demo purposes.

**2. Python LangGraph Workflow** — Multi-step autonomous investigation pipeline powered by AWS Bedrock. Triggered interactively via MCP client or automatically via PagerDuty webhook.

**3. React Dashboard** — Real-time incident feed, MTTR analytics, RAG intelligence panel, and live Slack routing — all polling live via REST.

---

## MCP Tools (19 total)

| Category | Tools |
|----------|-------|
| Alerts | `alert_get_active`, `alert_get_timeline`, `alert_acknowledge`, `alert_get_service_health` |
| Logs | `log_query`, `log_get_error_spike`, `log_get_metrics`, `log_find_pattern` |
| Git | `git_get_recent_deploys`, `git_get_commit_diff`, `git_find_similar_incidents`, `git_create_incident_issue`, `git_get_deploy_before_incident` |
| Postmortem | `postmortem_generate`, `postmortem_get_similar`, `postmortem_find_similar`, `pattern_get_count` |
| Traces | `traces_query`, `traces_query_metrics` |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| MCP Server | TypeScript, Model Context Protocol |
| MCP Transport | SSE + Streamable HTTP (compatible with any MCP client) |
| Agent Orchestration | LangGraph, Python FastAPI |
| LLM Inference | AWS Bedrock — Claude Sonnet 4 (postmortems) + Claude Haiku (pattern extraction) |
| Vector Store | Pinecone (dual-namespace: incidents + log-patterns) |
| Embeddings | AWS Titan Embed V2 (1024 dimensions) |
| Cache | Redis |
| Database | PostgreSQL (audit trail, metrics, postmortems) |
| Integrations | Datadog, PagerDuty, GitHub (mock mode available) |
| Notifications | Slack (severity-based routing: SEV1/SEV2/SEV3 channels) |
| Dashboard | React 18, Vite, TypeScript, Tailwind |

---

## Quick Start

```bash
# 1. Configure environment
cp .env.example .env
# Fill in: AWS credentials, PINECONE_API_KEY, REDIS_URL, DATABASE_URL

# 2. Start all services
docker compose up -d

# 3. Seed the knowledge base
npx tsx scripts/seed-incidents.ts

# 4a. Interactive mode — Connect any MCP client
# Claude Desktop: add to claude_desktop_config.json
# Cursor: add to MCP settings
# URL: https://your-ngrok-url/mcp

# 4b. Automatic mode — trigger via webhook
curl -X POST http://localhost:8000/trigger-workflow \
  -H "Content-Type: application/json" \
  -d '{"incident_id":"INC-001","service":"payment-service","severity":"SEV1"}'

# 5. Simulate incidents
npm run simulate
```

---

## MCP Client Compatibility

The server implements standard MCP transport and works with any compatible client:

| Client | Status |
|--------|--------|
| Claude Desktop | ✅ Tested |
| Cursor | ✅ Tested |
| Zed | ✅ Compatible |
| Continue | ✅ Compatible |
| Custom client | ✅ SSE + Streamable HTTP |

---

## Self-Improving RAG

Every resolved incident automatically:
1. Gets embedded via AWS Titan V2 and stored in Pinecone
2. Triggers Claude Haiku to extract 3-5 error patterns
3. Deduplicates patterns against existing knowledge base
4. Makes future investigations faster and more accurate

---

## Slack Severity Routing

```
SEV1 → #incidents-sev1  (critical, pages everyone)
SEV2 → #incidents-sev2  (high priority, pages on-call)
SEV3 → #incidents-sev3  (low priority, no pages)
All  → #all-incidentresponsemcp (full audit trail)
```

---

## Environment Variables

```bash
# AWS
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
AWS_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-20250514-v1:0
AWS_BEDROCK_HAIKU_MODEL_ID=us.anthropic.claude-3-5-haiku-20241022-v1:0
AWS_BEDROCK_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0

# Pinecone
PINECONE_API_KEY=
PINECONE_INDEX_NAME=incident-postmortems

# Database
DATABASE_URL=postgresql://user:password@postgres:5432/incident_response
REDIS_URL=redis://redis:6379

# Integrations (set USE_MOCK=false for production)
USE_MOCK=true
PAGERDUTY_TOKEN=
DATADOG_API_KEY=
GITHUB_TOKEN=
GITHUB_REPO=

# Slack
SLACK_WEBHOOK_SEV1=
SLACK_WEBHOOK_SEV2=
SLACK_WEBHOOK_SEV3=
SLACK_WEBHOOK_ALL=
```

---

## License

MIT © 2026 Lohith Reddy Kondreddy

---

Built using TypeScript · LangGraph · AWS Bedrock · Pinecone · React · Model Context Protocol
