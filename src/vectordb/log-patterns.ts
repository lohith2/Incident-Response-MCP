import crypto from "node:crypto";
import { logger } from "../logger.js";
import { generateEmbedding } from "./embeddings.js";
import { getPineconeClient, type VectorMetadata } from "./pinecone.js";

// ── extractAndStorePatterns types ─────────────────────────────────────────────

interface ExtractedPattern {
  pattern:    string;
  root_cause: string;
  fix_applied: string;
  service:    string;
  severity:   string;
}

const PINECONE_NAMESPACE = "log-patterns";

// ── Public types ──────────────────────────────────────────────────────────────

export interface LogPatternRecord {
    /** The normalised structure of the error log */
    error_message: string;
    /** Service where this pattern primarily originates */
    service: string;
    /** Foundational cause corresponding to the log message */
    root_cause: string;
    /** Brief description of how to resolve the error */
    fix_applied: string;
    /** Optional metadata about how common this is initially */
    occurrence_count: number;
}

export interface SimilarLogPattern {
    matched_pattern: string;
    root_cause: string;
    fix_applied: string;
    /** Cosine similarity score in [0, 1]. Higher = more similar. */
    confidence: number;
}

// ── storeLogPattern ─────────────────────────────────────────────────────────────

/**
 * Persist a diagnosed log pattern to Pinecone under the `log-patterns` namespace.
 */
export async function storeLogPattern(pattern: LogPatternRecord): Promise<void> {
    const { error_message, service, root_cause, fix_applied, occurrence_count } = pattern;

    // Since error messages might repeat dynamically, we hash them for a clean vector ID.
    const hashId = crypto.createHash("sha256").update(error_message).digest("hex");

    // 1. Generate embedding from the error message only
    logger.info("storeLogPattern: generating embedding", { hashId });
    const vector = await generateEmbedding(error_message);

    // 2. Upsert to Pinecone
    const metadata: VectorMetadata = {
        error_message, // Keep original message structure in metadata
        service,
        root_cause,
        fix_applied,
        occurrence_count,
        created_at: new Date().toISOString(),
    };

    const pc = await getPineconeClient();
    await pc.upsert(`PATTERN-${hashId.substring(0, 16)}`, vector, metadata, PINECONE_NAMESPACE);
    logger.info("storeLogPattern: upserted to Pinecone", { namespace: PINECONE_NAMESPACE });
}

// ── findSimilarLogPattern ───────────────────────────────────────────────────────

/**
 * Searches Pinecone namespace `log-patterns` to find historical root causes
 * or fixes for the given error message.
 *
 * @param errorMessage Free-text or structured log line.
 * @returns Best match including its `confidence` similarity score.
 */
export async function findSimilarLogPattern(errorMessage: string): Promise<SimilarLogPattern | null> {
    logger.info("findSimilarLogPattern", { query: errorMessage.slice(0, 120) });

    const vector = await generateEmbedding(errorMessage);
    const pc = await getPineconeClient();
    const matches = await pc.query(vector, 1, PINECONE_NAMESPACE);

    if (!matches.length) return null;

    const top = matches[0];
    return {
        matched_pattern: String(top.metadata.error_message ?? ""),
        root_cause: String(top.metadata.root_cause ?? ""),
        fix_applied: String(top.metadata.fix_applied ?? ""),
        confidence: top.score,
    };
}

// ── extractAndStorePatterns ───────────────────────────────────────────────────

/** Cosine similarity threshold above which a new pattern is a duplicate. */
const DUPLICATE_THRESHOLD = 0.95;

/**
 * Call Bedrock Haiku to extract 3-5 error patterns from a completed postmortem,
 * deduplicate against the Pinecone log-patterns namespace, and store any new ones.
 *
 * Intended to be called fire-and-forget after `postmortem_generate` succeeds:
 *   `extractAndStorePatterns(...).catch(err => logger.error(...))`
 */
