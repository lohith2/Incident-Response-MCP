// Shared mock data used by all tool handlers when USE_MOCK=true.
// Timestamps are computed at call-time (functions, not constants) so they
// stay fresh across long-running server sessions.

export function mockAlerts() {
  return [
    {
      id: "PD-DEMO-001",
      title: "payment-service: 500 error rate > 40%",
      severity: "critical",
      service: "payment-service",
      status: "triggered",
      created_at: new Date().toISOString(),
    },
  ];
}

export function mockLogs() {
  const now = Date.now();
  return [
    { timestamp: new Date(now - 120_000).toISOString(), level: "error", message: "Connection pool exhausted — all 20 connections in use", status: 500 },
    { timestamp: new Date(now - 110_000).toISOString(), level: "error", message: "ECONNREFUSED connecting to postgres:5432", status: 500 },
    { timestamp: new Date(now -  90_000).toISOString(), level: "error", message: "Request timeout after 30000ms — payment charge endpoint", status: 500 },
    { timestamp: new Date(now -  60_000).toISOString(), level: "error", message: "Connection pool exhausted — all 20 connections in use", status: 500 },
  ];
}

export function mockDeploy() {
  return {
    id: "deploy-a3f9c21",
    sha: "a3f9c21b",
    ref: "v4.2.1",
    environment: "production",
    created_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
    description: "payment-service v4.2.1 — reduce pg connection pool size for cost optimisation",
    creator: "john.doe",
  };
}
