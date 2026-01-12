import axios, { AxiosInstance, AxiosError } from "axios";
import { logger } from "../logger.js";

const PD_BASE = "https://api.pagerduty.com";

// ── Public types ──────────────────────────────────────────────────────────────

export type IncidentStatus = "triggered" | "acknowledged" | "resolved";
export type IncidentUrgency = "high" | "low";
export type Severity = "critical" | "high" | "low" | "info";

export interface IncidentFilters {
  statuses?: IncidentStatus[];
  /** Maps to PagerDuty urgency: critical/high → "high", low/info → "low" */
  severities?: Severity[];
  serviceIds?: string[];
  teamIds?: string[];
  /** ISO 8601 start time */
  since?: string;
  /** ISO 8601 end time */
  until?: string;
  limit?: number;
}

export interface Incident {
  id: string;
  incident_number: number;
  title: string;
  status: IncidentStatus;
  urgency: IncidentUrgency;
  service: { id: string; summary: string };
  created_at: string;
  last_status_change_at: string;
  html_url: string;
  assignments: Array<{ assignee: { id: string; summary: string } }>;
  acknowledgements: Array<{ at: string; acknowledger: { id: string; summary: string } }>;
}

export interface LogEntry {
  id: string;
  type: string;
  summary: string;
  created_at: string;
  agent?: { id: string; summary: string; type: string };
  channel?: { summary: string; type: string };
}

export interface Service {
  id: string;
  name: string;
  /** "active" | "warning" | "critical" | "maintenance" | "disabled" */
  status: string;
  description?: string;
  escalation_policy: { id: string; summary: string };
}

export interface OnCallEntry {
  escalation_policy: { id: string; summary: string };
  user: { id: string; summary: string };
  escalation_level: number;
  start: string | null;
  end: string | null;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class PagerDutyClient {
  private readonly http: AxiosInstance;

  /**
   * @param apiToken  PagerDuty API token (read from PAGERDUTY_TOKEN env var).
   * @param fromEmail Optional email for the "From" header required by mutating
   *                  endpoints when using account-level tokens.  Set via
   *                  PAGERDUTY_FROM_EMAIL.
   */
  constructor(apiToken: string, fromEmail?: string) {
    const headers: Record<string, string> = {
      Authorization: `Token token=${apiToken}`,
      Accept: "application/vnd.pagerduty+json;version=2",
      "Content-Type": "application/json",
    };
    if (fromEmail) headers["From"] = fromEmail;

    this.http = axios.create({ baseURL: PD_BASE, headers });

    // ── Request interceptor ──────────────────────────────────────────────────
    this.http.interceptors.request.use((config) => {
      logger.debug("pagerduty →", {
        method: config.method?.toUpperCase(),
        url: config.url,
        params: config.params,
      });
      // Attach a start timestamp so the response interceptor can compute latency.
      (config as any)._startMs = Date.now();
      return config;
    });

    // ── Response interceptor ─────────────────────────────────────────────────
    this.http.interceptors.response.use(
      (response) => {
        const startMs = (response.config as any)._startMs as number | undefined;
        logger.debug("pagerduty ←", {
          status: response.status,
          url: response.config.url,
          duration_ms: startMs ? Date.now() - startMs : undefined,
        });
        return response;
      },
      (error: AxiosError) => {
        logger.error("pagerduty request failed", {
          url: error.config?.url,
          status: error.response?.status,
          body: error.response?.data,
          message: error.message,
        });
        return Promise.reject(error);
      },
    );
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  /**
   * Fetch incidents matching the supplied filters.  Defaults to active
   * (triggered + acknowledged) incidents if no statuses are provided.
   */
  async getIncidents(filters: IncidentFilters = {}): Promise<Incident[]> {
    const urgencies = this.severityToUrgency(filters.severities);

    const params: Record<string, unknown> = {
      "statuses[]": filters.statuses ?? ["triggered", "acknowledged"],
      limit: filters.limit ?? 100,
      "include[]": ["services", "assignments", "acknowledgements"],
    };

    if (urgencies.length) params["urgencies[]"] = urgencies;
    if (filters.serviceIds?.length) params["service_ids[]"] = filters.serviceIds;
    if (filters.teamIds?.length) params["team_ids[]"] = filters.teamIds;
    if (filters.since) params.since = filters.since;
    if (filters.until) params.until = filters.until;

    const { data } = await this.http.get<{ incidents: Incident[] }>("/incidents", { params });
    return data.incidents ?? [];
  }

  /**
   * Return the full event log for a single incident — equivalent to the
   * PagerDuty "incident timeline" view.
   */
  async getIncidentTimeline(id: string): Promise<LogEntry[]> {
    const { data } = await this.http.get<{ log_entries: LogEntry[] }>(
      `/incidents/${id}/log_entries`,
      { params: { "include[]": ["channels"] } },
    );
    return data.log_entries ?? [];
  }

  /**
   * Acknowledge an incident and optionally attach a message as a note.
   * Returns the updated incident.
   */
  async acknowledgeIncident(id: string, message: string): Promise<Incident> {
    const { data } = await this.http.put<{ incident: Incident }>(`/incidents/${id}`, {
      incident: { type: "incident_reference", status: "acknowledged" },
    });

    // Attach the message as a note so it appears in the timeline.
    if (message) {
      await this.http
        .post(`/incidents/${id}/notes`, { note: { content: message } })
        .catch((err: AxiosError) => {
          // Note failure must not mask the acknowledge success.
          logger.warn("pagerduty note failed", { id, message: (err as Error).message });
        });
    }

    return data.incident;
  }

  /**
   * List all services in the account, including their escalation policies.
   */
  async getServices(): Promise<Service[]> {
    const { data } = await this.http.get<{ services: Service[] }>("/services", {
      params: { "include[]": ["escalation_policies"], limit: 100 },
    });
    return data.services ?? [];
  }

  /**
   * Return level-1 on-call users for the given escalation policy IDs.
   * Used internally by the service-health tool.
   */
  async getOnCalls(escalationPolicyIds: string[]): Promise<OnCallEntry[]> {
    if (!escalationPolicyIds.length) return [];
    const { data } = await this.http.get<{ oncalls: OnCallEntry[] }>("/oncalls", {
      params: {
        "include[]": ["users"],
        "escalation_policy_ids[]": escalationPolicyIds,
        escalation_level: 1,
      },
    });
    return data.oncalls ?? [];
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Convert user-facing severity labels to PagerDuty urgency values. */
  private severityToUrgency(severities?: Severity[]): IncidentUrgency[] {
    if (!severities?.length) return [];
    const urgencySet = new Set<IncidentUrgency>();
    for (const s of severities) {
      urgencySet.add(s === "critical" || s === "high" ? "high" : "low");
    }
    return Array.from(urgencySet);
  }
}
