/**
 * GREEN capture — run the frozen golden query set through the TypeScript.
 *
 *   TURSO_URL=... TURSO_TOKEN=... node --experimental-strip-types harness/green.mjs
 *
 * Writes harness/snapshots/green.json in the same record shape as blue.py.
 * Exit 0 on a clean capture, 2 if credentials are missing.
 *
 * ------------------------------------------------------------------ NO WORKER
 *
 * This imports `src/turso.ts` and `src/tools.ts` DIRECTLY and builds its own
 * libsql client. It does not talk to a deployed Worker, and that is deliberate:
 * the gate must be runnable before anything is deployed, and a Worker in the
 * path adds a network hop, an auth token and a JSON-RPC envelope that can all
 * fail for reasons unrelated to retrieval. What we want to compare is the QUERY
 * LAYER. `src/index.ts` is a transport over exactly this code, so testing here
 * tests the thing that can be wrong.
 *
 * The consequence — and it is a real gap, not a technicality — is that this
 * proves nothing about the MCP envelope, OAuth, or the Worker runtime. It
 * proves the SQL and the ranking. §5's byte-equality claim about the boot
 * payload is likewise out of scope here; green serves no boot payload yet.
 *
 * ------------------------------------------------------------- IMPORT SURFACE
 *
 * We import `db`/`search`/`buildSearch` from turso.ts, `recallWithExpansion`
 * from expansion.ts, and `recall` from tools.ts. Binding this harness to a wide
 * surface would make the gate break every time the port progresses, which is
 * precisely backwards — the gate should break when RESULTS change.
 *
 * The primary record comes from `recallWithExpansion`, because BLUE's records
 * come from `recall()` and blue's recall runs the multi-stage expansion below
 * expansion_threshold. Comparing blue's recall() against green's bare `search()`
 * compares two different questions, and reports every sparse query as a
 * permanent gap that no amount of porting could ever close. `search()` remains
 * expansion-free on purpose — the SQL-level parity claim depends on it — so it
 * is the wrong layer to diff against blue, not the wrong function.
 *
 * ------------------------------------------------------------------ TRANSLATION
 *
 * queries.json speaks BLUE's kwargs, because blue is the specification. This
 * file maps them onto green's SearchOpts. Three things can happen to an arg:
 *
 *   MAPPED       there is a direct equivalent (tag_mode -> tagMode).
 *   TRANSLATED   blue resolves it to something greener before building SQL, and
 *                we do the same, so the probe tests the SQL rather than the
 *                sugar (tags_all -> tags + tagMode:"all"). Recorded in `notes`.
 *   UNSUPPORTED  green has no equivalent AT ALL (strict, fetch_all,
 *                exploration). We do NOT silently drop these — dropping them
 *                would run a different, easier query and report a false match.
 *                We record `ids: null` and an error naming the missing feature.
 *
 * The distinction is the whole point. A harness that quietly degrades the query
 * until both sides agree is worse than no harness.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, search, buildSearch } from "../src/turso.ts";
import { recallWithExpansion } from "../src/expansion.ts";
import { recall as toolRecall } from "../src/tools.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERIES = join(HERE, "queries.json");
const OUT = join(HERE, "snapshots", "green.json");

/** Blue reads TURSO_URL/TURSO_TOKEN; green's Config uses the same two names, so
 *  one export drives both captures. TURSO_DB_URL is accepted because some boot
 *  paths in muninn-utilities set that spelling instead. */
const TURSO_URL = process.env.TURSO_URL ?? process.env.TURSO_DB_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_TOKEN ?? "";

function die(code, msg) {
  console.error(`\n${msg}\n`);
  process.exit(code);
}

function oneLine(s, limit = 400) {
  return String(s).replace(/\s+/g, " ").slice(0, limit);
}

/**
 * Pull `composite_score` off a green row, or null if it is not a real number.
 *
 * Recorded for one reason only: `diff.mjs` needs it to tell a NEAR-TIE
 * REORDERING apart from a ranking regression. The composite contains
 * `julianday('now')`, and rows of different ages drift at different rates, so
 * two rows whose scores agree to five decimal places can swap places between
 * blue's capture and green's without either side being wrong. Ids alone cannot
 * distinguish that from green ranking incorrectly. See the epsilon derivation
 * in diff.mjs.
 *
 * The score is NOT compared across sides — it cannot be, it is a function of
 * wall-clock time. Only the WITHIN-SIDE gap between two rows is used.
 *
 * Total by construction: never throws, never invents a number. libsql returns
 * SQLite REAL as a JS number, but a null column, a bigint, or a driver change
 * would all land here, and a fabricated 0 would be actively dangerous — the
 * composite is negative (bm25() is), so 0 looks like a plausible score and
 * could license a bogus TIE. null makes diff.mjs refuse to tie-analyse instead.
 */
