/** Coverage for formatting and dispatch, with Turso injected. */
import {
  formatRecall, relativeAge, recall,
  formatMemory, formatChain, formatAlternatives, formatConfigList,
  memoryGet, muninnConfig,
  sanitizeError, errorText,
  type Deps,
} from "./tools.ts";
import { parseMemoryRow, type ConfigRow } from "./queries.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

const NOW = new Date("2026-07-29T00:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: "a7edfdb0-1111-2222-3333-444455556666",
  type: "decision",
  t: "2026-07-28T00:00:00Z",
  summary: "Muninn remote MCP is TypeScript on Workers",
  confidence: 0.9,
  tags: '["architecture","mcp"]',
  refs: "[]",
  priority: 1,
  created_at: "2026-07-28T00:00:00Z",
  ...over,
});

eq("relativeAge minutes", relativeAge("2026-07-28T23:30:00Z", NOW), "30m ago");
eq("relativeAge hours", relativeAge("2026-07-28T12:00:00Z", NOW), "12h ago");
eq("relativeAge days", relativeAge("2026-07-20T00:00:00Z", NOW), "9d ago");
eq("relativeAge months", relativeAge("2026-03-01T00:00:00Z", NOW), "5mo ago");
eq("relativeAge years", relativeAge("2024-07-01T00:00:00Z", NOW), "2y ago");
eq("relativeAge rejects junk", relativeAge("not-a-date", NOW), "unknown");

eq("empty result is stated, not empty", formatRecall([], NOW), "No memories matched.");

// ---------------------------------------------------------------- error sanitizing
// A tool response is model context: it can land in a transcript, a log, or a
// shared conversation. libsql/fetch errors quote the failing request, and the
// request carries the Turso token — so this is on every tool's catch path.

eq("bearer tokens are redacted",
   sanitizeError(new Error("401 from Bearer eyJhbGciOi.secret.sig")),
   "401 from Bearer [REDACTED]");
eq("single-quoted Authorization header is redacted (blue's Python-dict shape)",
   sanitizeError("{'Authorization': 'Bearer abc123'}"),
   "{'Authorization': '[REDACTED]'}");
eq("double-quoted Authorization header is redacted",
   sanitizeError('{"Authorization": "Bearer abc123"}'),
   '{"Authorization": "[REDACTED]"}');
// The shape a JS Headers object stringifies to — blue's patterns miss this one.
eq("unquoted Authorization header is redacted",
   sanitizeError("headers: Authorization: Bearer abc123, host: x"),
   "headers: Authorization: [REDACTED], host: x");
eq("an innocent message survives intact",
   sanitizeError(new Error("no such table: memory_fts")),
   "no such table: memory_fts");
eq("a non-Error is still sanitized", sanitizeError("Bearer leak"), "Bearer [REDACTED]");
eq("errorText prefixes and truncates",
   errorText(new Error("x".repeat(400))).length, 307);
eq("errorText sanitizes before truncating, so a token cannot survive in the tail",
   errorText(new Error("Bearer supersecrettoken " + "y".repeat(400))).includes("supersecret"),
   false);

const out = formatRecall([row() as never], NOW);
eq("id is truncated to 8 chars", out.includes("[a7edfdb0]"), true);
eq("full uuid is not leaked", out.includes("1111-2222"), false);
eq("type is shown", out.includes("decision"), true);
eq("tags are rendered", out.includes('["architecture","mcp"]'), true);
eq("relative age is rendered", out.includes("(1d ago)"), true);
// Summaries are multi-line in the corpus; a raw newline would break the one-row
// -per-memory shape the client sees.
eq("newlines in a summary are flattened",
   formatRecall([row({ summary: "a\nb" }) as never], NOW).includes("a b"), true);
