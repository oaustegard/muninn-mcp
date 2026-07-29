/**
 * Parity tests for the multi-stage recall expansion.
 *
 * Companion to `src/expansion.ts`, which ports the expansion block of
 * `memory.py::recall`. The assertions here are about ORDER and PROVENANCE, not
 * about formatting: which searches fire, in which order, with which options, and
 * how the union is reranked. Those are exactly the things that change WHICH
 * MEMORIES COME BACK without anything throwing — docs/mcp-migration.md §5's
 * "every one is silent" failure mode.
 *
 * Everything runs against an injected fake client. There is no network here and
 * no golden file: unlike FTS escaping, expansion has no pure function to capture
 * vectors from — its behaviour IS the call sequence. Live-corpus comparison
 * against blue is the harness's job (`harness/queries.json::sparse-*`).
 */
import {
  BOOST_COOCCUR,
  BOOST_HOP2,
  BOOST_PRIMARY,
  BOOST_STAGE1_TAG,
  DEFAULT_EXPANSION_THRESHOLD,
  bm25Boost,
  codePointCompare,
  queryWords,
  recallWithExpansion,
} from "./expansion.ts";
import { escapeFts5 } from "./turso.ts";
import type { Client } from "@libsql/client/web";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

// ---------------------------------------------------------------- fixtures

/** A memory row shaped like the FTS SELECT returns it. */
const mrow = (id: string, tags: string[] = [], bm25 = -1) => ({
  id,
  type: "note",
  t: "2026-07-01T00:00:00Z",
  summary: `summary of ${id}`,
  confidence: 0.5,
  tags: JSON.stringify(tags),
  refs: "[]",
  priority: 0,
  created_at: "2026-07-01T00:00:00Z",
  bm25_score: bm25,
  composite_score: bm25,
});

/**
 * Recover the raw search term from an escaped MATCH expression.
 *
 * `escapeFts5` is the only transform between the two, and it is invertible for
 * the plain terms used here (`turso` -> `"turso"*`, `a b` -> `"a"* OR "b"*`).
 * Keying the fake on RAW terms keeps the tests readable; keying on the escaped
 * form would bury the interesting assertion under quoting noise.
 */
function rawTerm(match: string): string {
  return match
    .split(" OR ")
    .map((t) => t.replace(/^"/, "").replace(/"\*$/, ""))
    .join(" ");
}

interface FakeSpec {
  /** raw search term -> rows that term returns. Unlisted terms return []. */
  fts?: Record<string, ReturnType<typeof mrow>[]>;
  /** raw search terms whose search THROWS, to exercise the stage break. */
  ftsThrows?: string[];
  /** probe tag -> [tag1, tag2, count, pmi] rows from tag_cooccurrence. */
  cooc?: Record<string, [string, string, number, number][]>;
  /** `SELECT 1 FROM tag_cooccurrence LIMIT 1` throws — the table is absent. */
  coocMissing?: boolean;
  /** the per-tag co-occurrence query throws AFTER a successful probe. */
  coocQueryThrows?: boolean;
}

interface FtsCall {
  term: string;
  /** trailing bound param — the per-stage row cap. */
  n: unknown;
  sql: string;
  params: unknown[];
}

/** Records every call so the tests can assert on the SEQUENCE, not just output. */
interface Journal {
  fts: FtsCall[];
  coocProbes: number;
  coocTags: string[];
}

