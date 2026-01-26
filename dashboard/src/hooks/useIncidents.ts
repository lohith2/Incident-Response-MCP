import { useEffect, useRef, useState } from "react";
import { fetchIncidents, fetchMetrics, type Incident, type Metrics } from "../api/client";

export function useIncidents(pollIntervalMs = 10_000) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    const [inc, met] = await Promise.all([fetchIncidents(), fetchMetrics()]);
    console.log("metrics API response:", met);
    setIncidents(inc);
    setMetrics(met);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), pollIntervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [pollIntervalMs]);

  return { incidents, metrics, loading };
}