function scoreOf(row) {
  const v = row?.composite_score;
  if (v === null || v === undefined) return null;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Blue kwargs -> green SearchOpts.
 *
 * Returns { queryText, opts, unsupported[], notes[] }. Nothing here tries to
 * emulate blue; it only expresses what green CAN express and names what it
 * cannot.
 */
function translate(args) {
  const opts = {};
  const unsupported = [];
  const notes = [];

  // `query` is a first-class alias for `search` in blue, and `query` wins when
  // both are given (memory.py: `if query is not None: search = query`).
  let queryText = args.search;
  if (args.query !== undefined) queryText = args.query;

  // Blue's recall() defaults search to None and routes falsy search AWAY from
  // FTS entirely. Green has only the FTS path, so a missing search becomes an
  // empty string here — which escapes to the literal '""'. That is a real
  // divergence, flagged in queries.json as a known gap, not papered over.
  if (queryText === undefined || queryText === null) {
    queryText = "";
    notes.push("no search term; green has no non-FTS path and will MATCH '\"\"'");
  }

  if (args.n !== undefined) opts.n = args.n;
  if (args.type !== undefined) opts.type = args.type;
  if (args.conf !== undefined) opts.conf = args.conf;
  if (args.session_id !== undefined) opts.sessionId = args.session_id;
  if (args.since !== undefined) opts.since = args.since;
  if (args.until !== undefined) opts.until = args.until;
  if (args.episodic !== undefined) opts.episodic = args.episodic;
  if (args.tags !== undefined) opts.tags = args.tags;
  if (args.tag_mode !== undefined) opts.tagMode = args.tag_mode;

  // TRANSLATED: blue resolves tags_all/tags_any into tags+tag_mode before any
  // SQL is built, so mirroring that here keeps the probe pointed at the SQL.
  // The missing SUGAR is still a gap — it is an API-surface item for §8
  // progressive disclosure, not a retrieval bug, and belongs in a different
  // column of the report than a wrong row set.
  if (args.tags_all !== undefined && args.tags_any !== undefined) {
    unsupported.push("tags_all+tags_any (blue raises ValueError)");
  } else if (args.tags_all !== undefined) {
    opts.tags = args.tags_all;
    opts.tagMode = "all";
    notes.push("tags_all translated to tags+tagMode:all (green has no such sugar)");
  } else if (args.tags_any !== undefined) {
    opts.tags = args.tags_any;
    opts.tagMode = "any";
    notes.push("tags_any translated to tags+tagMode:any (green has no such sugar)");
  }

  // MAPPED. This branch used to only leave a note, on the reasoning that "green
  // performs no expansion, so the threshold has nothing to gate". That stopped
  // being true when src/expansion.ts landed, and the stale branch made green
  // expand while blue was told not to — which the `-control` probes in
  // queries.json caught immediately: blue 2 rows, green 10.
  //
  // Worth keeping as a scar. A translation layer that silently ignores an
  // argument does not fail loudly; it runs a DIFFERENT query and reports the
  // disagreement as a divergence in the code under test. The controls exist
  // precisely so that "the probe stopped exercising expansion" and "green
  // stopped honouring the threshold" cannot look alike.
  if (args.expansion_threshold !== undefined) {
    opts.expansionThreshold = args.expansion_threshold;
    notes.push(`expansion_threshold=${args.expansion_threshold} mapped to expansionThreshold`);
  }

  // UNSUPPORTED: whole retrieval modes green does not implement.
  if (args.strict) unsupported.push("strict (blue uses summary LIKE, ordered by t DESC)");
  if (args.fetch_all) unsupported.push("fetch_all (blue nulls the search and SELECTs everything)");
  if (args.exploration) unsupported.push("exploration (blue reranks client-side in Python)");

  return { queryText, opts, unsupported, notes };
}

/** True when the args fit tools.ts::recall's four-argument public surface. */
function fitsToolSurface(args, unsupported) {
  if (unsupported.length) return false;
  const allowed = new Set(["search", "query", "n", "tags", "type"]);
  return Object.keys(args).every((k) => allowed.has(k));
}

/**
 * --dry-run: show what green WOULD send, without connecting.
 *
 * Worth having for two reasons. It is the only way to review the translation
 * layer on a machine with no credentials — which is most machines, and was the
 * case when this harness was written. And it prints the BOUND PARAMETERS, which
 * is where the cheap failures live: a swapped since/until, a `type: ""` that
 * became a real predicate, a tag pattern that lost its LIKE escaping. Those are
 * visible here for free, before you spend a live capture on them.
 *
 * It does NOT prove parity. Blue's SQL is built by different code in a different
 * language; only a live capture compares answers.
 */
function dryRun(queries) {
  console.log("green --dry-run: translation and bound parameters, no connection\n");
  for (const q of queries) {
    const { queryText, opts, unsupported, notes } = translate(q.args);
    console.log(`${q.id}`);
    console.log(`  args    ${JSON.stringify(q.args)}`);
    if (unsupported.length) {
      console.log(`  SKIP    unsupported-in-green: ${unsupported.join("; ")}`);
    } else {
      const { params } = buildSearch(String(queryText), opts);
      console.log(`  query   ${JSON.stringify(queryText)}`);
      console.log(`  opts    ${JSON.stringify(opts)}`);
      console.log(`  params  ${JSON.stringify(params)}`);
    }
    for (const n of notes) console.log(`  note    ${n}`);
    console.log("");
  }
  const skipped = queries.filter((q) => translate(q.args).unsupported.length).length;
  console.log(`${queries.length} queries, ${skipped} unsupported in green`);
}


/**
 * Columns whose value moving means a row changed identity for retrieval.
 * `deleted_at` is the one that matters most and the least obvious: blue's
 * `supersede()` soft-deletes the original WITHOUT touching `updated_at`, so a
 * watermark built only on created_at/updated_at misses exactly the mutation
 * that reorders results.
 */
const MUTATION_COLUMNS = ["created_at", "updated_at", "deleted_at"];

/**
 * Ids of memories that changed at or after `sinceIso`.
 *
 * The gate diffs two captures of a LIVE corpus. A write landing between blue's
 * first query and green's last makes the two sides answer different questions,
 * and every affected entry reads as a green regression — which is how one
 * `supersede()` can present as thirteen independent failures. Recording the
 * mutated ids here lets diff.mjs prove that class apart without credentials.
 *
 * Timestamps are ISO-8601 UTC, so lexicographic comparison is chronological.
 * Never throws: a capture must not fail because this diagnostic could not run.
 */
async function corpusMutations(client, sinceIso) {
  const where = MUTATION_COLUMNS.map((c) => `${c} >= ?`).join(" OR ");
  try {
    const rs = await client.execute({
      sql: `SELECT id, created_at, updated_at, deleted_at FROM memories WHERE ${where}`,
      args: MUTATION_COLUMNS.map(() => sinceIso),
    });
    return rs.rows.map((r) => ({
      id: String(r.id),
      at: [r.created_at, r.updated_at, r.deleted_at].filter(Boolean).sort().pop(),
      kind: String(r.created_at) >= sinceIso ? "created"
          : String(r.deleted_at ?? "") >= sinceIso ? "deleted" : "updated",
    }));
  } catch (e) {
    console.log(`!! could not read corpus mutations: ${String(e).slice(0, 120)}`);
    return null;
  }
}


async function main() {
  const spec = JSON.parse(readFileSync(QUERIES, "utf-8"));
  const queries = spec.queries;

  if (process.argv.includes("--dry-run")) {
    dryRun(queries);
    process.exit(0);
  }

  if (!TURSO_URL || !TURSO_TOKEN) {
    die(
      2,
      "TURSO CREDENTIALS NOT SET — nothing was captured.\n\n" +
        `  TURSO_URL   ${TURSO_URL ? "set" : "MISSING"}\n` +
        `  TURSO_TOKEN ${TURSO_TOKEN ? "set" : "MISSING"}\n\n` +
        "Green needs them in the environment; unlike blue it does not read\n" +
        "/mnt/project/*.env. Export both and run blue.py and green.mjs back to\n" +
        "back — they read the same two variable names.",
    );
  }

  const config = { TURSO_URL, TURSO_TOKEN };
  const client = db(config);

  console.log(`green: src/turso.ts + src/tools.ts (no Worker in the path)`);
  console.log(`green: ${queries.length} queries\n`);

  const records = [];
  const runStarted = new Date().toISOString();
  const tStart = Date.now();

  for (const q of queries) {
    const { queryText, opts, unsupported, notes } = translate(q.args);
    const t0 = Date.now();
    let rec;

    if (unsupported.length) {
      // Refuse rather than run a weaker query. `ids: null` is the same shape
      // blue uses for a raised exception, so diff.mjs handles both uniformly.
      rec = {
        id: q.id,
        ids: null,
        scores: null,
        count: 0,
        error: `unsupported-in-green: ${unsupported.join("; ")}`,
      };
    } else {
      try {
        // recallWithExpansion, NOT search(). Blue's records come from recall(),
        // which runs the multi-stage expansion whenever a query returns fewer
        // than expansion_threshold rows — so comparing against bare search()
        // compares two different questions and reports every sparse query as a
        // permanent gap. search() stays expansion-free by design (the SQL-level
        // parity claim depends on it); the LIKE-FOR-LIKE path is this one.
        const rows = await recallWithExpansion(client, String(queryText), opts);
        // `scores` is parallel to `ids` — same length, same order — and kept as
        // a separate array on purpose, so nothing that already reads `.ids`
        // has to change. The sequence comparison is the gate; this is evidence
        // hung beside it, not a new assertion.
        rec = {
          id: q.id,
          ids: rows.map((r) => String(r.id)),
          scores: rows.map(scoreOf),
          count: rows.length,
          error: null,
        };
      } catch (e) {
        rec = { id: q.id, ids: null, scores: null, count: 0, error: `${e?.name ?? "Error"}: ${oneLine(e?.message ?? e)}` };
      }
    }
    rec.ms = Date.now() - t0;
    if (notes.length) rec.notes = notes;

    // Second, cheaper probe: run the SAME query through tools.ts::recall, the
    // actual MCP entry point, and keep the 8-char id prefixes it prints. This
    // is an INTERNAL green consistency check, never compared against blue —
    // its job is to surface the tool layer's own transforms, chiefly the
    // `Math.min(Math.max(Number(n) || 10, 1), 50)` clamp. n=200 silently
    // becomes 50 there and n=0 silently becomes 10 (because `0 || 10`), so the
    // tool answers a different question than the one you asked.
    if (rec.ids && fitsToolSurface(q.args, unsupported)) {
      try {
        const text = await toolRecall(config, {
          query: String(queryText),
          n: q.args.n,
          tags: q.args.tags,
          type: q.args.type,
        });
        rec.toolPrefixes =
          text === "No memories matched."
            ? []
            : [...text.matchAll(/^- \[([0-9a-f]{1,8})\]/gm)].map((m) => m[1]);
      } catch (e) {
        rec.toolPrefixes = null;
        rec.toolError = oneLine(e?.message ?? e, 200);
      }
    }

    records.push(rec);
    const mark = rec.error ? "ERR " : "    ";
    // Green has only the FTS path, which always SELECTs composite_score, so a
    // null here is not an expected shape the way it is on blue — it means the
    // driver or the SELECT changed, and the gate quietly lost its ability to
    // recognise near-ties. Say so loudly at capture time.
    const noScore = rec.ids?.length && rec.scores.some((s) => s === null)
      ? "  !! some rows have no composite_score — green's SELECT should always compute one"
      : "";
    console.log(
      `${mark}${q.id.padEnd(28)} n=${String(rec.count).padEnd(4)} ${String(rec.ms).padStart(5)}ms` +
        (rec.error ? `  ${rec.error.slice(0, 80)}` : "") + noScore,
    );
  }

  const snapshot = {
    side: "green",
    source: "src/turso.ts::search (direct client, no Worker)",
    captured_at: new Date().toISOString(),
    elapsed_s: Math.round((Date.now() - tStart) / 100) / 10,
    query_count: records.length,
    // Rows the corpus changed while this capture was running. diff.mjs uses
    // these to tell "the corpus moved under us" apart from "green is wrong".
    run_started_at: runStarted,
    corpus_mutations: await corpusMutations(client, runStarted),
    records,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 1) + "\n", "utf-8");

  const errs = records.filter((r) => r.error).length;
  console.log(`\nwrote ${OUT}`);
  console.log(`${records.length} captured, ${errs} errored, ${snapshot.elapsed_s}s`);
  // Same rule as blue.py: capturing is not judging. diff.mjs owns the verdict.
  process.exit(0);
}

main().catch((e) => die(1, `green capture aborted: ${e?.stack ?? e}`));