function fakeClient(spec: FakeSpec = {}): { client: Client; journal: Journal } {
  const journal: Journal = { fts: [], coocProbes: 0, coocTags: [] };
  const throwing = new Set(spec.ftsThrows ?? []);

  const client = {
    execute: async (stmt: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? [] : (stmt.args ?? []);

      if (sql.includes("tag_cooccurrence")) {
        if (sql.includes("LIMIT 1")) {
          journal.coocProbes++;
          if (spec.coocMissing) throw new Error("no such table: tag_cooccurrence");
          return { rows: [] };
        }
        const tag = String(args[0]);
        journal.coocTags.push(tag);
        if (spec.coocQueryThrows) throw new Error("tag_cooccurrence query blew up");
        const rows = (spec.cooc?.[tag] ?? []).map(([tag1, tag2, count, pmi]) => ({
          tag1, tag2, count, pmi,
        }));
        return { rows };
      }

      const term = rawTerm(String(args[0]));
      journal.fts.push({ term, n: args[args.length - 1], sql, params: args });
      // Blue catches RuntimeError around `_fts5_search` and BREAKS the stage.
      if (throwing.has(term)) throw new Error("no such table: memory_fts");
      return { rows: spec.fts?.[term] ?? [] };
    },
  } as unknown as Client;

  return { client, journal };
}

/** Terms searched, in call order — the thing sorted() exists to make stable. */
const terms = (j: Journal) => j.fts.map((c) => c.term);
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

// ---------------------------------------------------------------- constants

console.log("--- boost weights");
eq("BOOST_PRIMARY is 3.0", BOOST_PRIMARY, 3.0);
eq("BOOST_STAGE1_TAG is 2.0", BOOST_STAGE1_TAG, 2.0);
eq("BOOST_COOCCUR is 1.5", BOOST_COOCCUR, 1.5);
eq("BOOST_HOP2 is 1.0", BOOST_HOP2, 1.0);
eq("the default threshold is 3", DEFAULT_EXPANSION_THRESHOLD, 3);

// ---------------------------------------------------------------- bm25 -> boost

console.log("\n--- bm25 to boost");
// bm25() is negative — more negative is a BETTER match — so without abs() the
// final descending sort would rank the worst matches first.
eq("a negative bm25 becomes a positive boost", bm25Boost(mrow("x", [], -2.5)), 2.5);
// Blue's `r.get('bm25_score', 0) or 0` is a falsy test, so all three collapse.
eq("a missing bm25 is 0", bm25Boost({ ...mrow("x"), bm25_score: undefined } as never), 0);
eq("a null bm25 is 0", bm25Boost({ ...mrow("x"), bm25_score: null }), 0);
eq("a zero bm25 is 0", bm25Boost(mrow("x", [], 0)), 0);

// ---------------------------------------------------------------- tag ordering

console.log("\n--- code-point tag ordering");
// Python's `sorted()` on str compares CODE POINTS. Verified against the live
// interpreter: sorted(['\U0001F600', '�', 'a']) == ['a', '�', '\U0001F600'].
eq("ascii sorts as expected", ["b", "a", "C"].sort(codePointCompare), ["C", "a", "b"]);
eq("a prefix sorts before its extension", ["ab", "a"].sort(codePointCompare), ["a", "ab"]);
eq("astral characters sort ABOVE the BMP, as in Python",
   ["\u{1F600}", "�", "a"].sort(codePointCompare), ["a", "�", "\u{1F600}"]);
// The bug this comparator exists to prevent: JS's default sort compares UTF-16
// CODE UNITS, so the emoji's lead surrogate (\uD83D) sorts below � and the
// two orders disagree. Asserting the disagreement keeps the comparator from
// being "simplified" back to a bare .sort().
eq("the default sort really does disagree above the BMP",
   ["\u{1F600}", "�", "a"].sort(), ["a", "\u{1F600}", "�"]);
eq("equal strings compare 0 (so sort stays stable on ties)",
   codePointCompare("same", "same"), 0);

// ---------------------------------------------------------------- query words

console.log("\n--- query word extraction");
eq("words are lowercased and split on whitespace", queryWords("Hrana  PIPELINE"), ["hrana", "pipeline"]);
eq("leading and trailing whitespace produce no empty words",
   queryWords("  a \t b \n "), ["a", "b"]);
eq("an all-whitespace query yields no words", queryWords("   "), []);

// ---------------------------------------------------------------- threshold

