import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import { logger } from "./logger.js";
import { auditLog } from "./db/audit.js";

import { tools as alertTools, handleToolCall as handleAlerts } from "./tools/alerts.js";
import { tools as logTools,   handleToolCall as handleLogs   } from "./tools/logs.js";
import { tools as gitTools,   handleToolCall as handleGit    } from "./tools/git.js";
import { tools as postmortemTools, handleToolCall as handlePostmortem } from "./tools/postmortem.js";
import { tools as traceTools, handleToolCall as handleTraces } from "./tools/traces.js";

// ── Tool registry ──────────────────────────────────────────────────────────────

const allTools = [
  ...alertTools,
  ...logTools,
  ...gitTools,
  ...postmortemTools,
  ...traceTools,
];

type Handler = (name: string, args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

const routes: [prefix: string, handler: Handler][] = [
  ["alert_",      handleAlerts],
  ["log_",        handleLogs],
  ["git_",        handleGit],
  ["postmortem_", handlePostmortem],
  ["pattern_",    handlePostmortem],
  ["traces_",     handleTraces],
];

function routeHandler(toolName: string): Handler | undefined {
  for (const [prefix, handler] of routes) {
    if (toolName.startsWith(prefix)) return handler;
  }
  return undefined;
}

// ── MCP server factory ────────────────────────────────────────────────────────
// Each transport (stdio or SSE session) gets its own Server instance so that
// server.connect() can be called independently per connection.

function createMcpServer(): Server {
  const s = new Server(
    { name: "incident-response-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs = {} } = request.params;
    const args = rawArgs as Record<string, unknown>;
    const start = Date.now();

    const handler = routeHandler(name);
    if (!handler) {
      const errorMsg = `No handler registered for tool: ${name}`;
      await auditLog(name, args, Date.now() - start, false, errorMsg);
      throw new McpError(ErrorCode.MethodNotFound, errorMsg);
    }

    let result: Awaited<ReturnType<Handler>>;
    try {
      result = await handler(name, args);
    } catch (thrown) {
      const duration = Date.now() - start;
      const errorMsg = thrown instanceof Error ? thrown.message : String(thrown);
      logger.error("tool execution error", { tool: name, error: errorMsg });
      await auditLog(name, args, duration, false, errorMsg);
      if (thrown instanceof McpError) throw thrown;
      throw new McpError(ErrorCode.InternalError, errorMsg);
    }

    const duration = Date.now() - start;
    await auditLog(name, args, duration, !result.isError);
    logger.info("tool call", { tool: name, duration_ms: duration, success: !result.isError });
    return result;
  });

  return s;
}

// ── SSE session registry ───────────────────────────────────────────────────────

const sseTransports = new Map<string, SSEServerTransport>();

// ── HTTP API + SSE handler ─────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...CORS_HEADERS });
  res.end(payload);
}

async function httpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? "/";
  const parsedUrl = new URL(rawUrl, "http://localhost");
  const path = parsedUrl.pathname;

  // ── CORS preflight ───────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // ── SSE: establish connection ────────────────────────────────────────────────
  if (req.method === "GET" && path === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    sseTransports.set(transport.sessionId, transport);
    logger.info("SSE client connected", { sessionId: transport.sessionId });

    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
      logger.info("SSE client disconnected", { sessionId: transport.sessionId });
    });

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    return;
  }

  // ── SSE: receive messages from client ────────────────────────────────────────
  if (req.method === "POST" && path === "/messages") {
    const sessionId = parsedUrl.searchParams.get("sessionId");
    if (!sessionId) {
      return jsonResponse(res, 400, { error: "Missing sessionId query parameter" });
    }
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      return jsonResponse(res, 404, { error: `No active SSE session: ${sessionId}` });
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  // ── Streamable HTTP MCP transport (mcp-remote http-first) ───────────────────
  if (path === "/mcp") {
    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      return jsonResponse(res, 405, { error: "Method not allowed" });
    }
  }

  // ── Health check ─────────────────────────────────────────────────────────────
  if (req.method === "GET" && path === "/health") {
    return jsonResponse(res, 200, { status: "ok", tools: allTools.length, sse_sessions: sseTransports.size });
  }

  // ── List tools ───────────────────────────────────────────────────────────────
  if (req.method === "GET" && path === "/tools") {
    return jsonResponse(res, 200, { tools: allTools.map((t) => ({ name: t.name, description: t.description })) });
  }

  // ── Call a tool (REST convenience endpoint for workflow sidecar) ─────────────
  if (req.method === "POST" && path === "/tools/call") {
    let parsed: { name?: string; args?: Record<string, unknown>; arguments?: Record<string, unknown> };
    try {
      parsed = JSON.parse(await readBody(req)) as typeof parsed;
    } catch {
      return jsonResponse(res, 400, { error: "Invalid JSON body" });
    }

    logger.info("tools/call raw body", {
      body: JSON.stringify(parsed),
      args: JSON.stringify(parsed.args ?? parsed.arguments),
    });

    // Accept both "args" (REST convention) and "arguments" (MCP spec field name).
    const { name } = parsed;
    const args: Record<string, unknown> = parsed.args ?? parsed.arguments ?? {};
    if (!name) return jsonResponse(res, 400, { error: '"name" is required' });

    const handler = routeHandler(name);
    if (!handler) return jsonResponse(res, 404, { error: `Unknown tool: ${name}` });

    const start = Date.now();
    try {
      const result = await handler(name, args);
      const duration = Date.now() - start;
      await auditLog(name, args, duration, !result.isError);
      return jsonResponse(res, result.isError ? 422 : 200, result);
    } catch (err) {
      const duration = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      await auditLog(name, args, duration, false, errMsg);
      return jsonResponse(res, 500, { error: errMsg });
    }
  }

  jsonResponse(res, 404, { error: "Not found" });
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Always start stdio MCP transport (for Claude Desktop / CLI usage).
  const stdioServer = createMcpServer();
  const transport = new StdioServerTransport();
  await stdioServer.connect(transport);

  const toolNames = allTools.map((t) => t.name);
  logger.info("Incident Response MCP server started", {
    transport: "stdio",
    tool_count: toolNames.length,
    tools: toolNames,
  });

  // HTTP server: REST tool API + SSE MCP transport.
  const httpPort = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : null;
  if (httpPort) {
    const httpServer = createServer((req, res) => {
      httpHandler(req, res).catch((err) => {
        logger.error("http handler error", { err: (err as Error).message });
        if (!res.headersSent) jsonResponse(res, 500, { error: "Internal server error" });
      });
    });
    httpServer.listen(httpPort, () => {
      logger.info(`HTTP + SSE MCP transport listening on port ${httpPort}`, {
        endpoints: ["POST /mcp", "GET /sse", "POST /messages", "GET /health", "GET /tools", "POST /tools/call"],
      });
    });
  }
}

main().catch((err) => {
  logger.error("Fatal startup error", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
