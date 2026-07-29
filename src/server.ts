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
import { recall, memoryGet, muninnConfig, errorText, defaultDeps, type Config, type Deps } from "./tools.ts";
import {
  defaultRegistry,
  pointerFor,
  registerBootResource,
  registerDocLayer,
  type DocRegistry,
} from "./resources.ts";
import { composeBoot, defaultBootDeps, type BootDeps } from "./boot.ts";

export const SERVER_NAME = "muninn";
export const SERVER_VERSION = "0.1.0";

/**
 * @param registry the progressive-disclosure registry. Injectable so tests can
 *   drive synthetic topics through the real registration path — `docs-generated.ts`
 *   is a build artefact and its contents must not be a test fixture.
 */
export function buildServer(
  config: Config,
  deps: Deps = defaultDeps,
  registry: DocRegistry = defaultRegistry,
  bootDeps: BootDeps = defaultBootDeps,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        // The SDK defaults an unset `listChanged` to TRUE when it installs the
        // handlers, so `{}` is not the modest declaration it reads as — it ships
        // a promise to emit `notifications/*/list_changed`, which this server
        // never sends. Both are written out as false: it is what the spec says
        // omission means, and an unhonoured capability is worse than an
        // unclaimed one. `subscribe` is simply absent.
        //
        // Our tool list changes only on deploy, which by definition a live
        // client is not around to be notified about — so `tools/list` carries a
        // public cache hint below and no change notification, and those two
        // facts are the same fact.
        tools: { listChanged: false },
        resources: { listChanged: false },
      },
      instructions:
        "Muninn's persistent memory. `recall` searches stored memories by text " +
        "and tags, ranked by relevance, recency, priority and confidence; " +
        "`memory_get` fetches one memory by id and walks its references; " +
        "`muninn_config` reads the profile/ops/journal config store; " +
        "`muninn_docs` (and the `muninn://` resources) hold the full reference " +
        "for all three. This deployment is READ-ONLY: writes still go through " +
        "the Python skill.",
      // CACHE SCOPE IS A PRIVACY BOUNDARY. Public is for results that are
      // byte-identical for every caller and change only on deploy: the tool
      // list, and the documentation listings backed by `docs-generated.ts`.
      // Nothing derived from the memory corpus may be public — recall results
      // are one user's private memory and must never be served from a shared
      // cache. See PUBLIC_DOC_CACHE_HINT in resources.ts for what would flip
      // these listings back to private.
      //
      // `resources/read` is deliberately NOT hinted here. Its scope is set per
      // resource, so that forgetting a hint on a future memory-derived resource
      // fails closed to the SDK's conservative `private` default rather than
      // inheriting a blanket `public` from this line.
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "public" },
        "resources/list": { ttlMs: 300_000, cacheScope: "public" },
        "resources/templates/list": { ttlMs: 300_000, cacheScope: "public" },
      },
    },
  );

  // Layer 1 (§8): the `muninn://` resources, and the `muninn_docs` tool that
  // serves the same rows to clients that do not read resources. The fourth tool
  // is a deliberate spend against §2's budget — §9 decision 14: it is a
  // three-line schema and it is what makes the design surface-independent.
  registerDocLayer(server, registry);
  registerBootResource(server, config, bootDeps);

  server.registerTool(
    "recall",
    {
      title: "Recall memories",
      // THE HOT PATH IS THINNED, NOT DISPATCHED. §8 caveat 1: PD trades a fixed
      // cost for a variable cost plus a round trip, which is a good trade when N
      // is large and usage sparse — and a bad one here. `recall` is called in
      // nearly every conversation, so making it require a resource read first
      // would be a regression wearing PD's clothes. What moves behind the
      // pointer is prose; the four arguments stay first-class and described.
      description:
        "Search stored memories by text and/or tags: what is known about X, prior " +
        "decisions, past corrections. " + pointerFor(registry, ["recall"]),
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
          content: [{ type: "text" as const, text: errorText(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_get",
    {
      title: "Get a memory by id",
      // The per-mode gloss is gone: the enum values name themselves, and a
      // caller who needs to know what a reference chain IS needs the reference
      // doc, not two more words of schema. Ids stay, because "where do I get an
      // id" is the one thing a caller cannot work out from the schema.
      description:
        "Fetch one memory by id, its reference chain, or the alternatives a decision " +
        "rejected. Ids come from recall's [bracketed] prefixes. " +
        pointerFor(registry, ["memory", "types"]),
      // One tool, three modes. Three registrations would cost three descriptions
      // and three copies of `id` in every conversation (§2 tool budget); the
      // modes share an id, a resolver and an output shape, so they share a schema.
      inputSchema: z.object({
        id: z.string().describe("Full uuid or a unique id prefix."),
        mode: z
          .enum(["get", "chain", "alternatives"])
          .optional()
          .describe("Default 'get'."),
        depth: z
          .number()
          .optional()
          .describe("Chain depth (default 3, max 10). mode='chain' only."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return { content: [{ type: "text" as const, text: await memoryGet(config, args, deps) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: errorText(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "muninn_config",
    {
      title: "Read Muninn config",
      // What each category MEANS, and why there is no config_set, are deferred:
      // `readOnlyHint` and the server instructions already say read-only, and
      // the category glosses are reference material by definition.
      description:
        "Read the config store — profile, ops, journal. op 'get' returns one key's " +
        "value; 'list' indexes the keys without their values. " +
        // No config-specific doc is generated today; `vocabulary` is the one
        // that documents the config categories, so it is where a caller who
        // needs more than this description should be sent. `config` leads in
        // case the generator grows a dedicated topic later.
        pointerFor(registry, ["config", "vocabulary"]),
      inputSchema: z.object({
        op: z.enum(["get", "list"]).optional().describe("Default 'get'."),
        key: z.string().optional().describe("Config key. Required when op='get'."),
        category: z
          .string()
          .optional()
          .describe("Filter to one category. op='list' only."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return { content: [{ type: "text" as const, text: await muninnConfig(config, args, deps) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: errorText(err) }],
          isError: true,
        };
      }
    },
  );

  // `boot` is the fifth and last tool, and the one with no arguments at all.
  //
  // §9 item 6 asked whether boot should be a tool or a resource; §8 answered
  // both, and the reason the TOOL half cannot be dropped is that boot must fire
  // automatically. Project instructions invoke it at the start of a session, and
  // a resource is something a client offers a user to attach — MCP prompts have
  // the same problem, which is why §8 rejected them for this. The resource
  // (`muninn://boot`, registered in resources.ts) is the convenience; this is
  // the contract.
  //
  // No pointer sentence here: there is no deferred reference for boot, and §8
  // caveat 3's rule is that the pointer must resolve, not that every description
  // must carry one.
  server.registerTool(
    "boot",
    {
      title: "Load the boot payload",
      description:
        "Load Muninn's identity, operating rules, pending tasks and recent " +
        "context. Call once at the start of a session, before other memory tools.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return { content: [{ type: "text" as const, text: await composeBoot(config, bootDeps) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: errorText(err) }],
          isError: true,
        };
      }
    },
  );

  return server;
}