console.log("\n--- when expansion fires");

{
  // AT the threshold: 3 primary rows, default threshold 3. `<` not `<=`.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["a"]), mrow("p2", ["b"]), mrow("p3", ["c"])] },
  });
  const out = await recallWithExpansion(client, "turso");
  eq("3 results at threshold 3 does not expand", terms(journal), ["turso"]);
  eq("no co-occurrence probe is made either", journal.coocProbes, 0);
  eq("the primary rows are returned untouched", ids(out), ["p1", "p2", "p3"]);
}

{
  // ABOVE the threshold.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["a"]), mrow("p2"), mrow("p3"), mrow("p4")] },
  });
  await recallWithExpansion(client, "turso");
  eq("4 results at threshold 3 does not expand", terms(journal), ["turso"]);
}

{
  // BELOW the threshold — the whole point.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["beta", "alpha"]), mrow("p2", ["alpha"])], alpha: [mrow("e1")], beta: [] },
  });
  const out = await recallWithExpansion(client, "turso");
  eq("2 results at threshold 3 expands on the stage-1 tags",
     terms(journal), ["turso", "alpha", "beta"]);
  eq("the expansion row joins the primaries", ids(out), ["p1", "p2", "e1"]);
}

{
  // The control entry in queries.json (`sparse-expansion-disabled`) is exactly
  // this shape: threshold 0 must make green byte-comparable with blue.
  const { client, journal } = fakeClient({ fts: { turso: [mrow("p1", ["alpha"])] } });
  const out = await recallWithExpansion(client, "turso", { expansionThreshold: 0 });
  eq("threshold 0 disables expansion entirely", terms(journal), ["turso"]);
  eq("threshold 0 makes no co-occurrence call", journal.coocProbes, 0);
  eq("threshold 0 returns the bare primary rows", ids(out), ["p1"]);
}

{
  // `expansion_threshold > 0` is blue's guard, so a negative is off too.
  const { client, journal } = fakeClient({ fts: { turso: [mrow("p1", ["alpha"])] } });
  await recallWithExpansion(client, "turso", { expansionThreshold: -1 });
  eq("a negative threshold also disables expansion", terms(journal), ["turso"]);
}

{
  // `sparse-expansion-raised`: the threshold compares against the PRIMARY COUNT,
  // not against n, so a raised threshold expands a query that normally would not.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["alpha"]), mrow("p2"), mrow("p3"), mrow("p4"), mrow("p5")] },
  });
  await recallWithExpansion(client, "turso", { expansionThreshold: 10 });
  eq("a raised threshold expands a 5-row result", terms(journal), ["turso", "alpha"]);
}

// ---------------------------------------------------------------- stage 2b

console.log("\n--- co-occurrence stage");

{
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["alpha"])], alpha: [], zeta: [mrow("e1")] },
    cooc: { alpha: [["alpha", "zeta", 4, 0.9]] },
  });
  const out = await recallWithExpansion(client, "turso");
  eq("stage-1 tags drive the co-occurrence probe", journal.coocTags, ["alpha"]);
  eq("co-occurrence tags are searched after the stage-1 tags",
     terms(journal), ["turso", "alpha", "zeta"]);
  eq("the co-occurrence row is merged in", ids(out), ["p1", "e1"]);
}

{
  // The `if not stage1_tags` branch. `sparse-nonsense-token` is the live probe:
  // zero primary hits still expands the QUERY WORDS, at min_pmi 0.0, and can
  // return rows from nowhere.
  const { client, journal } = fakeClient({
    fts: { "zzqqxx-not-a-word": [], found: [mrow("e1")] },
    cooc: { "zzqqxx-not-a-word": [["zzqqxx-not-a-word", "found", 2, 0.1]] },
  });
  const out = await recallWithExpansion(client, "zzqqxx-not-a-word");
  eq("with no stage-1 tags the QUERY WORDS are expanded",
     journal.coocTags, ["zzqqxx-not-a-word"]);
  eq("a zero-hit query can still return rows", ids(out), ["e1"]);
}

