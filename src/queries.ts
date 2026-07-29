/**
 * By-id and config read queries — the second slice of green's read path.
 *
 * Port of the read-only halves of `remembering/scripts/memory.py` and
 * `remembering/scripts/config.py`, plus `turso.py::_parse_memory_row`. Same
 * porting rule as `turso.ts`: **transcribe, do not improve.** Where the
 * TypeScript would naturally differ from the Python, the Python wins, and every
 * place it deliberately does not is marked DIVERGENCE with a reason.
 *
 * This file lives apart from `turso.ts` on purpose — `turso.ts` owns the search
 * path and its golden-vector-pinned ranking SQL; this owns the addressed reads.
 * The only things imported from it are its stable exports.
 *
 * READ-ONLY BY CONSTRUCTION (docs/mcp-migration.md §5, stage 1). Nothing here
 * writes. Note that blue's `get`-family is genuinely read-only but blue's
 * `recall` is not — it fires `_update_access_tracking` — and blue's `config_get`
 * fires `config_fire` under `MUNINN_INSTRUMENT_FIRES`. Both are writes and
 * neither is ported. If you find yourself adding an UPDATE to this file, the
 * stage gate has not been met.
 */

import type { Client } from "@libsql/client/web";

// --------------------------------------------------------------------- SQL

/** memory.py::_resolve_memory_id. The `%` lives in the param, not the SQL. */
export const RESOLVE_ID_SQL =
  "SELECT id FROM memories WHERE id LIKE ? AND deleted_at IS NULL";

/** memory.py::get and memory.py::get_chain both use exactly this. */
export const GET_MEMORY_SQL =
  "SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL";

/** memory.py::get_alternatives reads only the refs column. */
export const GET_REFS_SQL =
  "SELECT refs FROM memories WHERE id = ? AND deleted_at IS NULL";

/** config.py::config_get. No category filter, no soft-delete column on config. */
export const CONFIG_GET_SQL = "SELECT value FROM config WHERE key = ?";

/** config.py::config_list, filtered branch. */
export const CONFIG_LIST_CATEGORY_SQL =
  "SELECT * FROM config WHERE category = ? ORDER BY key";

/** config.py::config_list, unfiltered branch. Note the different ORDER BY. */
export const CONFIG_LIST_SQL = "SELECT * FROM config ORDER BY category, key";

// ------------------------------------------------------------------ errors

/**
 * A partial id that resolved to zero or to many memories.
 *
 * Blue raises `ValueError` for both, with deliberately different messages: the
 * multi-match case names the candidates so the caller can lengthen the prefix
 * without running a search first. That affordance is the whole point of partial
 * ids, so the two cases stay distinct here too. Callers are expected to surface
 * `.message` as text — an ambiguous prefix is a usable answer, not a crash.
 */
export class MemoryIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryIdError";
  }
}

// ------------------------------------------------------------------ parsing

/**
 * A memory row with its JSON columns parsed.
 *
 * Keeps the passthrough index signature so columns green does not yet format
 * (session_id, access_count, source, is_superseded) survive the parse and are
 * available to a later formatter without another schema change.
 */
export interface ParsedMemory {
  id: string;
  type: string;
  t: string;
  summary: string;
  confidence: number | null;
  priority: number | null;
  tags: string[];
  entities: unknown[];
  refs: unknown[];
  /** Distance from the chain root. Set by getChain only; blue calls it the same. */
  _chain_depth?: number;
  [column: string]: unknown;
}

/**
 * JSON-parse one of the array-shaped columns, falling back to `[]`.
 *
 * turso.py::_parse_memory_row swallows `json.JSONDecodeError` and substitutes
 * `[]`; a malformed column must degrade to "no tags" rather than fail the read,
 * because these rows are years old and were written by several schema eras.
 *
 * DIVERGENCE (minor): Python does not check that the parsed value is a list, so
 * a column holding `"5"` would yield the int 5 and blow up downstream. Here a
 * non-array parse is treated as `[]`. TypeScript needs the array to be an array,
 * and the corpus cannot contain such a row — every writer goes through
 * `json.dumps(list)`.
 */
