/**
 * Write path — remember, supersede, forget, config_set.
 *
 * Ports of memory.py::remember / ::supersede / ::forget and config.py::config_set
 * (remembering 5.x). Same discipline as the read path: transcribe blue's SQL and
 * defaults, do not improve them, so a row written here is indistinguishable from
 * one the Python skill wrote except for its `source` stamp (`mcp@<version>`,
 * which provenance.py already anticipates).
 *
 * WHY THIS EXISTS (2026-09-19): in Cowork every read of a project doc is
 * transcript, so the Turso token leaked on every boot. Reads already came
 * through this Worker; with writes here too the container needs no Turso
 * credential at all, and the Python skill's write path becomes optional.
 *
 * Deliberately NOT ported, each a background best-effort in blue:
 *  - tag co-occurrence maintenance (`_update_cooccurrence_add/remove`). The
 *    PMI table drifts slightly until blue's next `_build_cooccurrence`; recall
 *    expansion degrades gracefully on a stale table. Port when measured.
 *  - `config_fire` instrumentation on config_get (read path, unchanged).
 *  - `remember_bg` / `flush` — every write here is synchronous by construction.
 */

import type { Client } from "@libsql/client/web";
import type { Config, Deps } from "./tools.ts";
import { defaultDeps } from "./tools.ts";
import { configGet, expandRefId, resolveMemoryId, truthyFlag } from "./queries.ts";

/** state.py::TYPES */
export const TYPES = new Set([
  "decision", "world", "anomaly", "experience", "interaction", "procedure", "analysis",
]);

/** memory.py::VALID_DRIFT_CLASSES */
export const DRIFT_CLASSES = new Set(["additive", "narrowing", "broadening", "replacing"]);

/** config.py::config_set's category check */
export const CONFIG_CATEGORIES = new Set(["profile", "ops", "journal"]);

/** memory.py::remember default idempotency_window, seconds. */
export const IDEMPOTENCY_WINDOW_S = 60;

/** provenance.py: `<writer>@<version>`; the writer name is what audits filter on. */
export const WRITE_SOURCE_PREFIX = "mcp";

/** state.py::get_session_id fallback, with the surface named so rows are attributable. */
export const SESSION_ID = "mcp-session";

/** Injectable for tests — the Python side uses `datetime.now(UTC)` and `uuid4()`. */
export interface WriteDeps extends Deps {
  now?: () => Date;
  uuid?: () => string;
  version?: string;
}

const isoNow = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const clampPriority = (p: number) => Math.max(-1, Math.min(2, p));
const resolveDeps = (deps: WriteDeps) => ({
  now: deps.now ?? (() => new Date()),
  uuid: deps.uuid ?? (() => crypto.randomUUID()),
  source: `${WRITE_SOURCE_PREFIX}@${deps.version ?? "0"}`,
});

// blue writes ISO with microseconds; Turso stores text, so second precision here
// is a visible difference only in the string, never in ordering across writers.

function rowsOf(rs: { rows: unknown }): Record<string, unknown>[] {
  return (rs.rows ?? []) as Record<string, unknown>[];
}

/** The INSERT both remember() and supersede() share, verbatim from memory.py. */
const INSERT_MEMORY_SQL =
  `INSERT INTO memories (id, type, t, summary, confidence, tags, refs, priority,
     session_id, created_at, updated_at, valid_from, access_count, last_accessed, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`;

const IDEMPOTENCY_SQL =
  "SELECT id FROM memories WHERE deleted_at IS NULL AND type = ? " +
  "AND summary = ? AND t >= ? ORDER BY t DESC LIMIT 1";

const SUPERSEDE_ORIGINAL_SQL =
  "UPDATE memories SET deleted_at = ?, is_superseded = 1, superseded_by = ? WHERE id = ?";

const PRIORITY_SQL = "SELECT priority FROM memories WHERE id = ?";
const FORGET_SQL = "UPDATE memories SET deleted_at = ? WHERE id = ?";

