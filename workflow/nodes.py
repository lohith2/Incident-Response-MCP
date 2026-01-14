"""
LangGraph node functions for automated incident response.

Each node is an async function that receives the current IncidentState,
performs one focused unit of work, and returns a partial state dict with
only the fields it updates.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import boto3
import httpx

from .state import IncidentState

logger = logging.getLogger(__name__)

MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "http://mcp-server:3000")
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")
GITHUB_REPO = os.getenv("GITHUB_REPO", "")  # "owner/name"
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
BEDROCK_MODEL_ID = os.getenv(
    "AWS_BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-5-20250929-v1:0"
)

# ── MCP gateway ───────────────────────────────────────────────────────────────


async def call_mcp_tool(tool_name: str, args: dict) -> Any:
    """POST to the MCP server's HTTP tool API and return the parsed result."""
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{MCP_SERVER_URL}/tools/call",
            json={"name": tool_name, "args": args},
        )
        response.raise_for_status()
        payload = response.json()
        # MCP tool results have content[0].text — parse the JSON within it.
        if isinstance(payload, dict) and "content" in payload:
            text = payload["content"][0]["text"]
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return text
        return payload


# ── Nodes ─────────────────────────────────────────────────────────────────────


async def fetch_alerts_node(state: IncidentState) -> dict:
    """
    Fetch active PagerDuty alerts for the affected service.
    Populates: alerts
    """
    logger.info("[fetch_alerts] service=%s", state["service"])
    try:
        result = await call_mcp_tool(
            "alert_get_active",
            {"limit": 25},
        )
        alerts: list = result.get("incidents", []) if isinstance(result, dict) else []
        # Filter to alerts related to this service if possible.
        service = state["service"].lower()
        relevant = [
            a for a in alerts
            if service in a.get("service", {}).get("summary", "").lower()
        ] or alerts  # fall back to all if none match
    except Exception as exc:
        logger.warning("[fetch_alerts] failed: %s", exc)
        relevant = []

    return {
        "alerts": relevant,
        "steps_taken": [*state["steps_taken"], "fetch_alerts"],
    }


async def query_logs_node(state: IncidentState) -> dict:
    """
    Query Datadog logs and detect error spikes for the affected service.
    Populates: logs, error_spike, error_patterns, query_logs_attempts
    """
    service = state["service"]
    logger.info("[query_logs] service=%s attempt=%d", service, state.get("query_logs_attempts", 0) + 1)

    logs: list = []
    error_spike: dict | None = None
    error_patterns: list = []

    try:
        log_result = await call_mcp_tool(
            "log_query",
            {"service": service, "query": "status:error", "from_minutes_ago": 30, "limit": 50},
        )
        logs = log_result.get("logs", []) if isinstance(log_result, dict) else []
    except Exception as exc:
        logger.warning("[query_logs] log_query failed: %s", exc)

    try:
        spike_result = await call_mcp_tool(
            "log_get_error_spike",
            {"service": service, "minutes": 15},
        )
        error_spike = spike_result if isinstance(spike_result, dict) else None
    except Exception as exc:
        logger.warning("[query_logs] log_get_error_spike failed: %s", exc)

    try:
        pattern_result = await call_mcp_tool(
            "log_find_pattern",
            {"service": service, "from_minutes_ago": 30, "error_only": True},
        )
        error_patterns = (
            pattern_result.get("top_patterns", []) if isinstance(pattern_result, dict) else []
        )
    except Exception as exc:
        logger.warning("[query_logs] log_find_pattern failed: %s", exc)

    return {
        "logs": logs,
        "error_spike": error_spike,
        "error_patterns": error_patterns,
        "query_logs_attempts": state.get("query_logs_attempts", 0) + 1,
        "steps_taken": [*state["steps_taken"], "query_logs"],
    }


async def check_deploys_node(state: IncidentState) -> dict:
    """
    Find the deployment that occurred just before the incident using the
    'blame the deploy' heuristic.
    Populates: recent_commits
    """
    repo = GITHUB_REPO
    if not repo:
        logger.warning("[check_deploys] GITHUB_REPO not set — skipping")
        return {
            "recent_commits": [],
            "steps_taken": [*state["steps_taken"], "check_deploys"],
        }

    incident_ts = datetime.now(timezone.utc).isoformat()
    logger.info("[check_deploys] repo=%s incident_ts=%s", repo, incident_ts)

    commits: list = []
    try:
        result = await call_mcp_tool(
            "git_get_deploy_before_incident",
            {
                "repo": repo,
                "incident_timestamp": incident_ts,
                "look_back_hours": 24,
            },
        )
        if isinstance(result, dict) and result.get("found"):
            deploy = result.get("deployment", {})
            commits = [
                {
                    "sha": deploy.get("sha"),
                    "ref": deploy.get("ref"),
                    "creator": deploy.get("creator"),
                    "created_at": deploy.get("created_at"),
                    "status": deploy.get("status"),
                    "minutes_before_incident": result.get("minutes_before_incident"),
                }
            ]
    except Exception as exc:
        logger.warning("[check_deploys] failed: %s", exc)

    return {
        "recent_commits": commits,
        "steps_taken": [*state["steps_taken"], "check_deploys"],
    }