export function parseJsonArray(raw: unknown): unknown[] {
  if (raw === null || raw === undefined || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Port of turso.py::_parse_memory_row — parses `tags`, `entities` and `refs`.
 *
 * `tools.ts` previously carried a private `parseTags` that handled only `tags`;
 * this is the full behaviour and the single place row JSON is decoded.
 */
export function parseMemoryRow(row: Record<string, unknown>): ParsedMemory {
  return {
    ...row,
    tags: parseJsonArray(row.tags).map(String),
    entities: parseJsonArray(row.entities),
    refs: parseJsonArray(row.refs),
  } as ParsedMemory;
}

function rowsOf(rs: { rows: unknown }): Record<string, unknown>[] {
  return (rs.rows ?? []) as Record<string, unknown>[];
}

// -------------------------------------------------------------- id resolution

/**
 * A full UUID is 36 chars with exactly 4 hyphens — blue's exact test.
 *
 * It is a shape check, not a validity check: blue does not verify hex digits or
 * hyphen positions, and neither do we. Anything that passes is returned from
 * `resolveMemoryId` with no database round trip at all, which is the hot path.
 */
export function isFullUuid(id: string): boolean {
  return id.length === 36 && id.split("-").length - 1 === 4;
}

/**
 * Resolve a full UUID or a unique prefix to a full id.
 *
 * Direct port of memory.py::_resolve_memory_id (v5.1.0, #244). Full ids short
 * circuit before any I/O. Prefixes match against active memories only, and both
 * zero matches and multiple matches are errors — collapsing them would lose the
 * "your prefix is too short, here are the collisions" affordance.
 */
export async function resolveMemoryId(client: Client, memoryId: string): Promise<string> {
  if (isFullUuid(memoryId)) return memoryId;

  const rs = await client.execute({ sql: RESOLVE_ID_SQL, args: [`${memoryId}%`] });
  const matches = rowsOf(rs);

  if (matches.length === 0) {
    throw new MemoryIdError(`No active memory found matching prefix '${memoryId}'`);
  }
  if (matches.length > 1) {
    // Blue truncates to 12 chars, lists at most 5, and renders the Python list
    // repr. The single quotes and ", " separator are transcribed, not styled.
    const ids = matches
      .slice(0, 5)
      .map((m) => `'${String(m.id).slice(0, 12)}...'`)
      .join(", ");
    throw new MemoryIdError(
      `Partial id '${memoryId}' matches ${matches.length} memories: [${ids}]. ` +
        "Provide a longer prefix for a unique match.",
    );
  }
  return String(matches[0].id);
}

// ------------------------------------------------------------------ get

/**
 * Fetch one memory by full or partial id. Port of memory.py::get.
 *
 * Returns null when no *active* memory carries the id — blue's `None`. Note the
 * asymmetry blue has and we keep: an unresolvable *prefix* raises, but a full
 * uuid for a deleted or nonexistent row returns null, because a full uuid never
 * goes through resolution.
 */
export async function getMemory(
  client: Client,
  memoryId: string,
): Promise<ParsedMemory | null> {
  const id = await resolveMemoryId(client, memoryId);
  const rs = await client.execute({ sql: GET_MEMORY_SQL, args: [id] });
  const rows = rowsOf(rs);
  if (rows.length === 0) return null;
  return parseMemoryRow(rows[0]);
}

// --------------------------------------------------------- get_alternatives

/**
 * Extract the recorded alternatives from a decision memory's refs.
 *
 * Port of memory.py::get_alternatives (v4.2.0, #254). The alternatives ride in
 * the same `refs` JSON array as provenance edges, marked by a
 * `{"_type": "alternatives", "items": [...]}` entry; the first such entry wins
 * and everything else in refs is ignored.
 *
 * DIVERGENCE 1 — partial ids are resolved here; blue passes `memory_id` straight
 * into the SELECT and so silently returns `[]` for any prefix. Green exposes all
 * three by-id reads behind one `memory_get` tool with one `id` argument, so a
 * prefix that works for `mode:"get"` must work for `mode:"alternatives"` too;
 * blue's behaviour would read as "this decision has no alternatives", which is
 * a wrong answer rather than an error.
 *
 * DIVERGENCE 2 — returns null (not `[]`) when no active memory has that id. Blue
 * collapses "no such memory" and "no alternatives recorded" into the same empty
 * list, which is fine for a Python caller doing a truthiness check and wrong for
 * a model reading text: a missing memory must be a stated "not found".
 */
export async function getAlternatives(
  client: Client,
  memoryId: string,
): Promise<unknown[] | null> {
  const id = await resolveMemoryId(client, memoryId);
  const rs = await client.execute({ sql: GET_REFS_SQL, args: [id] });
  const rows = rowsOf(rs);
  if (rows.length === 0) return null;

  const refs = parseJsonArray(rows[0].refs);
  for (const entry of refs) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      if (e._type === "alternatives") {
        // Blue: `entry.get('items', [])` — a missing items key is an empty list.
        return parseJsonArray(e.items);
      }
    }
  }
  return [];
}

