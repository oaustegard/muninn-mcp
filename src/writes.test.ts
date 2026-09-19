/** Write path: remember / supersede / forget / config set, with Turso faked. */
import {
  remember, supersede, forget, configSet, formatWrite,
  IDEMPOTENCY_WINDOW_S, SESSION_ID,
  type WriteDeps,
} from "./writes.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

const CFG = { TURSO_URL: "x", TURSO_TOKEN: "y" };
const NOW = new Date("2026-09-19T14:00:00Z");
const UUID = "0f0f0f0f-1111-2222-3333-444455556666";
const ORIG = "a7edfdb0-1111-2222-3333-444455556666";

interface Call { sql: string; args: unknown[] }

/**
 * A fake Turso that records every statement and routes reads on SQL text.
 * `batch` is recorded as its member statements, in order, so a supersede's
 * update+insert pair is inspectable the same way a plain execute is.
 */
function fake(handler: (sql: string, args: unknown[]) => Record<string, unknown>[] = () => []) {
  const calls: Call[] = [];
  const client = {
    execute: async ({ sql, args }: Call) => {
      calls.push({ sql, args: args ?? [] });
      return { rows: handler(sql, args ?? []) };
    },
    batch: async (stmts: Call[], mode: string) => {
      eq("batch runs in write mode", mode, "write");
      for (const s of stmts) calls.push(s);
      return stmts.map(() => ({ rows: [] }));
    },
  };
  const deps: WriteDeps = {
    db: () => client as never,
    now: () => NOW,
    uuid: () => UUID,
    version: "9.9.9",
  };
  return { calls, deps };
}

const insertOf = (calls: Call[]) => calls.find((c) => c.sql.startsWith("INSERT INTO memories"));

// ---------------------------------------------------------------- remember

{
  const { calls, deps } = fake();
  const r = await remember(CFG, { summary: "the retry was 0", type: "anomaly", tags: ["b", "a"] }, deps);
  eq("remember returns the generated id", r.id, UUID);
  const ins = insertOf(calls)!;
  eq("insert carries the blue column order",
     ins.args.slice(0, 3), [UUID, "anomaly", "2026-09-19T14:00:00Z"]);
  eq("anomaly has no default confidence", ins.args[4], null);
  eq("tags are JSON, order preserved", ins.args[5], '["b","a"]');
  eq("refs default to an empty JSON array", ins.args[6], "[]");
  eq("priority defaults to 0", ins.args[7], 0);
  eq("session id names the surface", ins.args[8], SESSION_ID);
  eq("valid_from defaults to now", ins.args[11], "2026-09-19T14:00:00Z");
  eq("source stamps mcp@<version>", ins.args[12], "mcp@9.9.9");
  const idem = calls.find((c) => c.sql.includes("ORDER BY t DESC LIMIT 1"))!;
  eq("idempotency cutoff is now minus the window",
     idem.args[2], new Date(NOW.getTime() - IDEMPOTENCY_WINDOW_S * 1000).toISOString().replace(".000Z", "Z"));
  const trig = calls.find((c) => c.sql.startsWith("INSERT OR REPLACE INTO config"))!;
  eq("novel tags are appended to recall-triggers, sorted", trig.args.slice(0, 3), ["recall-triggers", '["a","b"]', "ops"]);
  eq("recall-triggers as a NEW row lands boot_load=0", trig.args[6], 0);
}

{
  const { calls, deps } = fake();
  await remember(CFG, { summary: "s", type: "decision" }, deps);
  eq("decision defaults conf to 0.8", insertOf(calls)!.args[4], 0.8);
}
{
  const { calls, deps } = fake();
  await remember(CFG, { summary: "s", type: "procedure" }, deps);
  eq("procedure defaults conf to 0.9", insertOf(calls)!.args[4], 0.9);
  eq("procedure floors priority at 1", insertOf(calls)!.args[7], 1);
}
{
  const { calls, deps } = fake();
  await remember(CFG, { summary: "s", type: "world", priority: 7 }, deps);
  eq("priority clamps to 2", insertOf(calls)!.args[7], 2);
  await remember(CFG, { summary: "s2", type: "world", priority: -4 }, deps);
  eq("priority clamps to -1", calls.filter((c) => c.sql.startsWith("INSERT INTO memories"))[1].args[7], -1);
}

