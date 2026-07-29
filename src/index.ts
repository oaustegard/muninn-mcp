/**
 * Muninn remote MCP — Cloudflare Worker entry.
 *
 * Serves both protocol eras from one route and one factory via the official
 * SDK's `createMcpHandler`: the 2026-07-28 revision (stateless, server/discover,
 * per-request _meta envelope, Mcp-Method/Mcp-Name routing headers) and 2025-era
 * clients that still open with `initialize`.
 *
 * READ-ONLY BY CONSTRUCTION. Stage 1 of docs/mcp-migration.md: green is built
 * read-only against a Turso branch, and every write tool returns "not enabled"
 * — which here means simply not existing. Do not add a write tool to this
 * deployment until the parity harness is green on the production corpus.
 *
 * The OAuth'd entry for the claude.ai connector lands in a follow-up, copied
 * from sage-mcp's `mcp-oauth.ts` — that pattern is verified working against the
 * 2026-07-28 spec as of 2026-07-28, DCR deprecation notwithstanding.
 */

import { createMcpHandler } from "@modelcontextprotocol/server";
import { defaultDeps, type Config, type Deps } from "./tools.ts";
import { buildServer } from "./server.ts";

export interface Env extends Config {
  /** Shared secret. Unset = open; acceptable only for a read-only branch DB. */
  MCP_AUTH_TOKEN?: string;
}

export function mcpHandler(env: Env, deps: Deps = defaultDeps) {
  return createMcpHandler(() => buildServer(env, deps));
}

export function checkAuth(request: Request, env: Env): Response | null {
  if (!env.MCP_AUTH_TOKEN) return null;
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match || match[1] !== env.MCP_AUTH_TOKEN) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } },
      { status: 401 },
    );
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Muninn MCP (read-only) — POST MCP requests to this endpoint.\n");
    }
    const unauthorized = checkAuth(request, env);
    if (unauthorized) return unauthorized;
    return mcpHandler(env).fetch(request);
  },
};