// -------------------------------------------------------------- get_chain

/** Blue's hard ceiling on traversal depth. */
export const MAX_CHAIN_DEPTH = 10;

/**
 * Follow reference chains to build a context subgraph. Port of
 * memory.py::get_chain (v4.3.0, #283).
 *
 * Three properties are observable and all three are transcribed exactly:
 *
 *  1. **Order is pre-order DFS.** The root lands first, then each ref is fully
 *     expanded before the next sibling starts. The refs array's own order is the
 *     sibling order. Anything that batches or parallelises the fetches would
 *     change the output, so the traversal awaits one row at a time.
 *  2. **Cycle safety is a visited set marked on entry**, before the row is even
 *     fetched — so a memory reached first at depth 3 is never re-emitted at
 *     depth 1 by a later branch, and a missing row still blocks re-entry.
 *  3. **The depth cap is `min(depth, 10)` with no floor.** A negative depth
 *     yields an empty chain because the root itself fails `0 > depth`.
 *
 * String refs are followed directly; dict refs are followed via their `id`, and
 * `_type: "alternatives"` entries are skipped — they are payload, not edges.
 *
 * DIVERGENCE — the root id is resolved from a partial prefix (blue does not),
 * for the same one-tool-one-id-argument reason as getAlternatives. Refs
 * themselves are NOT resolved: they are stored full uuids, and prefix-resolving
 * them would turn a dangling ref into an ambiguity error mid-traversal.
 */
export async function getChain(
  client: Client,
  memoryId: string,
  depth = 3,
): Promise<ParsedMemory[]> {
  const cap = Math.min(depth, MAX_CHAIN_DEPTH);
  const rootId = await resolveMemoryId(client, memoryId);

  const visited = new Set<string>();
  const result: ParsedMemory[] = [];

  const traverse = async (mid: string, currentDepth: number): Promise<void> => {
    if (visited.has(mid) || currentDepth > cap) return;
    visited.add(mid);

    const rs = await client.execute({ sql: GET_MEMORY_SQL, args: [mid] });
    const rows = rowsOf(rs);
    if (rows.length === 0) return;

    // Blue reads the raw row here and json.loads refs inline rather than calling
    // _parse_memory_row. Parsing uniformly is equivalent for traversal — a
    // malformed refs column yields [] and so stops the descent exactly as blue's
    // `except JSONDecodeError: return` does — and it lets one formatter serve
    // every mode.
    const memory = parseMemoryRow(rows[0]);
    memory._chain_depth = currentDepth;
    result.push(memory);

    for (const ref of memory.refs) {
      if (typeof ref === "string") {
        await traverse(ref, currentDepth + 1);
      } else if (ref !== null && typeof ref === "object" && !Array.isArray(ref)) {
        const r = ref as Record<string, unknown>;
        if (r._type === "alternatives") continue;
        if (r.id) await traverse(String(r.id), currentDepth + 1);
      }
    }
  };

  await traverse(rootId, 0);
  return result;
}

// -------------------------------------------------------------- config

/**
 * Read one config value. Port of config.py::config_get.
 *
 * The `MUNINN_INSTRUMENT_FIRES` branch is deliberately not ported: `config_fire`
 * is an UPDATE, and this deployment has no write path.
 */
export async function configGet(client: Client, key: string): Promise<string | null> {
  const rs = await client.execute({ sql: CONFIG_GET_SQL, args: [key] });
  const rows = rowsOf(rs);
  return rows.length > 0 ? String(rows[0].value) : null;
}

export interface ConfigRow {
  key: string;
  value: string;
  category: string;
  updated_at: string;
  char_limit: number | null;
  read_only: number | string | boolean | null;
  boot_load: number | string | boolean | null;
  priority: number | null;
}

/**
 * List config entries, optionally filtered by category. Port of
 * config.py::config_list — note the two branches sort differently.
 */
export async function configList(
  client: Client,
  category?: string,
): Promise<ConfigRow[]> {
  const rs = category
    ? await client.execute({ sql: CONFIG_LIST_CATEGORY_SQL, args: [category] })
    : await client.execute({ sql: CONFIG_LIST_SQL, args: [] });
  return rowsOf(rs) as unknown as ConfigRow[];
}

/**
 * Turso hands boolean columns back as strings as often as ints — config.py's
 * config_set carries the same defensive tuple check for exactly this reason.
 */
export function truthyFlag(v: unknown): boolean {
  return !(v === null || v === undefined || v === 0 || v === "0" || v === false ||
    v === "false" || v === "False" || v === "");
}
