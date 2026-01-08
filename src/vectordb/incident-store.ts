import pg from "pg";
import { logger } from "../logger.js";
import { generateEmbedding } from "./embeddings.js";
import { getPineconeClient, type VectorMetadata } from "./pinecone.js";

const { Pool } = pg;

// ── Postgres pool (lazy, null-safe) ──────────────────────────────────────────

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _pool.on("error", (err) =>
      logger.error("incident-store pool error", { err: err.message }),
    );
  }
  return _pool;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface IncidentRecord {
  /** Unique identifier, e.g. "INC-042". Used as the Pinecone vector ID. */
  incident_id: string;
  title: string;
  service: string;
  root_cause: string;
  /** Full postmortem Markdown — persisted to Postgres and embedded for search. */
  postmortem: string;
  /** One-sentence description of what fixed the incident. */
  resolution: string;
  /** Wall-clock time from detection to resolution. */
  duration_minutes: number;
  /** True when at least one similar past incident (similarity ≥ 0.7) informed generation. */
  rag_enhanced: boolean;
}

export interface SimilarIncident {
  incident_id: string;
  title: string;
  root_cause: string;
  resolution: string;
  /** Cosine similarity score in [0, 1].  Higher = more similar. */
  similarity_score: number;
}

// ── storeIncident ─────────────────────────────────────────────────────────────

/**
 * Persist a resolved incident to both Pinecone (vector search) and Postgres
 * (full-text postmortem storage).
 *
 * Steps:
 *  1. Combine title + root_cause + postmortem into a single text chunk.
 *  2. Generate a 1536-dim embedding via Bedrock Titan (Redis-cached 24 h).
 *  3. Upsert the vector + metadata to Pinecone.
 *  4. INSERT / UPDATE the postmortem row in Postgres.
 *
 * Postgres writes are best-effort — a failure is logged but does not propagate
 * so a DB outage never blocks the Pinecone write (the source of truth for
 * similarity search).
 */
export async function storeIncident(incident: IncidentRecord): Promise<void> {
  const {
    incident_id,
    title,
    service,
    root_cause,
    postmortem,
    resolution,
    duration_minutes,
    rag_enhanced,
  } = incident;

  // ── 1. Build embedding text chunk ──────────────────────────────────────────
  // Section labels help the model understand the semantic role of each part.
  // Postmortem is truncated to ~4 KB so we stay well under Titan's 8 KB limit
  // even when title and root_cause are long.
  const textChunk = [
    `title: ${title}`,
    `root_cause: ${root_cause}`,
    `postmortem: ${postmortem.slice(0, 4_000)}`,
  ].join("\n\n");

  // ── 2. Generate embedding ──────────────────────────────────────────────────
  logger.info("storeIncident: generating embedding", { incident_id });
  const vector = await generateEmbedding(textChunk);

  // ── 3. Upsert to Pinecone ─────────────────────────────────────────────────
  // All metadata values must be primitives (VectorMetadata constraint).
  const metadata: VectorMetadata = {
    incident_id,
    title,
    service,
    root_cause,
    resolution,
    duration_minutes,
    created_at: new Date().toISOString(),
  };

  const pc = await getPineconeClient();
  await pc.upsert(incident_id, vector, metadata);
  logger.info("storeIncident: upserted to Pinecone", { incident_id });

  // ── 4. Save postmortem to Postgres ────────────────────────────────────────
  const db = getPool();
  if (!db) {
    logger.debug("storeIncident: DATABASE_URL not set — skipping Postgres write", {
      incident_id,
    });
    return;
  }

  try {
    await db.query(
      `INSERT INTO postmortems (incident_id, content, rag_enhanced, generated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (incident_id)
       DO UPDATE SET
         content      = EXCLUDED.content,
         rag_enhanced = EXCLUDED.rag_enhanced,
         generated_at = NOW()`,
      [incident_id, postmortem, rag_enhanced],
    );
    logger.info("storeIncident: postmortem saved to Postgres", { incident_id });
  } catch (err) {
    // Non-fatal — Pinecone is already written; Postgres is secondary storage.
    logger.warn("storeIncident: Postgres write failed", {
      incident_id,
      err: (err as Error).message,
    });
  }
}

// ── searchSimilarIncidents ────────────────────────────────────────────────────

/**
 * Find past incidents whose embedding is most similar to the query text.
 *
 * Typical query: the current incident's root cause or a plain-English
 * description of the symptom (e.g. "database connection pool exhausted").
 *
 * @param query  Free-text description of the current incident or symptom.
 * @param topK   Number of nearest neighbours to return (default 3).
 * @returns      Array sorted by descending cosine similarity score.
 */
export async function searchSimilarIncidents(
  query: string,
  topK = 3,
): Promise<SimilarIncident[]> {
  logger.info("searchSimilarIncidents", { query: query.slice(0, 120), topK });

  const vector = await generateEmbedding(query);
  const pc = await getPineconeClient();
  const matches = await pc.query(vector, topK);

  return matches.map((m) => ({
    incident_id: String(m.metadata.incident_id ?? m.id),
    title: String(m.metadata.title ?? ""),
    root_cause: String(m.metadata.root_cause ?? ""),
    resolution: String(m.metadata.resolution ?? ""),
    similarity_score: m.score,
  }));
}
