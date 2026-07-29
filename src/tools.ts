/**
 * Tool bodies — transport-agnostic, mirroring Sage's `mcp/src/tools.ts`.
 *
 * Schemas and registration live in `server.ts`; this file holds the logic and
 * the formatting. Same "one implementation, two doors" shape Sage proved.
 *
 * SCOPE: read path only. This is Stage 1 of docs/mcp-migration.md — green is
 * built READ-ONLY against a Turso branch, and every write tool stays unwritten
 * until the parity harness is green. Reads are idempotent, so a wrong answer is
 * something you read rather than something you store.
 *
 * Three tools: `recall` (search), `memory_get` (addressed reads, three modes)
 * and `muninn_config` (the config store, two ops). Blue's ~40 Python functions
 * collapse into these via mode/op discriminators rather than one tool each —
 * §2's tool budget is the binding constraint, and it is spent in every
 * conversation on the connector whether or not a tool is called.
 */

import type { Client } from "@libsql/client/web";
import { db, type Config, type MemoryRow, type SearchOpts } from "./turso.ts";
import { recallWithExpansion } from "./expansion.ts";
import {
  configGet,
  configList,
  getAlternatives,
  getChain,
  getMemory,
  MemoryIdError,
  MAX_CHAIN_DEPTH,
  parseJsonArray,
  truthyFlag,
  type ConfigRow,
  type ParsedMemory,
} from "./queries.ts";

export type { Config };

/** Injectable I/O so dispatch is testable without a live Turso. */
export interface Deps {
  db: (config: Config) => Client;
}

export const defaultDeps: Deps = { db };

