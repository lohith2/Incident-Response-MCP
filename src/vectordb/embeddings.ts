import { createHash } from "crypto";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { logger } from "../logger.js";
import * as cache from "../cache/redis.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const TITAN_MODEL_ID = "amazon.titan-embed-text-v1";
const EMBEDDING_DIMENSION = 1536;
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_RETRIES = 3;
/** Initial back-off before first retry (ms); doubles each attempt. */
const BASE_BACKOFF_MS = 200;

// ── Bedrock client (module-level singleton) ───────────────────────────────────

let _bedrock: BedrockRuntimeClient | null = null;

function getBedrockClient(): BedrockRuntimeClient {
  if (!_bedrock) {
    _bedrock = new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? "us-east-1",
    });
  }
  return _bedrock;
}

// ── Cache key ─────────────────────────────────────────────────────────────────

/**
 * Stable, collision-resistant cache key for an input text.
 * SHA-256 keeps the key short and safe for any text content.
 */
function cacheKey(text: string): string {
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return `embed:${hash}`;
}

// ── Core embedding call ───────────────────────────────────────────────────────

/**
 * Invoke the Titan Embeddings model once and return the raw vector.
 * Throws on any API error — callers handle retries.
 */
async function callTitan(text: string): Promise<number[]> {
  const body = JSON.stringify({ inputText: text });

  const command = new InvokeModelCommand({
    modelId: TITAN_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: new TextEncoder().encode(body),
  });

  const response = await getBedrockClient().send(command);

  const decoded = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(decoded) as { embedding?: number[] };

  const vector = parsed.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(
      `Bedrock Titan returned an unexpected response shape: ${decoded.slice(0, 200)}`,
    );
  }
  if (vector.length !== EMBEDDING_DIMENSION) {
    logger.warn("titan embedding dimension mismatch", {
      expected: EMBEDDING_DIMENSION,
      got: vector.length,
    });
  }

  return vector;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a 1536-dimension embedding vector for `text` using the
 * AWS Bedrock Titan Embeddings model (`amazon.titan-embed-text-v1`).
 *
 * Results are cached in Redis for 24 hours under `embed:{sha256(text)}`
 * to avoid redundant Bedrock calls for identical inputs.
 *
 * Retries up to {@link MAX_RETRIES} times with exponential back-off on
 * transient errors before propagating the final error to the caller.
 *
 * @param text  Any UTF-8 string.  Titan supports up to ~8 KB of input.
 * @returns     A 1536-element array of floats ready for Pinecone upsert/query.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text.trim()) {
    throw new Error("generateEmbedding: input text must not be empty");
  }

  const key = cacheKey(text);

  // ── Cache read ─────────────────────────────────────────────────────────────
  const cached = await cache.get(key);
  if (cached) {
    try {
      const vector = JSON.parse(cached) as number[];
      logger.debug("embedding cache hit", { key });
      return vector;
    } catch {
      // Corrupt cache entry — fall through to regenerate.
      logger.warn("embedding cache parse error — regenerating", { key });
    }
  }

  // ── Bedrock call with retry ────────────────────────────────────────────────
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.debug("generating embedding via Titan", { attempt, textLen: text.length });
      const vector = await callTitan(text);

      // ── Cache write ──────────────────────────────────────────────────────
      await cache.set(key, JSON.stringify(vector), CACHE_TTL_SECONDS);

      logger.debug("embedding generated and cached", { key, dim: vector.length });
      return vector;
    } catch (err) {
      lastError = err;
      const isLast = attempt === MAX_RETRIES;
      logger.warn("titan embedding attempt failed", {
        attempt,
        maxRetries: MAX_RETRIES,
        err: (err as Error).message,
        willRetry: !isLast,
      });

      if (!isLast) {
        const backoffMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        await sleep(backoffMs);
      }
    }
  }

  throw new Error(
    `generateEmbedding failed after ${MAX_RETRIES} attempts: ${(lastError as Error).message}`,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