{
  // Blue lowercases and whitespace-splits before probing, so a multi-word query
  // probes each word separately.
  const { client, journal } = fakeClient({ fts: { "hrana pipeline": [] } });
  await recallWithExpansion(client, "Hrana PIPELINE");
  eq("query words are lowercased and probed one by one",
     journal.coocTags, ["hrana", "pipeline"]);
}

{
  // min_pmi differs between the two branches: 0.5 from stage-1 tags, 0.0 from
  // query words. It is bound third in buildCooccurrenceQuery's params.
  const seen: unknown[][] = [];
  const client = {
    execute: async (stmt: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? [] : (stmt.args ?? []);
      if (sql.includes("tag_cooccurrence") && !sql.includes("LIMIT 1")) seen.push(args);
      return { rows: [] };
    },
  } as unknown as Client;
  await recallWithExpansion(client, "solo");
  eq("the query-word branch probes at min_pmi 0.0 and n 10", seen[0], ["solo", "solo", 0.0, 10]);
}

{
  const seen: unknown[][] = [];
  const client = {
    execute: async (stmt: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? [] : (stmt.args ?? []);
      if (sql.includes("tag_cooccurrence") && !sql.includes("LIMIT 1")) seen.push(args);
      if (sql.includes("memory_fts")) return { rows: [mrow("p1", ["alpha"])] };
      return { rows: [] };
    },
  } as unknown as Client;
  await recallWithExpansion(client, "solo");
  eq("the stage-1-tag branch probes at min_pmi 0.5 and n 10", seen[0], ["alpha", "alpha", 0.5, 10]);
}

{
  // The table is built by a separate maintenance pass and may not exist. Blue
  // swallows that; every sparse recall on a fresh DB would otherwise be an error.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["alpha"])], alpha: [mrow("e1")] },
    coocMissing: true,
  });
  const out = await recallWithExpansion(client, "turso");
  eq("a missing tag_cooccurrence table degrades to no co-occurrence stage",
     terms(journal), ["turso", "alpha"]);
  eq("...and the rest of the expansion still runs", ids(out), ["p1", "e1"]);
}

{
  // Blue wraps the WHOLE `_cooccurrence_expand` call in `except Exception: pass`,
  // which also covers a failure after the table probe succeeded.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["alpha"])], alpha: [mrow("e1")] },
    coocQueryThrows: true,
  });
  const out = await recallWithExpansion(client, "turso");
  eq("a co-occurrence query failure is swallowed, not propagated",
     terms(journal), ["turso", "alpha"]);
  eq("...and the primary rows survive it", ids(out), ["p1", "e1"]);
}

// ---------------------------------------------------------------- ordering

console.log("\n--- tag visit order");

{
  // The muninn-utilities#100 fix. These loops break early, so the ORDER decides
  // the answer; blue returned three different ids for the same query across six
  // PYTHONHASHSEED values before the sets were sorted.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["\u{1F600}", "zulu", "�", "alpha"])] },
  });
  await recallWithExpansion(client, "turso", { n: 10 });
  eq("stage-1 tags are visited in Python code-point order",
     terms(journal), ["turso", "alpha", "zulu", "�", "\u{1F600}"]);
}

{
  // Same for the co-occurrence set, which is built from a Map and would
  // otherwise be visited in PMI-descending insertion order.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["alpha"])] },
    cooc: { alpha: [["alpha", "zeta", 1, 0.9], ["alpha", "beta", 1, 0.8]] },
  });
  await recallWithExpansion(client, "turso", { n: 10 });
  eq("co-occurrence tags are visited sorted, not in PMI order",
     terms(journal), ["turso", "alpha", "beta", "zeta"]);
}

// ---------------------------------------------------------------- budget

console.log("\n--- the n*2 budget");

