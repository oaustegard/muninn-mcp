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
import { composeBoot, defaultBootDeps, paginateBoot, renderBootPart, type BootDeps } from "./boot.ts";
import { configSet, forget, formatWrite, remember, type WriteDeps } from "./writes.ts";
import { github, githubInputSchema, GITHUB_TOOL_DESCRIPTION, defaultGithubDeps, type GithubConfig } from "./github.ts";
import { strava, stravaInputSchema, STRAVA_TOOL_DESCRIPTION, defaultStravaDeps, type StravaConfig } from "./strava.ts";
import { bsky, bskyInputSchema, BSKY_TOOL_DESCRIPTION, defaultBskyDeps, type BskyConfig } from "./bsky.ts";
import { gateway, gatewayInputSchema, GATEWAY_TOOL_DESCRIPTION, defaultGatewayDeps, type GatewayConfig } from "./gateway.ts";
import { econ, econInputSchema, ECON_TOOL_DESCRIPTION, defaultEconDeps, type EconConfig } from "./econ.ts";

export const SERVER_NAME = "muninn";
export const SERVER_VERSION = "0.3.4";

/**
 * Service credentials the worker holds so that no container ever does
 * (handoff 69f3301c steps 3-4). All optional: a tool whose secrets are unset
 * still registers — the tool list must not change with configuration — and
 * answers every call with a "not configured" error naming the secret.
 */
export type ServiceSecrets = Partial<
  GithubConfig & Omit<StravaConfig, keyof Config> & BskyConfig & GatewayConfig & EconConfig
>;

function missing(config: Record<string, unknown>, keys: string[]): string | null {
  const absent = keys.filter((k) => !config[k]);
  return absent.length ? `not configured on the worker: wrangler secret put ${absent.join(", ")}` : null;
}

/**
 * The server instructions land in the system prompt of every session where the
 * connector is enabled (measured 2026-09-19 in Cowork: they sit alongside the
 * other connectors' instructions). That is what makes them the boot trigger —
 * it follows the account, not a project, so a plain Claude chat is Muninn.
 */
export const SERVER_INSTRUCTIONS =
  "Muninn — Oskar's persistent memory. When this connector is present you ARE " +
  "Muninn. FIRST action in every conversation, before any reply, question or " +
  "search: call `boot`. Its payload is identity, operating rules and recent " +
  "context to inhabit, not a deliverable; after it, re-read the message and " +
  "act. An 8-hex id in the message (e.g. 7fd6d3d2) is a memory id: " +
  "`memory_get` it, never ask where it lives. `recall` searches memories; " +
  "`remember` stores one without asking (pass `supersedes` to replace a prior " +
  "memory); `forget` retires one; `muninn_config` reads and sets the " +
  "profile/ops/journal store; `muninn_docs` and the `muninn://` resources hold " +
  "the full reference. `github` (rest/graphql/commit_files/open_pr), `strava`, " +
  "`bsky` (account: muninn|oskar), `gateway` (Gemini embed/generate) and `econ` " +
  "(FRED/Census data) act with credentials the worker holds. Writes and " +
  "service calls go through these tools, never through the container: no " +
  "credential is needed there.";

/**
 * @param registry the progressive-disclosure registry. Injectable so tests can
 *   drive synthetic topics through the real registration path — `docs-generated.ts`
 *   is a build artefact and its contents must not be a test fixture.
 */
