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
 * TWO ENTRY POINTS, ONE DISPATCH. This file is both a deployable Worker and the
 * shared module that `mcp-oauth.ts` builds on — the same arrangement Sage uses.
 * `mcpHandler` is the single place the MCP server is constructed; the two entries
 * differ only in how they authenticate:
 *
 *   src/mcp-oauth.ts  OAuth 2.1 via @cloudflare/workers-oauth-provider. This is
 *                     `main` in wrangler.toml, because claude.ai custom connectors
 *                     require OAuth (§9 decision 2) and cannot present a bearer
 *                     token at all.
 *   src/index.ts      the `MCP_AUTH_TOKEN` bearer path below. Kept, not deleted:
 *                     the parity harness is not a browser and cannot walk an
 *                     auth-code flow, and neither can curl, `wrangler dev`, or any
 *                     other programmatic client. Removing it would be a regression
 *                     in exactly the surface Stage 1 is gated on.
 *
 * They are alternative deployments of the same server, never layered: under OAuth,
 * `apiHandler` calls `mcpHandler` directly rather than this file's `fetch`, because
 * the provider has already validated the access token and `checkAuth` would reject
 * that token as a non-matching bearer. Deploy this variant to its own name/route
 * (see wrangler.toml) if you want both live at once.
 */

import { createMcpHandler } from "@modelcontextprotocol/server";
import { defaultDeps, type Config, type Deps } from "./tools.ts";
import { buildServer } from "./server.ts";

export interface Env extends Config {
  /**
   * Shared secret for the bearer deployment of THIS file. Unset = open;
   * acceptable only for a read-only branch DB. Unused by `mcp-oauth.ts`, where
   * the OAuth provider is the gate.
   */
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