/**
 * Strip credentials out of an error before it reaches an MCP client.
 *
 * Port of `_sanitize_error` (turso.py ~line 157). Blue redacts these before
 * *printing to a local terminal*; green's stakes are higher, because the string
 * leaves the process — a tool response is model context, and from there it can
 * land in a transcript, a log, or a shared conversation.
 *
 * The realistic leak is not a bug in our code: libsql and fetch errors quote the
 * failing request, and the request carries `Authorization: Bearer <token>`. So
 * this is on the path every tool's catch block takes, not just the ones that
 * look risky.
 *
 * Two deliberate improvements on blue, both safe because redaction quality is
 * not observable in the corpus — transcribe-don't-improve exists to keep
 * *ranked output* identical, and this touches neither rows nor order:
 *
 *  - **Header patterns run BEFORE the Bearer catch-all.** Blue runs Bearer
 *    first, and its `\S+` is greedy: on `{'Authorization': 'Bearer abc'}` it
 *    swallows the trailing quote and brace, so the header pattern that follows
 *    can no longer find its own delimiter. Blue still redacts the secret — it
 *    just mangles the text around it. Specific patterns first fixes that.
 *  - **An unquoted `Authorization: <value>` is matched too**, which is the shape
 *    a JS `Headers` object stringifies to and which blue's Python-dict-oriented
 *    patterns miss entirely. That shape does not arise in blue's world; it is
 *    the common one in ours.
 */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/(['"])Authorization\1\s*:\s*(['"])[^'"]*\2/gi, "$1Authorization$1: $2[REDACTED]$2")
    .replace(/Authorization\s*:\s*[^,;\n'")}\]]+/gi, "Authorization: [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

/**
 * The single catch-block body for every tool registration.
 *
 * Factored out so a new tool cannot quietly ship an unsanitized handler by
 * copy-pasting the old `String(err).slice(0, 300)` — which is exactly how the
 * unredacted form reached three registrations.
 */
export function errorText(err: unknown): string {
  return `Error: ${sanitizeError(err).slice(0, 300)}`;
}

/** Relative age, for the same reason boot renders it: narrative time drifts. */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const mins = Math.floor((now.getTime() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/** The minimum a row needs to render. Satisfied by both MemoryRow and ParsedMemory. */
interface Renderable {
  id: unknown;
  type: unknown;
  t: string;
  summary: unknown;
}

/**
 * Render one memory as the two-line block every mode shares.
 *
 * `- [id8] type ["tags"]  (age)` then the summary, indented. Every read tool
 * emits this same block so the client learns one shape, not four; `badge` and
 * `indent` are the only permitted variations and exist for the chain view,
 * where depth has to be legible. With both omitted this is byte-identical to
 * what `formatRecall` emitted before the modes existed.
 */
function memoryBlock(
  r: Renderable,
  tags: string[],
  now?: Date,
  opts: { badge?: string; indent?: string } = {},
): string {
  const indent = opts.indent ?? "";
  const badge = opts.badge ? `${opts.badge} ` : "";
  const head = `${indent}- ${badge}[${String(r.id).slice(0, 8)}] ${r.type}` +
    (tags.length ? ` ${JSON.stringify(tags)}` : "") +
    `  (${relativeAge(r.t, now)})`;
  return `${head}\n${indent}    ${String(r.summary).replace(/\n/g, " ")}`;
}

/**
 * Format rows as the text an MCP client sees.
 *
 * The shape is frozen here on purpose. `MemoryResult`'s Python-side aliasing
 * (content->summary, conf->confidence) has no meaning over MCP, so the text
 * shape is decided once and pinned by tests — docs/mcp-migration.md §3 item 3.
 */
export function formatRecall(rows: MemoryRow[], now?: Date): string {
  if (rows.length === 0) return "No memories matched.";
  return rows
    .map((r) => memoryBlock(r, parseJsonArray(r.tags).map(String), now))
    .join("\n");
}

export interface RecallArgs {
  query: string;
  n?: number;
  tags?: string[];
  type?: string;
}

/**
 * The one tool green currently serves.
 *
 * Routed through `expansion.ts::recallWithExpansion`, not through
 * `turso.ts::search` directly: blue's `memory.py::recall` does not stop at the
 * FTS query. When it returns fewer than `expansion_threshold` (3) rows it
 * re-searches on the tags of the hits and on their PMI co-occurrences, then
 * re-ranks the union by provenance boost. Calling `search()` here made green
 * return a strict subset in composite order wherever blue returned a
 * boost-reranked union — the largest remaining blue/green divergence, and the
 * one the harness's `sparse-*` probes exist to measure.
 *
 * `search()` itself stays expansion-free on purpose. The parity harness compares
 * at BOTH layers, and an expanding `search()` would destroy the SQL-level
 * comparison that makes the ranking claim in docs/mcp-migration.md §3 checkable.
 *
 * The threshold is not exposed on the tool surface, so blue's default of 3
 * applies to every MCP call — which is also what a blue caller gets unless they
 * pass `expansion_threshold` explicitly.
 */
export async function recall(
  config: Config,
  args: RecallArgs,
  deps: Deps = defaultDeps,
): Promise<string> {
  const client = deps.db(config);
  const opts: SearchOpts = {
    n: Math.min(Math.max(Number(args.n) || 10, 1), 50),
    tags: args.tags,
    type: args.type,
  };
  const rows = await recallWithExpansion(client, String(args.query ?? ""), opts);
  return formatRecall(rows);
}

// ------------------------------------------------------------- memory_get

/**
 * Format a single fetched memory.
 *
 * The shared block plus one detail line — confidence, priority and the full id.
 * The full id is shown here and nowhere else: `recall` truncates to 8 chars
 * because a list of full uuids is mostly noise, but a caller who asked for one
 * specific memory is the caller most likely to need the exact id to pass on.
 */
export function formatMemory(m: ParsedMemory, now?: Date): string {
  const conf = m.confidence === null || m.confidence === undefined
    ? "conf —"
    : `conf ${Number(m.confidence).toFixed(2)}`;
  const prio = `priority ${m.priority ?? 0}`;
  return `${memoryBlock(m, m.tags, now)}\n    ${conf} · ${prio} · id ${m.id}`;
}

/**
 * Format a chain as a depth-indented pre-order listing.
 *
 * The order is the traversal order and is load-bearing (see getChain); the `d<n>`
 * badge plus two-space-per-level indent make the shape of the graph readable
 * without reordering or regrouping anything.
 */
export function formatChain(chain: ParsedMemory[], id: string, cap: number, now?: Date): string {
  if (chain.length === 0) return `No active memory found with id '${id}'.`;
  const header = `Reference chain from ${String(chain[0].id).slice(0, 8)} — ` +
    `${chain.length} ${chain.length === 1 ? "memory" : "memories"}, max depth ${cap}:`;
  const body = chain.map((m) => {
    const d = m._chain_depth ?? 0;
    return memoryBlock(m, m.tags, now, { badge: `d${d}`, indent: "  ".repeat(d) });
  });
  return [header, ...body].join("\n");
}

/** Format the alternatives block of a decision memory. */
export function formatAlternatives(items: unknown[] | null, id: string): string {
  if (items === null) return `No active memory found with id '${id}'.`;
  if (items.length === 0) return `No alternatives recorded for '${id}'.`;
  const lines = items.map((a) => {
    if (a === null || typeof a !== "object" || Array.isArray(a)) return `- ${JSON.stringify(a)}`;
    const alt = a as Record<string, unknown>;
    const option = alt.option === undefined || alt.option === null
      ? JSON.stringify(a)
      : String(alt.option);
    // Blue's own docstring example renders a missing reason exactly this way.
    const reason = alt.rejected === undefined || alt.rejected === null
      ? "no reason given"
      : String(alt.rejected);
    return `- ${option} — rejected: ${reason}`;
  });
  const head = `${items.length} alternative${items.length === 1 ? "" : "s"} recorded for '${id}':`;
  return [head, ...lines].join("\n");
}

export type MemoryGetMode = "get" | "chain" | "alternatives";

export interface MemoryGetArgs {
  id: string;
  mode?: MemoryGetMode;
  depth?: number;
}

/**
 * Addressed reads: memory.py::get, ::get_chain and ::get_alternatives behind one
 * schema.
 *
 * Three tools' worth of surface for one tool's worth of budget. They share an
 * `id` argument, the same partial-id resolution and the same output vocabulary,
 * so the discriminator costs one enum where three registrations would cost three
 * titles, three descriptions and three id parameters (§2).
 *
 * An ambiguous or unknown prefix comes back as the resolver's message, as plain
 * text rather than a thrown error: "your prefix collides with these five ids" is
 * an actionable answer, and surfacing it as a protocol error would bury it under
 * a stack trace. Everything else propagates and `server.ts` catches it.
 */
export async function memoryGet(
  config: Config,
  args: MemoryGetArgs,
  deps: Deps = defaultDeps,
): Promise<string> {
  const client = deps.db(config);
  const id = String(args.id ?? "").trim();
  if (!id) return "memory_get: an `id` is required (full uuid or unique prefix).";
  const mode: MemoryGetMode = args.mode ?? "get";

  try {
    if (mode === "chain") {
      // Args arrive as JSON, so coerce before blue's min(depth, 10) — a NaN cap
      // would disable the ceiling that cap exists to enforce.
      const raw = Number(args.depth);
      const requested = Number.isFinite(raw) ? raw : 3;
      const cap = Math.min(requested, MAX_CHAIN_DEPTH);
      return formatChain(await getChain(client, id, requested), id, cap);
    }
    if (mode === "alternatives") {
      return formatAlternatives(await getAlternatives(client, id), id);
    }
    const memory = await getMemory(client, id);
    return memory === null
      ? `No active memory found with id '${id}'.`
      : formatMemory(memory);
  } catch (err) {
    if (err instanceof MemoryIdError) return err.message;
    throw err;
  }
}

// ---------------------------------------------------------- muninn_config

/**
 * Format a config listing as an index, not a dump.
 *
 * Values are deliberately omitted. config.py's own boot-diet audit found ~120K
 * chars of payload being rendered by an over-eager default; `config_list`
 * returning full rows is harmless to a Python caller who indexes into them and
 * ruinous to a context window. The index carries what routing needs — key,
 * category, flags, size — and `op:"get"` fetches the one value actually wanted.
 */
export function formatConfigList(rows: ConfigRow[], category?: string): string {
  const scope = category ? ` in category '${category}'` : "";
  if (rows.length === 0) return `No config entries${scope}.`;
  const lines = rows.map((r) => {
    const flags: string[] = [];
    if (truthyFlag(r.boot_load)) flags.push("boot_load");
    if (truthyFlag(r.read_only)) flags.push("read_only");
    const size = `${String(r.value ?? "").length} chars`;
    return `- ${r.key} (${r.category}) ${[...flags, size].join(" · ")}`;
  });
  const head = `${rows.length} config ${rows.length === 1 ? "entry" : "entries"}${scope} ` +
    `(values omitted — read one with op:"get"):`;
  return [head, ...lines].join("\n");
}

export interface MuninnConfigArgs {
  op?: "get" | "list";
  key?: string;
  category?: string;
}

/**
 * The config store: config.py::config_get and ::config_list behind one schema.
 *
 * `config_set` is absent by construction, not by omission — this deployment is
 * read-only, and blue's config carries `read_only` rows whose immutability green
 * has no way to honour until stage 3.
 */
export async function muninnConfig(
  config: Config,
  args: MuninnConfigArgs,
  deps: Deps = defaultDeps,
): Promise<string> {
  const client = deps.db(config);
  const op = args.op ?? "get";

  if (op === "list") {
    const category = args.category ? String(args.category) : undefined;
    return formatConfigList(await configList(client, category), category);
  }

  const key = String(args.key ?? "").trim();
  if (!key) return 'muninn_config: `key` is required when op is "get".';
  const value = await configGet(client, key);
  // A miss is stated, never an empty string — an empty response reads as a
  // broken tool rather than as "there is no such entry".
  return value === null ? `No config entry for key '${key}'.` : `[config] ${key}\n${value}`;
}