export function buildServer(
  config: Config & ServiceSecrets,
  deps: Deps = defaultDeps,
  registry: DocRegistry = defaultRegistry,
  bootDeps: BootDeps = defaultBootDeps,
): McpServer {
  const writeDeps: WriteDeps = { ...deps, version: SERVER_VERSION };
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
      instructions: SERVER_INSTRUCTIONS,
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
      // tools/list is NOT hinted (0.3.2): a 300s public hint let a connector
      // re-sync within five minutes of the 0.3.1 deploy pick up the 11-tool
      // list, and a stale tool list costs a re-sync per client. The list is
      // fetched rarely enough that caching it buys nothing.
      cacheHints: {
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
      title: "Read or set Muninn config",
      // What each category MEANS is deferred: the category glosses are
      // reference material by definition. `set` rides on this schema rather
      // than its own tool (§2 budget): same key/category vocabulary, one op.
      description:
        "The config store — profile, ops, journal. op 'get' returns one key's " +
        "value; 'list' indexes the keys without their values; 'set' writes one " +
        "(new keys default to boot_load=false; read_only keys refuse). " +
        // No config-specific doc is generated today; `vocabulary` is the one
        // that documents the config categories, so it is where a caller who
        // needs more than this description should be sent. `config` leads in
        // case the generator grows a dedicated topic later.
        pointerFor(registry, ["config", "vocabulary"]),
      inputSchema: z.object({
        op: z.enum(["get", "list", "set"]).optional().describe("Default 'get'."),
        key: z.string().optional().describe("Config key. Required for 'get' and 'set'."),
        category: z
          .string()
          .optional()
          .describe("'list': filter to one category. 'set': required — profile, ops or journal."),
        value: z.string().optional().describe("op='set' only. The full new value."),
        boot_load: z
          .boolean()
          .optional()
          .describe("op='set' only. Omit to keep an existing key's flag."),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        if (args.op === "set") {
          const text = await configSet(config, {
            key: String(args.key ?? ""),
            value: String(args.value ?? ""),
            category: String(args.category ?? ""),
            boot_load: args.boot_load,
          }, writeDeps);
          return { content: [{ type: "text" as const, text }] };
        }
        return { content: [{ type: "text" as const, text: await muninnConfig(config, { ...args, op: args.op === "list" ? "list" : "get" }, deps) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: errorText(err) }],
          isError: true,
        };
      }
    },
  );

  // The write pair. `remember` covers both new memories and supersedes (one
  // schema, discriminated by `supersedes`), `forget` is the soft delete. Seven
  // tools in all — inside §2's 8-12 budget with room for one GitHub tool later.
  server.registerTool(
    "remember",
    {
      title: "Store a memory",
      description:
        "Store a memory: decisions, corrections, procedures, findings. Store " +
        "immediately when context is worth keeping; asking first is a failure " +
        "mode. Pass `supersedes` (an id or unique prefix) to replace a prior " +
        "memory instead of adding beside it. " +
        pointerFor(registry, ["types", "memory"]),
      inputSchema: z.object({
        summary: z.string().describe("The memory text. Lead with the finding; dates and ids inline."),
        type: z
          .enum(["decision", "world", "anomaly", "experience", "interaction", "procedure", "analysis"])
          .describe("Memory type."),
        tags: z.array(z.string()).optional().describe("Tags; novel ones join the recall vocabulary."),
        priority: z
          .number()
          .optional()
          .describe("-1 background, 0 normal, 1 important, 2 critical. Procedures floor at 1."),
        conf: z.number().optional().describe("0-1. Defaults: decision 0.8, procedure 0.9."),
        refs: z.array(z.string()).optional().describe("Cited memory ids (provenance, not supersession)."),
        supersedes: z.string().optional().describe("Id of the memory this one replaces."),
        drift_class: z
          .enum(["additive", "narrowing", "broadening", "replacing"])
          .optional()
          .describe("With `supersedes` on a procedure: how the rule moved."),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const r = await remember(config, args, writeDeps);
        return { content: [{ type: "text" as const, text: formatWrite("stored", r) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: errorText(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "forget",
    {
      title: "Forget a memory",
      description: "Soft-delete one memory by id or unique prefix. Reversible only by hand.",
      inputSchema: z.object({
        id: z.string().describe("Full uuid or a unique id prefix."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) => {
      try {
        const r = await forget(config, args, writeDeps);
        return { content: [{ type: "text" as const, text: formatWrite("forgot", r) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: errorText(err) }],
          isError: true,
        };
      }
    },
  );

  // `boot` is the last tool, and the one with no arguments at all.
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
        "context. Call once, as the first action of every conversation, before " +
        "any reply. The payload exceeds the harness output cap, so it arrives " +
        "in parts: when a part's footer says to, call boot again with the next " +
        "`part` before replying.",
      inputSchema: z.object({
        part: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Which part of the payload to return (default 1). A part's footer names the next one."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: { part?: number }) => {
      try {
        const parts = paginateBoot(await composeBoot(config, bootDeps));
        return { content: [{ type: "text" as const, text: renderBootPart(parts, args?.part ?? 1) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: errorText(err) }],
          isError: true,
        };
      }
    },
  );

  // ── service tools: the worker holds the credential, the session gets the action ──
  const guarded = (
    keys: string[],
    run: (args: never) => Promise<string>,
  ) => async (args: unknown) => {
    const why = missing(config as unknown as Record<string, unknown>, keys);
    if (why) return { content: [{ type: "text" as const, text: why }], isError: true };
    try {
      return { content: [{ type: "text" as const, text: await run(args as never) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: errorText(err) }], isError: true };
    }
  };

  server.registerTool(
    "github",
    {
      title: "GitHub API",
      description: GITHUB_TOOL_DESCRIPTION,
      inputSchema: githubInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guarded(["GITHUB_TOKEN"], (args) => github(config as GithubConfig, args, defaultGithubDeps)),
  );

  server.registerTool(
    "strava",
    {
      title: "Strava activities",
      description: STRAVA_TOOL_DESCRIPTION,
      inputSchema: stravaInputSchema,
      // The OAuth refresh is a side effect, but the tool is a read.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"], (args) =>
      strava(config as StravaConfig, args, { ...defaultStravaDeps, db: deps.db })),
  );

  server.registerTool(
    "bsky",
    {
      title: "Act on Bluesky",
      description: BSKY_TOOL_DESCRIPTION,
      inputSchema: bskyInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(["MUNINN_BSKY_HANDLE", "MUNINN_BSKY_APP_PASSWORD"], (args) =>
      bsky(config as BskyConfig, args, defaultBskyDeps)),
  );

  server.registerTool(
    "gateway",
    {
      title: "Gemini via Cloudflare AI Gateway",
      description: GATEWAY_TOOL_DESCRIPTION,
      inputSchema: gatewayInputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded(["CF_ACCOUNT_ID", "CF_GATEWAY_ID", "CF_API_TOKEN"], (args) =>
      gateway(config as GatewayConfig, args, defaultGatewayDeps)),
  );

  server.registerTool(
    "econ",
    {
      title: "FRED and Census data",
      description: ECON_TOOL_DESCRIPTION,
      inputSchema: econInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    // econ() also checks per op, so one key alone still serves its own op.
    guarded([], (args) => econ(config as EconConfig, args, defaultEconDeps)),
  );

  return server;
}