// The id is always bracketed, so probe for a rendered tag ARRAY specifically.
const badTags = formatRecall([row({ tags: "{not json" }) as never], NOW);
eq("malformed tags JSON degrades to no tags", /\[\s*"/.test(badTags), false);
eq("malformed tags still renders the row", badTags.includes("[a7edfdb0]"), true);

const deps: Deps = { db: () => ({ execute: async () => ({ rows: [row()] }) }) as never };
const text = await recall({ TURSO_URL: "x", TURSO_TOKEN: "y" }, { query: "mcp" }, deps);
eq("recall formats through the same path", text.includes("[a7edfdb0]"), true);

let captured: Record<string, unknown> = {};
const capture: Deps = {
  // Capture the FTS SEARCH specifically, not "whatever ran last". `recall` now
  // routes through expansion.ts, and this fake returns zero rows — which is a
  // sparse result, so the expansion fires and issues `tag_cooccurrence` queries
  // AFTER the search. Those end in the co-occurrence LIMIT (10), so the clamp
  // assertions below would read the wrong statement's trailing param.
  db: () => ({
    execute: async (q: Record<string, unknown>) => {
      if (typeof q !== "string" && String(q.sql).includes("memory_fts")) captured = q;
      return { rows: [] };
    },
  }) as never,
};
await recall({ TURSO_URL: "x", TURSO_TOKEN: "y" }, { query: "z", n: 999 }, capture);
eq("n is capped at 50", (captured.args as unknown[])[(captured.args as unknown[]).length - 1], 50);
await recall({ TURSO_URL: "x", TURSO_TOKEN: "y" }, { query: "z", n: 0 }, capture);
eq("n floors at 1 rather than 0", (captured.args as unknown[])[(captured.args as unknown[]).length - 1], 10);

// ------------------------------------------------------- memory_get formatting

const CFG = { TURSO_URL: "x", TURSO_TOKEN: "y" };
const parsed = (over: Record<string, unknown> = {}) => parseMemoryRow(row(over) as never);

{
  const out = formatMemory(parsed(), NOW);
  // Same two-line block recall emits, so the client learns one shape.
  eq("get reuses the recall block", out.startsWith("- [a7edfdb0] decision"), true);
  eq("get renders confidence", out.includes("conf 0.90"), true);
  eq("get renders priority", out.includes("priority 1"), true);
  // The one place the full id is shown: a caller who asked for one memory is the
  // one most likely to need the exact id to pass on.
  eq("get renders the full id", out.includes("id a7edfdb0-1111-2222-3333-444455556666"), true);
  eq("missing confidence renders a dash, not NaN",
     formatMemory(parsed({ confidence: null }), NOW).includes("conf —"), true);
}

{
  const chain = [
    parsed({ id: "aaaaaaaa-0000-0000-0000-000000000000", _chain_depth: 0 }),
    parsed({ id: "bbbbbbbb-0000-0000-0000-000000000000", _chain_depth: 1 }),
    parsed({ id: "cccccccc-0000-0000-0000-000000000000", _chain_depth: 2 }),
  ];
  const out = formatChain(chain, "aaaaaaaa", 3, NOW);
  eq("chain states its size and cap",
     out.split("\n")[0], "Reference chain from aaaaaaaa — 3 memories, max depth 3:");
  eq("depth is badged", out.includes("- d2 [cccccccc]"), true);
  eq("depth is indented", out.includes("\n    - d2 [cccccccc]"), true);
  // Traversal order is observable; the formatter must not regroup it.
  eq("chain order is preserved",
     out.indexOf("[bbbbbbbb]") < out.indexOf("[cccccccc]"), true);
}
eq("an empty chain is a stated not-found",
   formatChain([], "deadbeef", 3, NOW), "No active memory found with id 'deadbeef'.");

eq("alternatives on an absent memory says not found",
   formatAlternatives(null, "deadbeef"), "No active memory found with id 'deadbeef'.");
eq("no alternatives recorded is stated, not empty",
   formatAlternatives([], "abc123"), "No alternatives recorded for 'abc123'.");
{
  const out = formatAlternatives(
    [{ option: "Postgres", rejected: "no edge presence" }, { option: "DuckDB" }], "abc123");
  eq("alternatives are counted", out.split("\n")[0], "2 alternatives recorded for 'abc123':");
  eq("a rejection reason is rendered", out.includes("- Postgres — rejected: no edge presence"), true);
  // Blue's own docstring example uses this exact fallback wording.
  eq("a missing reason is named", out.includes("- DuckDB — rejected: no reason given"), true);
}

// ---------------------------------------------------- muninn_config formatting

const cfgRow = (over: Partial<ConfigRow> = {}): ConfigRow => ({
  key: "identity", value: "Muninn is a memory", category: "profile",
  updated_at: "2026-07-28T00:00:00Z", char_limit: null,
  read_only: 0, boot_load: 1, priority: 0, ...over,
});

eq("an empty config list is stated", formatConfigList([]), "No config entries.");
eq("an empty filtered list names the category",
   formatConfigList([], "ops"), "No config entries in category 'ops'.");
{
  const out = formatConfigList([cfgRow(), cfgRow({ key: "rules", category: "ops", read_only: "1", boot_load: "0" })]);
  eq("the list is an index, not a dump", out.includes("Muninn is a memory"), false);
  eq("the list points at op:get", out.includes('read one with op:"get"'), true);
  eq("boot_load is flagged", out.includes("- identity (profile) boot_load · 18 chars"), true);
  // Turso returns booleans as strings as often as ints.
  eq("string flags are read as booleans", out.includes("- rules (ops) read_only · 18 chars"), true);
}

// ------------------------------------------------------------------- dispatch

/** A fake Turso that routes on SQL text, shared by the dispatch tests. */
const dep = (handler: (sql: string, args: unknown[]) => Record<string, unknown>[]): Deps => ({
  db: () => ({
    execute: async ({ sql, args }: { sql: string; args: unknown[] }) =>
      ({ rows: handler(sql, args ?? []) }),
  }) as never,
});

eq("memory_get needs an id",
   await memoryGet(CFG, { id: "  " }, dep(() => [])),
   "memory_get: an `id` is required (full uuid or unique prefix).");

// Ambiguity reaches the caller as text it can act on, not as a stack trace.
{
  const ambiguous = dep((sql) => sql.includes("SELECT id FROM memories")
    ? [{ id: "aaaaaaaa-1111-2222-3333-444455556666" }, { id: "aaaaaaaa-9999-2222-3333-444455556666" }]
    : []);
  const out = await memoryGet(CFG, { id: "aaaaaaaa" }, ambiguous);
  eq("an ambiguous prefix returns usable text", out.startsWith("Partial id 'aaaaaaaa' matches 2"), true);
  eq("the ambiguity text names the candidates", out.includes("'aaaaaaaa-111...'"), true);
  eq("the ambiguity text is not a stack trace", out.includes("    at "), false);
  // Same path, every mode — the resolver runs before the mode branch.
  eq("ambiguity surfaces in chain mode too",
     (await memoryGet(CFG, { id: "aaaaaaaa", mode: "chain" }, ambiguous)).includes("longer prefix"), true);
  eq("ambiguity surfaces in alternatives mode too",
     (await memoryGet(CFG, { id: "aaaaaaaa", mode: "alternatives" }, ambiguous)).includes("longer prefix"), true);
}

eq("an unknown prefix errors distinctly from an ambiguous one",
   await memoryGet(CFG, { id: "zzzz" }, dep(() => [])),
   "No active memory found matching prefix 'zzzz'");

eq("an absent full uuid is a stated not-found",
   await memoryGet(CFG, { id: "a7edfdb0-1111-2222-3333-444455556666" }, dep(() => [])),
   "No active memory found with id 'a7edfdb0-1111-2222-3333-444455556666'.");

{
  const one = dep((sql, args) => sql.includes("SELECT * FROM memories") ? [row({ id: args[0] })] : []);
  eq("get mode formats the memory",
     (await memoryGet(CFG, { id: "a7edfdb0-1111-2222-3333-444455556666" }, one)).includes("conf 0.90"), true);
  eq("get is the default mode",
     await memoryGet(CFG, { id: "a7edfdb0-1111-2222-3333-444455556666" }, one),
     await memoryGet(CFG, { id: "a7edfdb0-1111-2222-3333-444455556666", mode: "get" }, one));
}

{
  // A non-numeric depth must not disable the ceiling min() exists to enforce.
  const linear = dep((sql, args) => {
    if (sql.includes("SELECT id FROM memories")) return [{ id: "n0" }];
    if (!sql.includes("SELECT * FROM memories")) return [];
    const i = Number(String(args[0]).replace("n", ""));
    return [row({ id: `n${i}`, refs: JSON.stringify([`n${i + 1}`]) })];
  });
  const rowsIn = (s: string) => (s.match(/- d\d+ \[/g) ?? []).length;
  const junk = await memoryGet(CFG, { id: "n0", mode: "chain", depth: "deep" as never }, linear);
  eq("a non-numeric depth falls back to 3", junk.includes("max depth 3"), true);
  eq("a non-numeric depth still terminates", rowsIn(junk), 4);
  const capped = await memoryGet(CFG, { id: "n0", mode: "chain", depth: 99 }, linear);
  eq("an over-large depth is reported as the cap", capped.includes("max depth 10"), true);
  eq("an over-large depth stops at 11 rows (depths 0..10)", rowsIn(capped), 11);
}

eq("config get miss is a stated absence",
   await muninnConfig(CFG, { key: "nope" }, dep(() => [])),
   "No config entry for key 'nope'.");
eq("config get without a key says so",
   await muninnConfig(CFG, { op: "get" }, dep(() => [])),
   'muninn_config: `key` is required when op is "get".');
eq("config get returns the value verbatim under its key",
   await muninnConfig(CFG, { key: "identity" }, dep(() => [{ value: "Muninn is a memory" }])),
   "[config] identity\nMuninn is a memory");
eq("get is the default op",
   (await muninnConfig(CFG, { key: "identity" }, dep(() => []))).startsWith("No config entry"), true);

{
  let seen: { sql: string; args: unknown[] } = { sql: "", args: [] };
  const spy = dep((sql, args) => { seen = { sql, args }; return [cfgRow() as never]; });
  const all = await muninnConfig(CFG, { op: "list" }, spy);
  eq("an unfiltered list uses the unfiltered SQL", seen.sql.includes("WHERE category"), false);
  eq("an unfiltered list is not scoped in the text", all.includes("in category"), false);
  const scoped = await muninnConfig(CFG, { op: "list", category: "ops" }, spy);
  eq("a filtered list passes the category", seen.args, ["ops"]);
  eq("a filtered list names the category in the text", scoped.includes("in category 'ops'"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