async def analyze_root_cause_node(state: IncidentState) -> dict:
    """
    Call AWS Bedrock (Claude) with all collected context to produce a
    root_cause string and a confidence score 0–1.
    Populates: root_cause, confidence
    """
    logger.info("[analyze_root_cause] calling Bedrock")

    context = json.dumps(
        {
            "service": state["service"],
            "severity": state["severity"],
            "active_alerts": state["alerts"][:5],
            "recent_errors": state["logs"][:10],
            "error_patterns": state["error_patterns"],
            "recent_deploys": state["recent_commits"],
            "error_spike": state["error_spike"],
        },
        default=str,
    )

    prompt = (
        "You are an expert SRE performing root cause analysis for a production incident.\n\n"
        f"Incident context:\n{context}\n\n"
        "Respond ONLY with a JSON object: "
        '{"root_cause": "<one concise sentence>", "confidence": <0.0-1.0>}\n'
        "confidence reflects how certain you are given the available evidence."
    )

    root_cause = "Unknown — insufficient data"
    confidence = 0.0

    try:
        bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)
        body = json.dumps(
            {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 256,
                "messages": [{"role": "user", "content": prompt}],
            }
        )
        response = bedrock.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=body,
        )
        raw = json.loads(response["body"].read())
        text = raw["content"][0]["text"].strip()
        # Strip any markdown code fences the model may add.
        text = text.lstrip("```json").lstrip("```").rstrip("```").strip()
        parsed = json.loads(text)
        root_cause = parsed.get("root_cause", root_cause)
        confidence = float(parsed.get("confidence", 0.0))
    except Exception as exc:
        logger.warning("[analyze_root_cause] Bedrock call failed: %s", exc)

    return {
        "root_cause": root_cause,
        "confidence": confidence,
        "steps_taken": [*state["steps_taken"], "analyze_root_cause"],
    }


async def create_ticket_node(state: IncidentState) -> dict:
    """
    Create a structured GitHub incident issue when confidence > 0.7.
    Populates: github_issue_url
    """
    repo = GITHUB_REPO
    if not repo:
        logger.warning("[create_ticket] GITHUB_REPO not set — skipping")
        return {
            "github_issue_url": None,
            "steps_taken": [*state["steps_taken"], "create_ticket"],
        }

    logger.info("[create_ticket] confidence=%.2f", state.get("confidence", 0))

    issue_url: str | None = None
    try:
        result = await call_mcp_tool(
            "git_create_incident_issue",
            {
                "repo": repo,
                "incident_id": state["incident_id"],
                "title": f"Incident in {state['service']}: {state.get('root_cause', 'under investigation')}",
                "service": state["service"],
                "severity": state["severity"],
                "summary": state.get("root_cause") or "Root cause under investigation",
                "root_cause": state.get("root_cause"),
                "action_items": ["Investigate root cause", "Mitigate customer impact", "Write postmortem"],
                "labels": ["incident", state["severity"].lower()],
            },
        )
        issue_url = result.get("issue_url") if isinstance(result, dict) else None
        logger.info("[create_ticket] created %s", issue_url)
    except Exception as exc:
        logger.warning("[create_ticket] failed: %s", exc)

    return {
        "github_issue_url": issue_url,
        "steps_taken": [*state["steps_taken"], "create_ticket"],
    }


async def generate_postmortem_node(state: IncidentState) -> dict:
    """
    Generate an AI-written postmortem via the MCP postmortem_generate tool
    (which internally calls Bedrock and saves to Postgres).
    Populates: postmortem_draft
    """
    logger.info("[generate_postmortem] incident=%s", state["incident_id"])

    draft: str | None = None
    try:
        timeline_lines = []
        for log in state["logs"][:5]:
            ts = log.get("timestamp", "?")
            msg = log.get("message", "?")
            timeline_lines.append(f"- {ts}: {msg}")

        result = await call_mcp_tool(
            "postmortem_generate",
            {
                "incident_id": state["incident_id"],
                "title": f"Incident {state['incident_id']} – {state['service']} degradation (severity {state['severity']})",
                "impact": f"Service {state['service']} degraded at severity {state['severity']}.",
                "timeline": "\n".join(timeline_lines) or "Timeline unavailable.",
                "root_cause": state.get("root_cause") or "Under investigation",
                "services_affected": [state["service"]],
                "action_items": [
                    {"action": "Fix root cause", "dri": "On-call engineer", "deadline": "TBD"},
                    {"action": "Add alerting for this failure mode", "dri": "Platform team", "deadline": "TBD"},
                ],
            },
        )
        # postmortem_generate returns the markdown directly as content[0].text
        draft = result if isinstance(result, str) else json.dumps(result)
    except Exception as exc:
        logger.warning("[generate_postmortem] failed: %s", exc)

    return {
        "postmortem_draft": draft,
        "steps_taken": [*state["steps_taken"], "generate_postmortem"],
    }


async def notify_slack_node(state: IncidentState) -> dict:
    """
    POST an incident summary to the configured Slack webhook.
    Populates: resolved (set True after notification)
    """
    if not SLACK_WEBHOOK_URL:
        logger.warning("[notify_slack] SLACK_WEBHOOK_URL not set — skipping")
        return {"resolved": True, "steps_taken": [*state["steps_taken"], "notify_slack"]}

    issue_link = (
        f"\n*GitHub Issue:* <{state['github_issue_url']}|View Issue>"
        if state.get("github_issue_url")
        else ""
    )

    message = {
        "text": f":rotating_light: *Incident {state['incident_id']} — {state['severity']}*",
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        f":rotating_light: *Incident {state['incident_id']}* | {state['severity']}\n"
                        f"*Service:* {state['service']}\n"
                        f"*Root Cause:* {state.get('root_cause', 'under investigation')}\n"
                        f"*Confidence:* {state.get('confidence', 0):.0%}{issue_link}"
                    ),
                },
            }
        ],
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(SLACK_WEBHOOK_URL, json=message)
            resp.raise_for_status()
        logger.info("[notify_slack] notification sent")
    except Exception as exc:
        logger.warning("[notify_slack] failed: %s", exc)

    return {
        "resolved": True,
        "steps_taken": [*state["steps_taken"], "notify_slack"],
    }
