-- Incident Response MCP — database schema
-- Runs automatically on first Postgres container start via docker-entrypoint-initdb.d

-- ── tool_calls ────────────────────────────────────────────────────────────────
-- Audit log written by src/db/audit.ts for every MCP tool invocation.
CREATE TABLE IF NOT EXISTS tool_calls (
    id          BIGSERIAL    PRIMARY KEY,
    tool_name   TEXT         NOT NULL,
    args        JSONB        NOT NULL DEFAULT '{}',
    duration_ms INTEGER      NOT NULL,
    success     BOOLEAN      NOT NULL,
    error       TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tool_calls_tool_name_idx ON tool_calls (tool_name);
CREATE INDEX IF NOT EXISTS tool_calls_created_at_idx ON tool_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS tool_calls_success_idx    ON tool_calls (success) WHERE NOT success;

-- ── postmortems ───────────────────────────────────────────────────────────────
-- Stores AI-generated postmortem documents (written by postmortem_generate tool).
CREATE TABLE IF NOT EXISTS postmortems (
    id           BIGSERIAL    PRIMARY KEY,
    incident_id  TEXT         NOT NULL UNIQUE,
    content      TEXT         NOT NULL,
    rag_enhanced BOOLEAN      NOT NULL DEFAULT FALSE,
    generated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Migration: add rag_enhanced to existing deployments
ALTER TABLE postmortems ADD COLUMN IF NOT EXISTS rag_enhanced BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS postmortems_incident_id_idx   ON postmortems (incident_id);
CREATE INDEX IF NOT EXISTS postmortems_generated_at_idx  ON postmortems (generated_at DESC);
-- Full-text search support for postmortem_get_similar queries.
CREATE INDEX IF NOT EXISTS postmortems_content_gin_idx   ON postmortems USING gin(to_tsvector('english', content));

-- ── incident_metrics ──────────────────────────────────────────────────────────
-- Stores per-incident timing metrics used by the dashboard.
CREATE TABLE IF NOT EXISTS incident_metrics (
    id                        BIGSERIAL    PRIMARY KEY,
    incident_id               TEXT         NOT NULL UNIQUE,
    service                   TEXT         NOT NULL,
    severity                  TEXT         NOT NULL CHECK (severity IN ('SEV1','SEV2','SEV3','SEV4')),
    detected_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    root_cause_identified_at  TIMESTAMPTZ,
    resolved_at               TIMESTAMPTZ,
    -- Derived fields (computed on insert/update for easy dashboard queries)
    time_to_root_cause_sec    INTEGER GENERATED ALWAYS AS (
        EXTRACT(EPOCH FROM (root_cause_identified_at - detected_at))::INTEGER
    ) STORED,
    time_to_resolve_sec       INTEGER GENERATED ALWAYS AS (
        EXTRACT(EPOCH FROM (resolved_at - detected_at))::INTEGER
    ) STORED,
    root_cause                TEXT,
    postmortem_url            TEXT,
    github_issue_url          TEXT,
    ai_assisted               BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS incident_metrics_service_idx     ON incident_metrics (service);
CREATE INDEX IF NOT EXISTS incident_metrics_severity_idx    ON incident_metrics (severity);
CREATE INDEX IF NOT EXISTS incident_metrics_detected_at_idx ON incident_metrics (detected_at DESC);
