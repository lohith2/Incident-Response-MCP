"""LangGraph state schema for the incident response workflow."""

from typing import List, Optional, Any
from typing_extensions import TypedDict


class IncidentState(TypedDict):
    """
    Shared mutable state threaded through every node in the LangGraph graph.
    All fields are populated progressively as the workflow executes.
    """

    # ── Inputs (set before the graph runs) ───────────────────────────────────
    incident_id: str
    service: str
    severity: str  # "SEV1" | "SEV2" | "SEV3" | "SEV4"

    # ── Collected evidence ────────────────────────────────────────────────────
    alerts: List[dict]           # from alert_get_active
    logs: List[dict]             # from log_query
    error_spike: Optional[dict]  # from log_get_error_spike
    recent_commits: List[dict]   # from git_get_deploy_before_incident + recent deploys
    error_patterns: List[dict]   # from log_find_pattern

    # ── Analysis results ──────────────────────────────────────────────────────
    root_cause: Optional[str]
    confidence: float  # 0.0 – 1.0; threshold for creating a ticket is 0.7

    # ── Outputs ───────────────────────────────────────────────────────────────
    postmortem_draft: Optional[str]
    github_issue_url: Optional[str]

    # ── Workflow bookkeeping ──────────────────────────────────────────────────
    steps_taken: List[str]       # append-only log of node names visited
    query_logs_attempts: int     # guard against infinite re-analysis loops
    resolved: bool
