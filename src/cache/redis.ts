import IORedis from "ioredis";
import { logger } from "../logger.js";

// ── Connection ────────────────────────────────────────────────────────────────

let client: IORedis | null = null;
let ready = false;

function getClient(): IORedis | null {
  // Only instantiate once, even if REDIS_URL is absent.
  if (client !== null) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn("REDIS_URL not set — Redis caching disabled");
    return null;
  }

  client = new IORedis(url, {
    // Don't auto-connect; we'll do it manually below so we can catch the
    // initial error without crashing the process.
    lazyConnect: true,
    // Reject immediately when the socket is not yet open instead of queuing.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Exponential back-off capped at 5 s; give up after 5 failed attempts.
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 250, 5000)),
  });

  client.on("ready", () => {
    ready = true;
    logger.info("Redis connected");
  });

  client.on("error", (err: Error) => {
    if (ready) logger.warn("Redis error — caching degraded", { err: err.message });
    ready = false;
  });

  client.on("close", () => {
    ready = false;
  });

  // Fire-and-forget; errors are handled by the "error" event above.
  client.connect().catch((err: Error) => {
    logger.warn("Redis unavailable — caching disabled", { err: err.message });
  });

  return client;
}

// ── Exported cache helpers ────────────────────────────────────────────────────

/**
 * Retrieve a cached value.  Returns `null` on cache miss or when Redis is
 * unavailable (callers should treat both cases identically).
 */
export async function get(key: string): Promise<string | null> {
  if (!ready) return null;
  try {
    return await getClient()!.get(key);
  } catch (err) {
    logger.warn("Redis get failed", { key, err: (err as Error).message });
    return null;
  }
}

/**
 * Store a value with an explicit TTL (seconds).
 * Silently no-ops when Redis is unavailable.
 */
export async function set(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!ready) return;
  try {
    await getClient()!.set(key, value, "EX", ttlSeconds);
  } catch (err) {
    logger.warn("Redis set failed", { key, err: (err as Error).message });
  }
}

/**
 * Delete a key.  Silently no-ops when Redis is unavailable.
 */
export async function del(key: string): Promise<void> {
  if (!ready) return;
  try {
    await getClient()!.del(key);
  } catch (err) {
    logger.warn("Redis del failed", { key, err: (err as Error).message });
  }
}

// Kick off the connection eagerly so the "ready" state is established before
// the first tool call arrives.
getClient();