{
  // n=1 is the shape that exposed the non-determinism: budget 2, `results`
  // already holds 1, so the FIRST tag visited decides the entire answer.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["beta", "alpha"])], alpha: [mrow("e1")], beta: [mrow("e2")] },
  });
  const out = await recallWithExpansion(client, "turso", { n: 1 });
  eq("stage 3 stops once results+expansion reach n*2", terms(journal), ["turso", "alpha"]);
  eq("the budget is checked BEFORE the search, so beta is never issued",
     terms(journal).includes("beta"), false);
  // Both rows score bm25 -1, so the primary's 3.0 beats the stage-1 tag's 2.0
  // and the single surviving slot goes to the primary. `e1` was still fetched —
  // at n=1 blue does a whole extra query to return the row it already had.
  eq("the merged list is sliced to n", ids(out), ["p1"]);
}

{
  // Stage 3b's budget. No stage-1 tags, so the query-word branch supplies two
  // co-occurrence tags and only the first is searched.
  const { client, journal } = fakeClient({
    fts: { solo: [mrow("p1")], aa: [mrow("e1")], bb: [mrow("e2")] },
    cooc: { solo: [["solo", "bb", 1, 0.9], ["solo", "aa", 1, 0.8]] },
  });
  await recallWithExpansion(client, "solo", { n: 1 });
  eq("stage 3b stops on the same budget", terms(journal), ["solo", "aa"]);
}

{
  // Stage 4's budget, and its tag set: hop-2 tags come from the EXPANSION rows.
  const { client, journal } = fakeClient({
    fts: {
      turso: [mrow("p1", ["alpha"])],
      alpha: [mrow("e1", ["h2", "h1"])],
      h1: [mrow("e2"), mrow("e3")],
      h2: [mrow("e4")],
    },
  });
  const out = await recallWithExpansion(client, "turso", { n: 2 });
  eq("stage 4 searches the second-hop tags in sorted order and then stops",
     terms(journal), ["turso", "alpha", "h1"]);
  // 1 primary + 3 expansion = 4 >= n*2, so h2 is never reached. Note the
  // overshoot: the budget is only checked BETWEEN tags, so h1's two rows both
  // land even though the first already met the budget.
  eq("a single tag may overshoot the budget", ids(out).length, 2);
}

{
  // hop2_tags -= stage1_tags -= cooccur_tags.
  const { client, journal } = fakeClient({
    fts: {
      turso: [mrow("p1", ["alpha"])],
      alpha: [mrow("e1", ["alpha", "zeta", "fresh"])],
      zeta: [],
      fresh: [],
    },
    cooc: { alpha: [["alpha", "zeta", 1, 0.9]] },
  });
  await recallWithExpansion(client, "turso", { n: 10 });
  eq("stage 4 excludes tags already visited in stages 3 and 3b",
     terms(journal), ["turso", "alpha", "zeta", "fresh"]);
}

// ---------------------------------------------------------------- per-stage n

console.log("\n--- per-stage row caps");

{
  const { client, journal } = fakeClient({
    fts: {
      turso: [mrow("p1", ["alpha"])],
      alpha: [mrow("e1", ["hop"])],
      zeta: [],
      hop: [],
    },
    cooc: { alpha: [["alpha", "zeta", 1, 0.9]] },
  });
  await recallWithExpansion(client, "turso", { n: 10 });
  eq("the stages run in order", terms(journal), ["turso", "alpha", "zeta", "hop"]);
  eq("primary uses n, stage 3 uses 5, stage 3b uses 5, stage 4 uses 3",
     journal.fts.map((c) => c.n), [10, 5, 5, 3]);
}

// ---------------------------------------------------------------- option pass-through

console.log("\n--- option forwarding");

