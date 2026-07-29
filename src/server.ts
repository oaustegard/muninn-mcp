/**
 * Muninn MCP server factory — single tool registration, shared by every transport.
 *
 * Same shape as Sage's `mcp/src/server.ts`, which is the point: one architecture
 * across sage-mcp, muninn-mcp and (later) muninnd. The factory runs once per
 * request on the HTTP path, so it stays registration-only and side-effect-free.
 *
 * TOOL BUDGET (docs/mcp-migration.md §2): every schema costs tokens in EVERY
 * conversation on this connector. Muninn's Python surface is ~40 exported
 * functions and must collapse to 8-12 tools. Adding one here is a real cost —
 * check the budget before you do.
 */

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { recall, defaultDeps, type Config, type Deps } from "./tools.ts";

export const SERVER_NAME = "muninn";
export const SERVER_VERSION = "0.1.0";

export function buildServer(config: Config, deps: Deps = defaultDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Muninn's persistent memory. `recall` searches stored memories by text " +
        "and tags, ranked by relevance, recency, priority and confidence. This " +
        "deployment is READ-ONLY: writes still go through the Python skill.",
      // The tool list is identical for every caller and changes only on deploy.
      // Nothing else may be public: recall results are one user's private memory
      // and must never be served from a shared cache.
      cacheHints: { "tools/list": { ttlMs: 300_000, cacheScope: "public" } },
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall memories",
      description:
        "Search stored memories by text and/or tags. Use for 'what do I know about X', " +
        "prior decisions, and past corrections.",
      // Four first-class arguments, not nineteen. The rest of recall()'s surface
      // is documented in a resource rather than a schema (§8 progressive
      // disclosure); rendering all 19 as JSON Schema costs ~2k tokens per tool.
      inputSchema: z.object({
        query: z.string().describe("Natural-language search phrase."),
        n: z.number().optional().describe("Max results (default 10, capped at 50)."),
        tags: z.array(z.string()).optional().describe("Restrict to memories carrying these tags."),
        type: z.string().optional().describe("Restrict to one memory type."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return { content: [{ type: "text" as const, text: await recall(config, args, deps) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err).slice(0, 300)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
