/**
 * Coverage for the addressed-read query layer, with Turso faked.
 *
 * Same hand-rolled harness as `tools.test.ts` — no framework, a fake client that
 * routes on SQL text and records every call, so "took no round trip" is itself
 * an assertion rather than a hope.
 */
import type { Client } from "@libsql/client/web";
import {
  configGet,
  configList,
  getAlternatives,
  getChain,
  getMemory,
  isFullUuid,
  MemoryIdError,
  parseJsonArray,
  parseMemoryRow,
  resolveMemoryId,
  truthyFlag,
  CONFIG_LIST_CATEGORY_SQL,
  CONFIG_LIST_SQL,
} from "./queries.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

/** Assert that an awaited call rejects, and hand the message to a predicate. */
const throws = async (n: string, fn: () => Promise<unknown>, want: (m: string) => boolean) => {
  try {
    await fn();
    fail++; console.log(`FAIL ${n}\n  got:  no error`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    want(m) && err instanceof MemoryIdError
      ? (pass++, console.log("OK  " + n))
      : (fail++, console.log(`FAIL ${n}\n  got:  ${m}`));
  }
};

interface Call { sql: string; args: unknown[] }
type Handler = (sql: string, args: unknown[]) => Record<string, unknown>[];

function fake(handler: Handler) {
  const calls: Call[] = [];
  const client = {
    execute: async ({ sql, args }: { sql: string; args: unknown[] }) => {
      calls.push({ sql, args });
      return { rows: handler(sql, args ?? []) };
    },
  } as unknown as Client;
  return { client, calls };
}

interface Mem { refs?: unknown[]; summary?: string; tags?: unknown }
/** A fake corpus: serves prefix resolution and SELECT * from the same map. */
function corpus(mems: Record<string, Mem>): Handler {
  return (sql, args) => {
    if (sql.includes("SELECT id FROM memories")) {
      const prefix = String(args[0]).replace(/%$/, "");
      return Object.keys(mems).filter((k) => k.startsWith(prefix)).sort().map((id) => ({ id }));
    }
    if (sql.includes("SELECT * FROM memories") || sql.includes("SELECT refs FROM memories")) {
      const m = mems[String(args[0])];
      if (!m) return [];
      return [{
        id: args[0], type: "note", t: "2026-07-28T00:00:00Z",
        summary: m.summary ?? String(args[0]), confidence: 0.5, priority: 0,
        tags: m.tags === undefined ? "[]" : m.tags, entities: "[]",
        refs: JSON.stringify(m.refs ?? []),
      }];
    }
    return [];
  };
}

// ------------------------------------------------------------------ uuid shape

eq("full uuid is 36 chars with 4 hyphens", isFullUuid("a7edfdb0-1111-2222-3333-444455556666"), true);
eq("a prefix is not a full uuid", isFullUuid("a7edfdb0"), false);
// Blue checks shape, not validity: same length, wrong hyphen count.
eq("36 chars with 3 hyphens is not a full uuid", isFullUuid("a7edfdb0-1111-2222-33334444555566667"), false);

// ------------------------------------------------------------- id resolution

{
  const { client, calls } = fake(() => { throw new Error("must not query"); });
  const id = "a7edfdb0-1111-2222-3333-444455556666";
  eq("full uuid resolves to itself", await resolveMemoryId(client, id), id);
  // The whole point of the shape check: the hot path costs zero round trips.
  eq("full uuid takes no DB round trip", calls.length, 0);
}

{
  const { client, calls } = fake(corpus({ "abc123": {}, "zzz999": {} }));
  eq("unique prefix resolves", await resolveMemoryId(client, "abc"), "abc123");
  eq("prefix resolution makes exactly one round trip", calls.length, 1);
  eq("the wildcard rides in the param, not the SQL", calls[0].args, ["abc%"]);
}

{
  const { client } = fake(corpus({ "abc123": {} }));
  await throws(
    "unknown prefix errors distinctly",
    () => resolveMemoryId(client, "nope"),
    (m) => m === "No active memory found matching prefix 'nope'",
  );
}

{
  const mems: Record<string, Mem> = {};
  for (let i = 0; i < 7; i++) mems[`aaaaaaaa-${i}111-2222-3333-444455556666`] = {};
  const { client } = fake(corpus(mems));
  await throws(
    "ambiguous prefix errors and names the candidates",
    () => resolveMemoryId(client, "aaaaaaaa"),
    (m) =>
      m.startsWith("Partial id 'aaaaaaaa' matches 7 memories: [") &&
      // Blue truncates each candidate to 12 chars and lists at most 5 of them.
      m.includes("'aaaaaaaa-011...'") &&
      m.split("...").length - 1 === 5 &&
      !m.includes("-5111") &&
      m.endsWith("Provide a longer prefix for a unique match."),
  );
}

// ------------------------------------------------------------------ parsing

eq("malformed JSON degrades to empty", parseJsonArray("{not json"), []);
eq("null degrades to empty", parseJsonArray(null), []);
eq("empty string degrades to empty", parseJsonArray(""), []);
eq("non-array JSON degrades to empty", parseJsonArray('"scalar"'), []);
eq("a JSON array parses", parseJsonArray('["a","b"]'), ["a", "b"]);

{
  // _parse_memory_row handles three columns, not just tags.
  const p = parseMemoryRow({
    id: "x", tags: '["a"]', entities: '["e"]', refs: '["r"]', summary: "s", session_id: "sess",
  });
  eq("tags parse", p.tags, ["a"]);
  eq("entities parse", p.entities, ["e"]);
  eq("refs parse", p.refs, ["r"]);
  eq("unformatted columns survive the parse", p.session_id, "sess");
}
eq("one malformed column does not poison the others",
   parseMemoryRow({ tags: "{nope", refs: '["r"]' }).refs, ["r"]);

// ---------------------------------------------------------------------- get

{
  const { client } = fake(corpus({ "abc123": { tags: '["arch"]' } }));
  const m = await getMemory(client, "abc");
  eq("get resolves a prefix and returns the row", m?.id, "abc123");
  eq("get parses tags", m?.tags, ["arch"]);
}
{
  // A full uuid never resolves, so a nonexistent one comes back as null rather
  // than as the resolver's "no match" error. Blue has the same asymmetry.
  const { client } = fake(corpus({}));
  eq("get returns null for an absent full uuid",
     await getMemory(client, "a7edfdb0-1111-2222-3333-444455556666"), null);
}

// ------------------------------------------------------------- alternatives

{
  const alts = [{ option: "Postgres", rejected: "no edge presence" }, { option: "DuckDB" }];
  const { client } = fake(corpus({
    "dec1": { refs: ["prov-id", { _type: "alternatives", items: alts }] },
  }));
  eq("alternatives are dug out of refs", await getAlternatives(client, "dec1"), alts);
}
{
  const { client } = fake(corpus({ "dec2": { refs: ["just-provenance"] } }));
  eq("no alternatives entry yields an empty list", await getAlternatives(client, "dec2"), []);
}
{
  const { client } = fake(corpus({ "dec3": { refs: [{ _type: "alternatives" }] } }));
  eq("an alternatives entry without items yields an empty list",
     await getAlternatives(client, "dec3"), []);
}
{
  // Blue swallows JSONDecodeError and returns []; a decade-old malformed refs
  // column must not fail the read.
  const { client } = fake((sql, args) =>
    sql.includes("SELECT id FROM memories") ? [{ id: "dec4" }] : [{ refs: "{not json" }]);
  eq("malformed refs JSON yields an empty list", await getAlternatives(client, "dec4"), []);
}
{
  // DIVERGENCE from blue, which returns [] here too — green distinguishes so the
  // formatter can say "not found" rather than "no alternatives".
  const { client } = fake(corpus({}));
  eq("alternatives on an absent memory is null, not empty",
     await getAlternatives(client, "a7edfdb0-1111-2222-3333-444455556666"), null);
}

// -------------------------------------------------------------------- chain

const depths = (c: { _chain_depth?: number }[]) => c.map((m) => m._chain_depth);
const ids = (c: { id: string }[]) => c.map((m) => m.id);

{
  // Pre-order DFS: a child is fully expanded before the next sibling starts.
  const { client } = fake(corpus({
    a: { refs: ["b", "c"] }, b: { refs: ["d"] }, c: {}, d: {},
  }));
  const chain = await getChain(client, "a", 5);
  eq("chain order is pre-order DFS", ids(chain), ["a", "b", "d", "c"]);
  eq("chain annotates depth", depths(chain), [0, 1, 2, 1]);
}

{
  // visited is marked on ENTRY, so c is claimed at depth 2 via b and a's own
  // direct edge to c never re-emits it at depth 1.
  const { client } = fake(corpus({ a: { refs: ["b", "c"] }, b: { refs: ["c"] }, c: {} }));
  const chain = await getChain(client, "a", 5);
  eq("a node is claimed by its first visit, not its shallowest", depths(chain), [0, 1, 2]);
  eq("no node is emitted twice", ids(chain), ["a", "b", "c"]);
}

{
  const { client } = fake(corpus({ a: { refs: ["b"] }, b: { refs: ["a"] } }));
  const chain = await getChain(client, "a", 5);
  eq("a cycle terminates", ids(chain), ["a", "b"]);
}

{
  const mems: Record<string, Mem> = {};
  for (let i = 0; i < 15; i++) mems[`n${i}`] = { refs: [`n${i + 1}`] };
  const { client } = fake(corpus(mems));
  const chain = await getChain(client, "n0", 99);
  // min(depth, 10) — depths 0..10 inclusive is 11 rows, not 10.
  eq("chain depth caps at 10 regardless of the request", chain.length, 11);
  eq("the deepest row is at depth 10", chain[chain.length - 1]._chain_depth, 10);
}

{
  const { client } = fake(corpus({
    a: { refs: [{ _type: "alternatives", items: [], id: "b" }, { id: "b" }, { noId: 1 }] },
    b: {},
  }));
  const chain = await getChain(client, "a", 3);
  // The alternatives entry carries an id here on purpose: it must still be
  // skipped, and b must be reached by the following plain dict ref.
  eq("alternatives entries are payload, not edges", ids(chain), ["a", "b"]);
}

{
  const { client } = fake(corpus({ a: { refs: ["missing", "b"] }, b: {} }));
  eq("a dangling ref does not stop the traversal", ids(await getChain(client, "a", 3)), ["a", "b"]);
}

{
  const { client } = fake(corpus({ a: {} }));
  // min() has no floor in blue, so the root itself fails `0 > depth`.
  eq("a negative depth yields an empty chain", await getChain(client, "a", -1), []);
}

{
  const { client } = fake(corpus({}));
  eq("chain on an absent memory is empty",
     await getChain(client, "a7edfdb0-1111-2222-3333-444455556666", 3), []);
}

// ------------------------------------------------------------------- config

{
  const { client, calls } = fake((sql) =>
    sql.includes("FROM config") ? [{ value: "Muninn is a memory" }] : []);
  eq("config get returns the value", await configGet(client, "identity"), "Muninn is a memory");
  eq("config get queries by key", calls[0].args, ["identity"]);
}
{
  const { client } = fake(() => []);
  eq("config get miss is null", await configGet(client, "nope"), null);
}
{
  const { client, calls } = fake(() => [{ key: "a", category: "ops", value: "v" }]);
  await configList(client);
  eq("unfiltered list sorts by category then key", calls[0].sql, CONFIG_LIST_SQL);
  eq("unfiltered list takes no params", calls[0].args, []);
  await configList(client, "ops");
  eq("filtered list uses the category branch", calls[1].sql, CONFIG_LIST_CATEGORY_SQL);
  eq("filtered list passes the category", calls[1].args, ["ops"]);
}

// Turso hands boolean columns back as ints or as strings depending on the path.
eq("truthyFlag: int 1", truthyFlag(1), true);
eq("truthyFlag: string '1'", truthyFlag("1"), true);
eq("truthyFlag: int 0", truthyFlag(0), false);
eq("truthyFlag: string '0'", truthyFlag("0"), false);
eq("truthyFlag: null", truthyFlag(null), false);
eq("truthyFlag: string 'false'", truthyFlag("false"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