{
  // A duplicate (summary, type) inside the window returns the existing id and writes nothing.
  const { calls, deps } = fake((sql) => sql.includes("ORDER BY t DESC LIMIT 1") ? [{ id: ORIG }] : []);
  const r = await remember(CFG, { summary: "same", type: "world" }, deps);
  eq("duplicate in window returns the existing id", r.id, ORIG);
  eq("duplicate in window is flagged", r.note?.includes("idempotency"), true);
  eq("duplicate in window inserts nothing", insertOf(calls), undefined);
}

{
  const { calls, deps } = fake((sql, args) =>
    sql.includes("WHERE id LIKE ? LIMIT 2") && String(args[0]).startsWith("a7edfdb0") ? [{ id: ORIG }] : []);
  await remember(CFG, { summary: "s", type: "world", refs: ["a7edfdb0", "short"] }, deps);
  eq("a unique 8-char ref prefix expands; a too-short one is kept verbatim",
     insertOf(calls)!.args[6], JSON.stringify([ORIG, "short"]));
}

{
  const { calls, deps } = fake();
  await remember(CFG, {
    summary: "s", type: "decision",
    alternatives: [{ option: "Redis", rejected: "too big" }],
  }, deps);
  eq("alternatives are encoded in refs as a typed object",
     insertOf(calls)!.args[6], '[{"_type":"alternatives","items":[{"option":"Redis","rejected":"too big"}]}]');
}

const rejects = async (n: string, fn: () => Promise<unknown>, needle: string) => {
  try { await fn(); eq(n, "resolved", `rejected: ${needle}`); }
  catch (e) { eq(n, String((e as Error).message).includes(needle), true); }
};
await rejects("unknown type rejects", () => remember(CFG, { summary: "s", type: "vibe" }, fake().deps), "Invalid type 'vibe'");
await rejects("empty summary rejects", () => remember(CFG, { summary: " ", type: "world" }, fake().deps), "summary");
await rejects("alternatives on a non-decision reject",
  () => remember(CFG, { summary: "s", type: "world", alternatives: [{ option: "x" }] }, fake().deps),
  "only valid for type='decision'");
await rejects("drift_class without supersedes rejects",
  () => remember(CFG, { summary: "s", type: "procedure", drift_class: "additive" }, fake().deps),
  "only applies with `supersedes`");

// --------------------------------------------------------------- supersede

{
  const { calls, deps } = fake((sql) => {
    if (sql.includes("SELECT priority FROM memories")) return [{ priority: 1 }];
    return [];
  });
  const r = await remember(CFG, {
    summary: "v2", type: "procedure", supersedes: ORIG, tags: ["x"], drift_class: "narrowing",
  }, deps);
  eq("supersede routes through remember() and returns the new id", r.id, UUID);
  eq("supersede note names the original", r.note, `supersedes ${ORIG}`);
  const upd = calls.find((c) => c.sql.startsWith("UPDATE memories SET deleted_at = ?, is_superseded = 1"))!;
  eq("original is retired, flagged and pointed at the replacement",
     upd.args, ["2026-09-19T14:00:00Z", UUID, ORIG]);
  const ins = insertOf(calls)!;
  eq("replacement cites the original in refs", ins.args[6], JSON.stringify([ORIG]));
  eq("priority is inherited from the original", ins.args[7], 1);
  eq("drift_class becomes a tag", ins.args[5], '["x","drift-class-narrowing"]');
  eq("supersede default conf is 0.8", ins.args[4], 0.8);
  eq("update precedes insert", calls.indexOf(upd) < calls.indexOf(ins), true);
}

