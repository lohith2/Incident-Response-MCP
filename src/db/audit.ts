import pg from "pg";
import { logger } from "../logger.js";

const { Pool } = pg;

// Lazily-initialized pool — skips connection if DATABASE_URL is not set.
let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => {
      logger.error("pg pool error", { err: err.message });
    });
  }
  return pool;
}

/**
 * INSERT a row into tool_calls.
 *
 * DDL (run once):
 *   CREATE TABLE IF NOT EXISTS tool_calls (
 *     id          BIGSERIAL PRIMARY KEY,
 *     tool_name   TEXT        NOT NULL,
 *     args        JSONB       NOT NULL DEFAULT '{}',
 *     duration_ms INTEGER     NOT NULL,
 *     success     BOOLEAN     NOT NULL,
 *     error       TEXT,
 *     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 */
export async function auditLog(
  tool: string,
  args: Record<string, unknown>,
  duration: number,
  success: boolean,
  error?: string,
): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.debug("audit skipped — DATABASE_URL not set", { tool, success });
    return;
  }

  try {
    await getPool().query(
      `INSERT INTO tool_calls (tool_name, args, duration_ms, success, error, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [tool, JSON.stringify(args), duration, success, error ?? null],
    );
  } catch (err) {
    // Audit failures must never crash the MCP server — log and swallow.
    logger.error("audit write failed", {
      tool,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