{
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["alpha"])], alpha: [] },
  });
  await recallWithExpansion(client, "turso", {
    n: 10,
    type: "decision",
    tags: ["keep"],
    tagMode: "all",
    conf: 0.7,
    since: "2026-01-01",
    until: "2026-12-31",
    sessionId: "sess-1",
    episodic: true,
  });
  const [primary, stage3] = journal.fts;

  eq("the primary search is session-scoped", primary.sql.includes("m.session_id = ?"), true);
  eq("the primary search is episodic", primary.sql.includes("access_count"), true);

  // BLUE BUG, REPLICATED DELIBERATELY. Blue forwards type/tags/tag_mode/conf/
  // since/until to the expansion searches but NOT session_id, so a session-
  // scoped sparse recall can return OTHER SESSIONS' rows. Green must reproduce
  // it: diverging "correctly" would fail the parity gate and hide the bug behind
  // a green pass. Flagged upstream for its own decision. If this test ever goes
  // red because someone "fixed" it, fix blue first.
  eq("BLUE BUG: session_id is NOT forwarded to the expansion searches",
     stage3.sql.includes("m.session_id = ?"), false);
  // Blue does not forward `episodic` either, so expansion rows are ranked
  // without the access-count factor even when the primary search used it.
  eq("episodic is NOT forwarded to the expansion searches either",
     stage3.sql.includes("access_count"), false);

  eq("type IS forwarded", stage3.sql.includes("m.type = ?"), true);
  eq("conf IS forwarded", stage3.sql.includes("m.confidence >= ?"), true);
  eq("the time window IS forwarded",
     stage3.sql.includes("m.t >= ?") && stage3.sql.includes("m.t <= ?"), true);
  // tagMode "all" emits one unparenthesised LIKE per tag; "any" wraps in one
  // paren group. Both forms would show a LIKE, so assert the bound pattern.
  eq("tags and tag_mode ARE forwarded",
     stage3.params.includes('%"keep"%'), true);
}

// ---------------------------------------------------------------- reranking

console.log("\n--- boost reranking");

{
  // A stage-3 row can outrank a primary row: 1.5 * BOOST_STAGE1_TAG (3.0) beats
  // 0.9 * BOOST_PRIMARY (2.7). This is the behaviour the harness reports as a
  // gap — green used to return a strict SUBSET in composite order.
  const { client } = fakeClient({
    fts: { turso: [mrow("p1", ["alpha"], -0.9)], alpha: [mrow("e1", [], -1.5)] },
  });
  const out = await recallWithExpansion(client, "turso", { n: 10 });
  eq("a strongly-matching expansion row can outrank a primary row",
     ids(out), ["e1", "p1"]);
}

{
  // Boosts are per-provenance: same bm25, different stage, different rank.
  const { client } = fakeClient({
    fts: {
      turso: [mrow("p1", ["alpha"], -1)],
      alpha: [mrow("e1", ["hop"], -1)],
      zeta: [mrow("e2", [], -1)],
      hop: [mrow("e3", [], -1)],
    },
    cooc: { alpha: [["alpha", "zeta", 1, 0.9]] },
  });
  const out = await recallWithExpansion(client, "turso", { n: 10 });
  // 1*3.0, 1*2.0, 1*1.5, 1*1.0 — primary, stage1-tag, co-occur, hop2.
  eq("provenance decides the order when bm25 is equal",
     ids(out), ["p1", "e1", "e2", "e3"]);
}

{
  // Python's list.sort is stable and `reverse=True` does NOT reverse ties;
  // Array.prototype.sort has been stable since ES2019. Equal boosts therefore
  // keep input order in both worlds: primaries first, then expansion rows, each
  // group still in composite order.
  const { client } = fakeClient({
    fts: {
      turso: [mrow("p1", ["alpha"], -1), mrow("p2", [], -1)],
      alpha: [mrow("e1", [], -1.5), mrow("e2", [], -1.5)],
    },
  });
  const out = await recallWithExpansion(client, "turso", { n: 10 });
  // 1*3.0 == 1.5*2.0 — all four boosts are exactly 3.0.
  eq("equal boosts preserve input order (stable sort, both languages)",
     ids(out), ["p1", "p2", "e1", "e2"]);
}

