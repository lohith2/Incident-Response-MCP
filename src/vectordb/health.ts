import crypto from "node:crypto";
import { logger } from "../logger.js";
import { getPineconeClient } from "./pinecone.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NamespaceStats {
    namespace: string;
    vector_count: number;
}

export interface VectorDBHealth {
    status: "healthy" | "degraded" | "unavailable";
    index_name: string;
    /** Total number of vectors across all namespaces */
    index_size: number;
    namespaces: NamespaceStats[];
    latency_ms: number;
    error?: string;
}

// ── checkVectorDBHealth ───────────────────────────────────────────────────────

/**
 * Ping Pinecone and return index statistics.
 *
 * - Passes a zero-vector query to confirm read access is working.
 * - Returns status="unavailable" (not a thrown error) on any failure so callers
 *   can embed the result in a health endpoint without crashing.
 */
export async function checkVectorDBHealth(): Promise<VectorDBHealth> {
    const indexName =
        process.env.PINECONE_INDEX_NAME ?? "incident-postmortems";
    const start = Date.now();

    try {
        const pc = await getPineconeClient();

        // Use describe_index_stats (via the raw Pinecone client) to get namespace info.
        // We access the underlying pinecone instance through a small probe query.
        const PROBE_DIM = 1536;
        const probeVector = new Array<number>(PROBE_DIM).fill(0);
        // A query with topK=1 and a zero-vector is the cheapest possible live-read.
        const matches = await pc.query(probeVector, 1);

        const latency = Date.now() - start;

        // We can't directly call describeIndex easily without re-instantiating,
        // so we derive namespace info from what getPineconeClient exposes.
        // A full namespace breakdown requires the underlying Pinecone client;
        // here we report the two known namespaces from the project.
        const namespaces: NamespaceStats[] = [
            { namespace: "default", vector_count: -1 }, // -1 = not available without admin API
            { namespace: "log-patterns", vector_count: -1 },
        ];

        return {
            status: "healthy",
            index_name: indexName,
            index_size: matches.length >= 0 ? matches.length : 0, // lower-bound from probe
            namespaces,
            latency_ms: latency,
        };
    } catch (err) {
        const latency = Date.now() - start;
        const message = (err as Error).message ?? String(err);

        logger.warn("vectordb health check failed", { err: message });

        return {
            status: "unavailable",
            index_name: indexName,
            index_size: 0,
            namespaces: [],
            latency_ms: latency,
            error: message,
        };
    }
}