const CONFIG_FLAGS_SQL = "SELECT read_only, boot_load FROM config WHERE key = ?";
const CONFIG_UPSERT_SQL =
  `INSERT OR REPLACE INTO config (key, value, category, updated_at, char_limit, read_only, boot_load, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * memory.py: every remember()/supersede() with tags appends novel ones to the
 * `recall-triggers` ops entry. Best-effort in blue (wrapped in `except: pass`),
 * best-effort here. Goes through configSet so boot_load is preserved — that
 * preservation exists for exactly this key.
 */
async function appendRecallTriggers(
  client: Client, tags: string[], deps: WriteDeps,
): Promise<void> {
  if (tags.length === 0) return;
  try {
    const raw = await configGet(client, "recall-triggers");
    let current: string[] = [];
    if (raw) {
      try { current = JSON.parse(raw); } catch { current = []; }
    }
    const set = new Set(current);
    const novel = tags.filter((t) => !set.has(t));
    if (novel.length === 0) return;
    for (const t of novel) set.add(t);
    await configSetRow(client, {
      key: "recall-triggers",
      value: JSON.stringify([...set].sort()),
      category: "ops",
    }, deps);
  } catch {
    // Never fail the memory write over the vocabulary cache.
  }
}

// ---------------------------------------------------------------- remember

export interface Alternative { option: string; rejected?: string }

export interface RememberArgs {
  summary: string;
  type: string;
  tags?: string[];
  conf?: number;
  refs?: string[];
  priority?: number;
  valid_from?: string;
  alternatives?: Alternative[];
  /** When set, this is a supersede: the named memory is retired in favour of this one. */
  supersedes?: string;
  drift_class?: string;
}

export interface WriteResult { id: string; note?: string }

/**
 * memory.py::remember, sync path only.
 *
 * Idempotency window, type defaults for conf, the procedure priority floor,
 * priority clamp, ref expansion and the alternatives-in-refs encoding are all
 * transcribed. When `supersedes` is given the call is routed to supersede()
 * instead — one tool schema for both write shapes (server.ts's tool budget).
 */
export async function remember(
  config: Config,
  args: RememberArgs,
  deps: WriteDeps = defaultDeps,
): Promise<WriteResult> {
  if (args.supersedes) return supersede(config, args, deps);

  const type = String(args.type ?? "");
  if (!TYPES.has(type)) {
    throw new Error(`Invalid type '${type}'. Must be one of: ${[...TYPES].sort().join(", ")}`);
  }
  const summary = String(args.summary ?? "");
  if (!summary.trim()) throw new Error("`summary` is required.");
  if (args.drift_class) throw new Error("`drift_class` only applies with `supersedes`.");

  const client = deps.db(config);
  const { now, uuid, source } = resolveDeps(deps);
  const t = now();
  const nowIso = isoNow(t);

  const cutoff = isoNow(new Date(t.getTime() - IDEMPOTENCY_WINDOW_S * 1000));
  try {
    const dup = rowsOf(await client.execute({ sql: IDEMPOTENCY_SQL, args: [type, summary, cutoff] }));
    if (dup.length) {
      return { id: String(dup[0].id), note: "duplicate within idempotency window; existing id returned" };
    }
  } catch {
    // Best-effort in blue too; fall through to the write.
  }

  let conf = args.conf ?? null;
  if (type === "decision" && conf === null) conf = 0.8;
  if (type === "procedure" && conf === null) conf = 0.9;
  let priority = Number.isFinite(Number(args.priority)) ? Number(args.priority) : 0;
  if (type === "procedure" && priority === 0) priority = 1;
  priority = clampPriority(priority);

  const tags = (args.tags ?? []).map(String);
  const refs: unknown[] = [];
  for (const r of args.refs ?? []) refs.push(await expandRefId(client, String(r)));
  if (args.alternatives && args.alternatives.length) {
    if (type !== "decision") {
      throw new Error("alternatives parameter is only valid for type='decision' memories");
    }
    for (const a of args.alternatives) {
      if (!a || typeof a !== "object" || !("option" in a)) {
        throw new Error("Each alternative must be an object with at least an 'option' key");
      }
    }
    refs.push({ _type: "alternatives", items: args.alternatives });
  }

  const id = uuid();
  await client.execute({
    sql: INSERT_MEMORY_SQL,
    args: [
      id, type, nowIso, summary, conf, JSON.stringify(tags), JSON.stringify(refs), priority,
      SESSION_ID, nowIso, nowIso, args.valid_from ?? nowIso, source,
    ],
  });
  await appendRecallTriggers(client, tags, deps);
  return { id };
}

// --------------------------------------------------------------- supersede

/**
 * memory.py::supersede. Priority inherits from the original unless given;
 * the procedure floor and clamp then apply; the original is soft-deleted,
 * flagged and pointed at its replacement in the same batch as the insert.
 */
export async function supersede(
  config: Config,
  args: RememberArgs,
  deps: WriteDeps = defaultDeps,
): Promise<WriteResult> {
  const type = String(args.type ?? "");
  if (!TYPES.has(type)) {
    throw new Error(`Invalid type '${type}'. Must be one of: ${[...TYPES].sort().join(", ")}`);
  }
  const summary = String(args.summary ?? "");
  if (!summary.trim()) throw new Error("`summary` is required.");

  let tags = (args.tags ?? []).map(String);
  if (args.drift_class !== undefined) {
    if (!DRIFT_CLASSES.has(args.drift_class)) {
      throw new Error(
        `Invalid drift_class '${args.drift_class}'. Must be one of ${[...DRIFT_CLASSES].join(", ")}.`,
      );
    }
    const tag = `drift-class-${args.drift_class}`;
    if (!tags.includes(tag)) tags = [...tags, tag];
  }

  const client = deps.db(config);
  const { now, uuid, source } = resolveDeps(deps);
  const originalId = await resolveMemoryId(client, String(args.supersedes));
  const nowIso = isoNow(now());
  const newId = uuid();

  let priority: number;
  if (args.priority === undefined || args.priority === null) {
    const rows = rowsOf(await client.execute({ sql: PRIORITY_SQL, args: [originalId] }));
    priority = rows.length ? Number(rows[0].priority) : (type === "procedure" ? 1 : 0);
    if (!Number.isFinite(priority)) priority = 0;
  } else {
    priority = Number(args.priority);
  }
  if (type === "procedure" && priority === 0) priority = 1;
  priority = clampPriority(priority);

  await client.batch([
    { sql: SUPERSEDE_ORIGINAL_SQL, args: [nowIso, newId, originalId] },
    {
      sql: INSERT_MEMORY_SQL,
      args: [
        newId, type, nowIso, summary, args.conf ?? 0.8, JSON.stringify(tags),
        JSON.stringify([originalId]), priority, SESSION_ID, nowIso, nowIso, nowIso, source,
      ],
    },
  ], "write");
  await appendRecallTriggers(client, tags, deps);
  return { id: newId, note: `supersedes ${originalId}` };
}

// ------------------------------------------------------------------ forget

export interface ForgetArgs { id: string }

/** memory.py::forget — soft delete by full id or unique prefix. */
export async function forget(
  config: Config,
  args: ForgetArgs,
  deps: WriteDeps = defaultDeps,
): Promise<WriteResult> {
  const client = deps.db(config);
  const { now } = resolveDeps(deps);
  const id = await resolveMemoryId(client, String(args.id ?? "").trim());
  await client.execute({ sql: FORGET_SQL, args: [isoNow(now()), id] });
  return { id, note: "forgotten (soft-deleted)" };
}

// -------------------------------------------------------------- config_set

export interface ConfigSetArgs {
  key: string;
  value: string;
  category: string;
  char_limit?: number | null;
  read_only?: boolean;
  boot_load?: boolean | null;
}

/**
 * config.py::config_set. The three rules that matter, all transcribed:
 * a `read_only` row refuses the write; an existing row keeps its `boot_load`
 * unless the caller says otherwise; a new row defaults to boot_load=0.
 */
export async function configSetRow(
  client: Client,
  args: ConfigSetArgs,
  deps: WriteDeps,
): Promise<void> {
  const category = String(args.category ?? "");
  if (!CONFIG_CATEGORIES.has(category)) {
    throw new Error(`Invalid category '${category}'. Must be 'profile', 'ops', or 'journal'`);
  }
  const key = String(args.key ?? "").trim();
  if (!key) throw new Error("`key` is required.");
  const value = String(args.value ?? "");

  const existing = rowsOf(await client.execute({ sql: CONFIG_FLAGS_SQL, args: [key] }));
  let bootLoad: number;
  if (existing.length) {
    if (truthyFlag(existing[0].read_only)) {
      throw new Error(`Config key '${key}' is marked read-only and cannot be modified`);
    }
    bootLoad = args.boot_load === undefined || args.boot_load === null
      ? (truthyFlag(existing[0].boot_load) ? 1 : 0)
      : (args.boot_load ? 1 : 0);
  } else {
    bootLoad = args.boot_load ? 1 : 0;
  }

  const charLimit = args.char_limit ?? null;
  if (charLimit && value.length > charLimit) {
    throw new Error(
      `Value exceeds char_limit (${value.length} > ${charLimit}). ` +
      `Current value length: ${value.length}, limit: ${charLimit}`,
    );
  }

  const { now, source } = resolveDeps(deps);
  await client.execute({
    sql: CONFIG_UPSERT_SQL,
    args: [key, value, category, isoNow(now()), charLimit, args.read_only ? 1 : 0, bootLoad, source],
  });
}

export async function configSet(
  config: Config,
  args: ConfigSetArgs,
  deps: WriteDeps = defaultDeps,
): Promise<string> {
  await configSetRow(deps.db(config), args, deps);
  return `[config] ${String(args.key).trim()} set (${args.category}).`;
}

// ------------------------------------------------------------- formatting

export function formatWrite(verb: string, r: WriteResult): string {
  return r.note ? `${verb} ${r.id} — ${r.note}` : `${verb} ${r.id}`;
}