export async function extractAndStorePatterns(
  incidentId:    string,
  postmortemText: string,
  rootCause:     string,
  logs:          string,
): Promise<void> {
  logger.info("pattern extraction: starting", { incident_id: incidentId });

  // ── 1. Call Haiku ───────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import("@aws-sdk/client-bedrock-runtime");
  } catch {
    logger.error("pattern extraction: @aws-sdk/client-bedrock-runtime not installed");
    return;
  }

  const modelId =
    process.env.AWS_BEDROCK_HAIKU_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001";
  const region  = process.env.AWS_REGION ?? "us-east-1";
  const client  = new mod.BedrockRuntimeClient({ region });

  const prompt =
    `Extract 3-5 specific error patterns from this incident.\n` +
    `For each pattern return a JSON array:\n` +
    `[\n` +
    `  {\n` +
    `    "pattern": "exact error message or pattern",\n` +
    `    "root_cause": "what it means",\n` +
    `    "fix_applied": "how it was resolved",\n` +
    `    "service": "which service",\n` +
    `    "severity": "how serious"\n` +
    `  }\n` +
    `]\n\n` +
    `Root cause: ${rootCause}\n\n` +
    `Timeline/Logs:\n${logs.slice(0, 1500)}\n\n` +
    `Postmortem:\n${postmortemText.slice(0, 3000)}\n\n` +
    `Return ONLY a JSON array, no other text.`;

  let patterns: ExtractedPattern[];
  try {
    const command = new mod.ConverseCommand({
      modelId,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 1000 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await client.send(command);
    const raw: string   = response.output?.message?.content?.[0]?.text ?? "[]";
    // Strip markdown code fences if the model wraps the output
    const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    patterns = JSON.parse(cleaned) as ExtractedPattern[];
  } catch (err) {
    logger.error("pattern extraction: Haiku call or parse failed", {
      incident_id: incidentId,
      err: (err as Error).message,
    });
    return;
  }

  if (!Array.isArray(patterns) || patterns.length === 0) {
    logger.info("pattern extraction: no patterns extracted", { incident_id: incidentId });
    return;
  }

  logger.info("patterns extracted by Haiku", {
    incident_id: incidentId,
    count: patterns.length,
    patterns,
  });

  // ── 2. Deduplicate and store ────────────────────────────────────────────────
  let pc: Awaited<ReturnType<typeof getPineconeClient>>;
  try {
    pc = await getPineconeClient();
  } catch (err) {
    logger.error("pattern extraction: Pinecone unavailable", { err: (err as Error).message });
    return;
  }

  let stored  = 0;
  let skipped = 0;

  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    if (!p?.pattern?.trim()) continue;

    try {
      const embedding = await generateEmbedding(p.pattern);

      const nearest = await pc.query(embedding, 1, PINECONE_NAMESPACE);
      if (nearest.length > 0 && nearest[0].score >= DUPLICATE_THRESHOLD) {
        logger.info("Duplicate pattern skipped", {
          pattern: p.pattern.slice(0, 80),
          score:   nearest[0].score,
        });
        skipped++;
        continue;
      }

      const metadata: VectorMetadata = {
        pattern:         p.pattern,
        root_cause:      p.root_cause,
        fix_applied:     p.fix_applied,
        service:         p.service,
        severity:        p.severity,
        source_incident: incidentId,
        extracted_at:    new Date().toISOString(),
      };

      await pc.upsert(`pattern-${incidentId}-${i}`, embedding, metadata, PINECONE_NAMESPACE);
      logger.info("pattern stored in Pinecone", { pattern: p.pattern });
      stored++;
    } catch (err) {
      logger.error("pattern extraction: failed to store pattern", {
        pattern: p.pattern?.slice(0, 80),
        err: (err as Error).message,
      });
    }
  }

  logger.info("pattern extraction: complete", { incident_id: incidentId, stored, skipped });
}

// ── getPatternCount ───────────────────────────────────────────────────────────

/**
 * Return the total number of log patterns stored in the Pinecone log-patterns
 * namespace.  Used by the `pattern_get_count` MCP tool.
 */
export async function getPatternCount(): Promise<number> {
  const pc = await getPineconeClient();
  return pc.namespaceCount(PINECONE_NAMESPACE);
}