{
  const { calls, deps } = fake((sql) => sql.includes("SELECT priority") ? [{ priority: 0 }] : []);
  await supersede(CFG, { summary: "v2", type: "procedure", supersedes: ORIG }, deps);
  eq("inherited 0 on a procedure is floored to 1", insertOf(calls)!.args[7], 1);
}
{
  const { calls, deps } = fake((sql) => sql.includes("SELECT priority") ? [{ priority: 2 }] : []);
  await supersede(CFG, { summary: "v2", type: "world", supersedes: ORIG, priority: 0 }, deps);
  eq("an explicit priority overrides inheritance", insertOf(calls)!.args[7], 0);
}
{
  // Prefix resolution runs before any write; ambiguity is an error, not a guess.
  const { calls, deps } = fake((sql) => sql.includes("SELECT id FROM memories WHERE id LIKE")
    ? [{ id: ORIG }, { id: "a7edfdb0-9999-2222-3333-444455556666" }] : []);
  await rejects("ambiguous supersedes prefix rejects",
    () => supersede(CFG, { summary: "v2", type: "world", supersedes: "a7edfdb0" }, deps), "matches 2 memories");
  eq("nothing is written on an ambiguous prefix", insertOf(calls), undefined);
}
await rejects("bad drift_class rejects before any I/O",
  () => supersede(CFG, { summary: "s", type: "procedure", supersedes: ORIG, drift_class: "sideways" }, fake().deps),
  "Invalid drift_class 'sideways'");

// ------------------------------------------------------------------ forget

{
  const { calls, deps } = fake();
  const r = await forget(CFG, { id: ORIG }, deps);
  eq("forget soft-deletes by full id without a resolve round trip",
     calls.map((c) => c.sql.split(" ")[0]), ["UPDATE"]);
  eq("forget stamps deleted_at with now", calls[0].args, ["2026-09-19T14:00:00Z", ORIG]);
  eq("forget reports what it did", formatWrite("forgot", r), `forgot ${ORIG} — forgotten (soft-deleted)`);
}
{
  const { calls, deps } = fake((sql) => sql.includes("WHERE id LIKE ? AND deleted_at IS NULL") ? [{ id: ORIG }] : []);
  await forget(CFG, { id: "a7edfdb0" }, deps);
  eq("forget resolves a unique prefix", calls.at(-1)!.args[1], ORIG);
}
await rejects("forget on an unknown prefix rejects", () => forget(CFG, { id: "zzzz" }, fake().deps), "No active memory");

// -------------------------------------------------------------- config set

{
  const { calls, deps } = fake();
  const out = await configSet(CFG, { key: "k", value: "v", category: "ops" }, deps);
  eq("config set reports the key", out, "[config] k set (ops).");
  const up = calls.find((c) => c.sql.startsWith("INSERT OR REPLACE INTO config"))!;
  eq("new key: boot_load defaults to 0, read_only 0, source stamped",
     [up.args[6], up.args[5], up.args[7]], [0, 0, "mcp@9.9.9"]);
}
{
  const { calls, deps } = fake((sql) => sql.includes("SELECT read_only, boot_load") ? [{ read_only: "0", boot_load: "1" }] : []);
  await configSet(CFG, { key: "k", value: "v", category: "ops" }, deps);
  eq("existing key keeps its boot_load when the caller is silent",
     calls.find((c) => c.sql.startsWith("INSERT OR REPLACE"))!.args[6], 1);
  await configSet(CFG, { key: "k", value: "v", category: "ops", boot_load: false }, deps);
  eq("an explicit boot_load wins",
     calls.filter((c) => c.sql.startsWith("INSERT OR REPLACE")).at(-1)!.args[6], 0);
}
{
  const { calls, deps } = fake((sql) => sql.includes("SELECT read_only, boot_load") ? [{ read_only: 1, boot_load: 0 }] : []);
  await rejects("read_only rows refuse the write",
    () => configSet(CFG, { key: "k", value: "v", category: "ops" }, deps), "marked read-only");
  eq("read_only refusal writes nothing", calls.some((c) => c.sql.startsWith("INSERT")), false);
}
await rejects("bad category rejects", () => configSet(CFG, { key: "k", value: "v", category: "misc" }, fake().deps), "Invalid category 'misc'");
await rejects("char_limit is enforced",
  () => configSet(CFG, { key: "k", value: "toolong", category: "ops", char_limit: 3 }, fake().deps), "exceeds char_limit");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