{
  // A row reachable from two stages. `seen_ids` is updated in the same breath as
  // the boost, so blue's `boost_scores.get(id, 0) + ...` can never actually
  // accumulate — the row keeps the FIRST stage's boost and is not counted twice.
  // Discriminating fixture: e1 is found by stage 3 (bm25 -1 -> 2.0) and again by
  // stage 3b, where it is skipped. e2 is found only by stage 3b (bm25 -1.8 ->
  // 2.7). If the boosts accumulated, e1 would be 2.0 + 1.5 = 3.5 and would come
  // first; because they do not, e2 wins.
  const { client } = fakeClient({
    fts: {
      turso: [mrow("p1", ["alpha"], -0.5)],
      alpha: [mrow("e1", [], -1)],
      zeta: [mrow("e1", [], -1), mrow("e2", [], -1.8)],
    },
    cooc: { alpha: [["alpha", "zeta", 1, 0.9]] },
  });
  const out = await recallWithExpansion(client, "turso", { n: 10 });
  eq("a row found by two stages keeps the first stage's boost, not the sum",
     ids(out), ["e2", "e1", "p1"]);
  eq("...and appears exactly once", ids(out).filter((i) => i === "e1").length, 1);
}

{
  // The final slice. n=2 with four candidates.
  const { client } = fakeClient({
    fts: {
      turso: [mrow("p1", ["alpha"], -1)],
      alpha: [mrow("e1", [], -1), mrow("e2", [], -0.5), mrow("e3", [], -0.1)],
    },
  });
  const out = await recallWithExpansion(client, "turso", { n: 2 });
  eq("the merged union is sliced to n", ids(out), ["p1", "e1"]);
}

// ---------------------------------------------------------------- stage break

console.log("\n--- search failure inside a stage");

{
  // Blue's `except RuntimeError: break` abandons the whole stage, it does not
  // skip the tag — so a failure on `alpha` means `beta` is never searched.
  const { client, journal } = fakeClient({
    fts: { turso: [mrow("p1", ["beta", "alpha"])], beta: [mrow("e1")] },
    ftsThrows: ["alpha"],
  });
  const out = await recallWithExpansion(client, "turso", { n: 10 });
  eq("a failing tag search BREAKS the stage rather than skipping the tag",
     terms(journal), ["turso", "alpha"]);
  eq("the primary rows still come back", ids(out), ["p1"]);
}

{
  // A primary-search failure is NOT swallowed — blue only guards the expansion
  // searches, and its own primary call has a LIKE fallback green does not have.
  const { client } = fakeClient({ ftsThrows: ["turso"] });
  let threw = false;
  try {
    await recallWithExpansion(client, "turso");
  } catch {
    threw = true;
  }
  eq("a primary search failure propagates", threw, true);
}

// ---------------------------------------------------------------- edge shapes

console.log("\n--- edge shapes");

{
  // Rows whose `tags` column is unparseable contribute no stage-1 tags, which
  // sends the whole recall down the query-word branch — blue's guard is on
  // `stage1_tags` being empty, not on `results` being empty.
  const { client, journal } = fakeClient({
    fts: { turso: [{ ...mrow("p1"), tags: "{not json" }] },
  });
  await recallWithExpansion(client, "turso");
  eq("a row with unparseable tags takes the query-word branch",
     journal.coocTags, ["turso"]);
}

{
  // An empty query has no words, so `_cooccurrence_expand([])` short-circuits
  // before the table probe — blue's `if not tags: return []`.
  const { client, journal } = fakeClient({});
  const out = await recallWithExpansion(client, "   ");
  eq("a whitespace-only query makes no co-occurrence call at all", journal.coocProbes, 0);
  eq("...and returns nothing", ids(out), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
