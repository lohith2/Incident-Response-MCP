import { Pinecone, type Index } from "@pinecone-database/pinecone";
import { logger } from "../logger.js";

// ── Public types ──────────────────────────────────────────────────────────────

/** Arbitrary metadata attached to every stored vector. */
export type VectorMetadata = Record<string, string | number | boolean | string[]>;

/** A single result returned by {@link PineconeClient.query}. */
export interface QueryMatch {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EMBEDDING_DIMENSION = 1536;
const DEFAULT_METRIC = "cosine" as const;
/** Milliseconds to wait between index-readiness polls during creation. */
const POLL_INTERVAL_MS = 2_000;
/** Maximum total wait time for a new index to become ready. */
const READINESS_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

// ── Client ────────────────────────────────────────────────────────────────────

export class PineconeClient {
  private readonly indexName: string;
  private pinecone: Pinecone | null = null;
  private index: Index | null = null;

  /**
   * @param apiKey    Pinecone API key (falls back to `PINECONE_API_KEY` env var).
   * @param indexName Name of the Pinecone index (falls back to `PINECONE_INDEX_NAME`
   *                  or `"incident-postmortems"`).
   */
  constructor(
    private readonly apiKey: string = requireEnv("PINECONE_API_KEY"),
    indexName: string = process.env.PINECONE_INDEX_NAME ?? "incident-postmortems",
  ) {
    this.indexName = indexName;
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  /**
   * Connect to Pinecone and ensure the target index exists.
   * Creates a serverless index on `us-east-1` if it does not yet exist,
   * then waits until the index reports `Ready` before returning.
   *
   * Must be called once before any other method.
   */
  async initialize(): Promise<void> {
    if (this.index) {
      logger.debug("pinecone already initialized");
      return;
    }

    this.pinecone = new Pinecone({ apiKey: this.apiKey });

    const existingIndexes = await this.pinecone.listIndexes();
    const names = (existingIndexes.indexes ?? []).map((i) => i.name);

    if (!names.includes(this.indexName)) {
      logger.info("pinecone index not found — creating", { index: this.indexName });
      await this.pinecone.createIndex({
        name: this.indexName,
        dimension: EMBEDDING_DIMENSION,
        metric: DEFAULT_METRIC,
        spec: {
          serverless: {
            cloud: "aws",
            region: process.env.AWS_REGION ?? "us-east-1",
          },
        },
      });

      await this.waitUntilReady();
    } else {
      logger.info("pinecone index exists", { index: this.indexName });
    }

    this.index = this.pinecone.index(this.indexName);
    logger.info("pinecone initialized", { index: this.indexName });
  }

  /**
   * Upsert a single vector with associated metadata.
   * If a record with the same `id` already exists it is overwritten.
   *
   * @param id       Unique string identifier (e.g. incident_id or a UUID).
   * @param vector   1536-element embedding from {@link generateEmbedding}.
   * @param metadata Arbitrary key-value pairs stored alongside the vector.
   */
  async upsert(id: string, vector: number[], metadata: VectorMetadata, namespace?: string): Promise<void> {
    this.assertReady();

    if (vector.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `upsert: expected ${EMBEDDING_DIMENSION}-dimension vector, got ${vector.length}`,
      );
    }

    const target = namespace ? this.index!.namespace(namespace) : this.index!;
    await target.upsert([{ id, values: vector, metadata }]);
    logger.debug("pinecone upsert ok", { id, namespace, metadataKeys: Object.keys(metadata) });
  }

  /**
   * Find the `topK` most similar vectors to `vector` using cosine similarity.
   *
   * @param vector  Query embedding (1536 dimensions).
   * @param topK    Number of nearest neighbours to return (default 5).
   * @returns       Matches sorted by descending similarity score.
   */
  async query(vector: number[], topK = 5, namespace?: string): Promise<QueryMatch[]> {
    this.assertReady();

    if (vector.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `query: expected ${EMBEDDING_DIMENSION}-dimension vector, got ${vector.length}`,
      );
    }

    const target = namespace ? this.index!.namespace(namespace) : this.index!;
    const response = await target.query({
      vector,
      topK,
      includeMetadata: true,
      includeValues: false,
    });

    return (response.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      metadata: (m.metadata ?? {}) as VectorMetadata,
    }));
  }

  /**
   * Delete a single record by its ID.
   * No-ops silently if the ID does not exist.
   *
   * @param id  The ID that was passed to {@link upsert}.
   */
  async deleteById(id: string, namespace?: string): Promise<void> {
    this.assertReady();
    const target = namespace ? this.index!.namespace(namespace) : this.index!;
    await target.deleteOne(id);
    logger.debug("pinecone delete ok", { id, namespace });
  }

  /**
   * Return the number of vectors stored in a given namespace.
   * Uses `describeIndexStats` which returns per-namespace counts without
   * scanning the full index.
   */
  async namespaceCount(namespace: string): Promise<number> {
    this.assertReady();
    // describeIndexStats is on Index, not Namespace — call it on the root handle.
    const stats = await this.index!.describeIndexStats();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nsStats = (stats as any).namespaces?.[namespace];
    return nsStats?.recordCount ?? nsStats?.vectorCount ?? 0;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Poll the index description until status is `Ready` or the timeout expires.
   */
  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + READINESS_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const description = await this.pinecone!.describeIndex(this.indexName);
      const status = description.status?.ready;

      logger.debug("waiting for pinecone index to become ready", {
        index: this.indexName,
        state: description.status?.state,
      });

      if (status === true) return;

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `Pinecone index "${this.indexName}" did not become Ready within ${READINESS_TIMEOUT_MS / 1000}s`,
    );
  }

  private assertReady(): void {
    if (!this.index) {
      throw new Error(
        "PineconeClient.initialize() must be called before using this method",
      );
    }
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

/**
 * Lazily-initialized singleton.  Import and call `getPineconeClient()` from
 * any tool that needs vector search — initialization happens once on first use.
 */
let _client: PineconeClient | null = null;

export async function getPineconeClient(): Promise<PineconeClient> {
  if (!_client) {
    _client = new PineconeClient();
    await _client.initialize();
  }
  return _client;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is required but not set`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
