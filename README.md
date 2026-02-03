# Incident Response MCP

> An AI-powered incident response system that connects Claude directly to your observability stack — turning hours of manual investigation into minutes of guided root cause analysis.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6.svg)](https://typescriptlang.org)
[![Python](https://img.shields.io/badge/Python-3.11-blue.svg)](https://python.org)
[![LangGraph](https://img.shields.io/badge/LangGraph-0.2-orange.svg)](https://langchain.com)
[![AWS Bedrock](https://img.shields.io/badge/AWS-Bedrock-FF9900.svg)](https://aws.amazon.com/bedrock)

---

## What It Does

When a SEV1 fires at 2am, this system lets an on-call engineer ask Claude natural language questions and get back correlated insights from across the entire observability stack — logs, traces, alerts, deploys, and historical incidents — in a single response.

```
Engineer → Claude → MCP Server → [Datadog · CloudWatch · PagerDuty · Pinecone · PostgreSQL]
                                          ↓
                              LangGraph Investigation Pipeline
                                          ↓
                         Root cause · Remediation · Postmortem
```

---

## Architecture

**Three layers working together:**

**1. TypeScript MCP Server** — 19 tools exposed to Claude via the Model Context Protocol. Claude decides which tools to call and in what order based on the investigation context.

**2. Python LangGraph Workflow** — Multi-step investigation pipeline powered by AWS Bedrock. Uses a multi-model strategy: fast models for pattern extraction, powerful models for deep root cause synthesis.

**3. React Dashboard** — Real-time incident feed, MTTR analytics, RAG intelligence panel, and postmortem generation — all connected live via WebSocket.

---

## MCP Tools

| Category | Tools |
|----------|-------|
| Investigation | `investigate_incident`, `timeline_reconstruction`, `impact_assessment` |
| Observability | `search_logs`, `get_traces`, `correlate_alerts` |
| Intelligence | `search_similar_incidents`, `suggest_remediation`, `escalation_path` |
| Knowledge | `generate_postmortem`, `knowledge_base_update` |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| MCP Server | TypeScript, Model Context Protocol |
| Agent Orchestration | LangGraph, Python FastAPI |
| LLM Inference | AWS Bedrock (Claude multi-model strategy) |
| Vector Store | Pinecone (dual-namespace: incidents + runbooks) |
| Embeddings | AWS Titan |
| Cache | Redis |
| Database | PostgreSQL (audit trail) |
| Integrations | Datadog, PagerDuty, CloudWatch |
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
npx ts-node scripts/seed-incidents.ts

# 4. Connect to Claude Desktop
# Add MCP server config to claude_desktop_config.json

# 5. Simulate an incident
npx ts-node scripts/simulate-incident.ts --severity SEV2
```

---

## Self-Improving RAG

Every resolved incident is automatically ingested back into the Pinecone knowledge base. Over time the system gets smarter — similar incidents surface faster, runbook suggestions become more accurate, and postmortem quality improves.

---

## License

MIT © 2026 Lohith Reddy Kondreddy

---

Required env vars: `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` · `PINECONE_API_KEY` · `REDIS_URL` · `DATABASE_URL`

Built with ❤️ using TypeScript · LangGraph · AWS Bedrock · Pinecone · React
