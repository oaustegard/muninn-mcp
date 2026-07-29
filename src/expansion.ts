/**
 * Multi-stage recall expansion — the part of the read path that is NOT SQL.
 *
 * Port of the expansion block inside `memory.py::recall` (muninn-utilities,
 * `remembering/scripts/memory.py` ~line 610, v5.4.0 / #383).
 *
 * docs/mcp-migration.md §3 argues the port is tractable because "Muninn's
 * ranking is already server-side SQL, not Python". §5's Stage 1 note records
 * exactly where that claim stops holding:
 *
 *   > §3's central claim has a boundary. [...] It stops being true at
 *   > `recall()`, where Python sits *above* the SQL and is order-dependent.
 *   > Byte-equal SQL does not imply equal results. The expansion layer is the
 *   > part of the read path that still has to be ported carefully rather than
 *   > transcribed.
 *
 * This file is that layer. `turso.ts::search` stays expansion-free — the parity
 * harness compares at both layers, and a `search()` that silently expanded would
 * make the SQL-level comparison meaningless.
 *
 * ------------------------------------------------------------------ THE RULE
 *
 * TRANSCRIBE, DO NOT IMPROVE. Where this TypeScript would differ from the
 * Python, the Python wins — including where the Python is wrong. Two divergences
 * already shipped in this repo because a previous author knew better than blue
 * (see the PARITY notes in `turso.ts::buildSearch`); both were bugs. Every place
 * below where blue's behaviour is questionable is marked `BLUE BUG` and
 * replicated anyway.
 *
 * ------------------------------------------------------------------ THE SHAPE
 *
 *   stage 1   the primary FTS search (`turso.ts::search`)
 *             — fires expansion only if it returned FEWER than
 *               `expansionThreshold` rows (default 3)
 *   stage 2   collect the tags of the stage-1 rows
 *   stage 2b  PMI co-occurrence expansion of those tags
 *             — or, with NO stage-1 tags, of the QUERY WORDS at minPmi 0.0
 *   stage 3   re-search on each stage-1 tag        (n=5, BOOST_STAGE1_TAG)
 *   stage 3b  re-search on each co-occurrence tag  (n=5, BOOST_COOCCUR)
 *   stage 4   re-search on the second-hop tags     (n=3, BOOST_HOP2)
 *   merge     primary ++ expansion, sorted by accumulated boost DESC, sliced to n
 *
 * Out of scope on purpose, both of them blue behaviour that green cannot or
 * should not reproduce: `exploration` reranking (client-side Python, applied
 * after this block) and `_update_access_tracking` (a write; this deployment is
 * read-only).
 */

import type { Client } from "@libsql/client/web";
import {
  cooccurrenceExpand,
  search,
  type MemoryRow,
  type SearchOpts,
} from "./turso.ts";
import { parseJsonArray } from "./queries.ts";

/**
 * Boost weights by match provenance. Transcribed from memory.py, including the
 * ordering of the constants, which is the ordering of the stages.
 */
export const BOOST_PRIMARY = 3.0; // original query terms
export const BOOST_STAGE1_TAG = 2.0; // tags from initial results
export const BOOST_COOCCUR = 1.5; // co-occurrence expanded terms
export const BOOST_HOP2 = 1.0; // second-hop discovered terms

/** Blue's `expansion_threshold` default. 0 disables expansion entirely. */
export const DEFAULT_EXPANSION_THRESHOLD = 3;

/** Blue's `n` default on `recall()`, which is also `_fts5_search`'s. */
const DEFAULT_N = 10;

/** Per-stage result caps: stages 3 and 3b take 5 rows per tag, stage 4 takes 3. */
const STAGE1_TAG_N = 5;
const COOCCUR_TAG_N = 5;
const HOP2_TAG_N = 3;

/** `_cooccurrence_expand(..., n=10, min_pmi=0.5)` for the stage-1-tag path. */
const COOCCUR_N = 10;
const COOCCUR_MIN_PMI = 0.5;
/** ...and `min_pmi=0.0` for the no-stage-1-tags query-word path. */
const QUERY_WORD_MIN_PMI = 0.0;

/** A row as the FTS SELECT actually returns it. `bm25_score` drives every boost. */
export interface ScoredMemoryRow extends MemoryRow {
  bm25_score?: number | null;
}

export interface ExpansionOpts extends SearchOpts {
  /**
   * Minimum primary-result count before expansion fires. Blue's default is 3;
   * 0 (or any non-positive value) disables expansion entirely.
   *
   * Note it is compared against the PRIMARY RESULT COUNT, not against `n` —
   * `queries.json::sparse-expansion-raised` is the probe that pins that.
   */
  expansionThreshold?: number;
}

/**
 * Compare two strings the way Python's `sorted()` compares `str`: by CODE POINT.
 *
 * This is not decoration. The three expansion loops below iterate what were
 * SETS in Python and each breaks early on a budget, so WHICH tags get visited
 * decides the answer. Blue used to iterate the bare set and PEP 456 hash
 * randomisation made the result vary per process — `recall('bluesky', n=1)`
 * returned three different ids across six `PYTHONHASHSEED` values. Fixed
 * upstream by sorting (muninn-utilities#100); green must sort the same way or
 * it reintroduces the divergence from the other side.
 *
 * Why not the bare `Array.prototype.sort()` default: that default compares
 * UTF-16 CODE UNITS, and the two orders disagree above the BMP. Python puts
 * `'a' < '�' < '\u{1F600}'`; a code-unit sort puts the emoji FIRST,
 * because its lead surrogate `\uD83D` is below `�`. The two agree on every
 * BMP string, so this only bites on astral tags — which is precisely the kind of
 * silent, corpus-dependent divergence this port exists to avoid. The current
 * corpus has no non-ASCII tags at all; that is a fact about today's data, not a
 * property of the schema.
 *
 * Ties (identical strings) return 0 and `Array.prototype.sort` is stable, as is
 * Python's, so equal elements keep their input order in both worlds.
 */
export function codePointCompare(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const len = Math.min(ca.length, cb.length);
  for (let i = 0; i < len; i++) {
    const x = ca[i].codePointAt(0) as number;
    const y = cb[i].codePointAt(0) as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ca.length - cb.length;
}

/** `sorted(some_set)` — a code-point-ordered array of a tag set. */
function sortedTags(tags: Set<string>): string[] {
  return [...tags].sort(codePointCompare);
}

/**
 * Blue's `abs(float(r.get('bm25_score', 0) or 0))`.
 *
 * The `or 0` is a FALSY test, not a null test, so `None`, `0` and `0.0` all
 * collapse identically — same as `cooccurrenceExpand`'s handling of `pmi`.
 * `bm25()` is negative (more negative = better match), hence the `abs`: without
 * it every boost would be negative and the final descending sort would rank the
 * WORST matches first.
 */
export function bm25Boost(row: ScoredMemoryRow): number {
  const raw = row.bm25_score;
  return Math.abs(raw ? Number(raw) : 0);
}

/** Tags off a raw row. Blue reads an already-parsed list and skips non-lists. */
function tagsOf(row: MemoryRow): string[] {
  return parseJsonArray(row.tags).map(String);
}

/**
 * The option subset the expansion re-searches forward.
 *
 * BLUE BUG — REPLICATED DELIBERATELY. Blue forwards `type`, `tags`, `tag_mode`,
 * `conf`, `since` and `until` to stages 3, 3b and 4, but NOT `session_id` (and
 * not `episodic` either). A session-scoped sparse recall therefore leaks rows
 * from OTHER sessions into its own results, because only the primary search is
 * session-filtered.
 *
 * Green must not "fix" this. Diverging correctly here would fail the parity gate
 * and, worse, hide the bug behind a green pass — the harness would report the
 * shapes as matching and nobody would go look. It is flagged upstream for its
 * own decision; when blue changes, this comment and this function change with
 * it. See the task note accompanying this port.
 */
function stageOpts(opts: ExpansionOpts, n: number): SearchOpts {
  return {
    n,
    type: opts.type,
    tags: opts.tags,
    tagMode: opts.tagMode,
    conf: opts.conf,
    since: opts.since,
    until: opts.until,
    // sessionId: DELIBERATELY ABSENT — see the BLUE BUG note above.
    // episodic: likewise absent; blue does not forward it either, so the
    // expansion rows are always ranked without the access-count factor.
  };
}

/**
 * Blue's `[w.strip().lower() for w in search.split() if w.strip()]`.
 *
 * Reached only when the primary search produced NO tags at all — typically
 * because it produced no rows. `queries.json::sparse-nonsense-token` is the
 * probe: a token that cannot appear in the corpus still expands its own words
 * through PMI at `min_pmi=0.0` and can return rows from nowhere.
 */
export function queryWords(query: string): string[] {
  return query
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

/**
 * `memory.py::recall`'s FTS path: primary search, then multi-stage expansion.
 *
 * Returns rows in blue's final order — boost DESC, sliced to `n` — or the
 * primary rows untouched when expansion does not fire.
 */
export async function recallWithExpansion(
  client: Client,
  query: string,
  opts: ExpansionOpts = {},
): Promise<ScoredMemoryRow[]> {
  const { expansionThreshold = DEFAULT_EXPANSION_THRESHOLD } = opts;
  const n = opts.n ?? DEFAULT_N;

  // Stage 1. `search()` already carries blue's retry-with-backoff. Blue also
  // falls back to a LIKE query when `memory_fts` is missing entirely; green has
  // no non-FTS path (declared as a known gap in harness/green.mjs) so a missing
  // FTS table propagates here rather than degrading.
  const results = (await search(client, query, opts)) as ScoredMemoryRow[];

  if (!(expansionThreshold > 0 && results.length < expansionThreshold)) {
    return results;
  }

  const seenIds = new Set<string>(results.map((r) => String(r.id)));
  // Boost score per memory id.
  const boostScores = new Map<string, number>();
  for (const r of results) {
    // Primary results get the highest boost.
    boostScores.set(String(r.id), bm25Boost(r) * BOOST_PRIMARY);
  }

  // Stage 2: extract tags from the stage-1 results.
  const stage1Tags = new Set<string>();
  for (const r of results) {
    for (const t of tagsOf(r)) stage1Tags.add(t);
  }

  // Stage 2b: co-occurrence expansion — find related tags via PMI.
  let cooccurTags = new Set<string>();
  if (stage1Tags.size > 0) {
    try {
      // Blue passes `list(stage1_tags)` — an UNSORTED set materialisation. That
      // is safe to leave unsorted: `_cooccurrence_expand` keeps the best PMI per
      // output tag and the caller only consumes the tag SET, so probe order
      // cannot change which tags come back. Sorting matters at the loops below,
      // where a budget truncates.
      const expanded = await cooccurrenceExpand(client, [...stage1Tags], {
        n: COOCCUR_N,
        minPmi: COOCCUR_MIN_PMI,
      });
      cooccurTags = new Set(expanded.map((e) => e.tag));
    } catch {
      // The co-occurrence table may not exist yet — blue's bare `except: pass`.
      // `cooccurrenceExpand` already swallows a missing table on its own probe;
      // this catches the case where the probe succeeds and a later query fails.
    }
  }

  // Even with 0 stage-1 results, try expanding the QUERY WORDS via co-occurrence.
  // Note blue's guard is on `stage1_tags` being empty, not on `results` being
  // empty — a row with no tags at all takes this branch too.
  if (stage1Tags.size === 0) {
    try {
      const expanded = await cooccurrenceExpand(client, queryWords(query), {
        n: COOCCUR_N,
        minPmi: QUERY_WORD_MIN_PMI,
      });
      cooccurTags = new Set(expanded.map((e) => e.tag));
    } catch {
      // Same swallow as above.
    }
  }

  const expansionResults: ScoredMemoryRow[] = [];

  /**
   * One expansion stage. All three are identical apart from the per-tag row cap
   * and the boost weight, so they are one function here — the Python repeats the
   * body three times, but the repetition is not the behaviour.
   *
   * Two details that ARE the behaviour:
   *  - the budget check runs BEFORE the search, and only between tags, so a
   *    single tag's rows can push the total PAST `n * 2`;
   *  - a search failure BREAKS the whole stage rather than skipping the tag
   *    (blue catches `RuntimeError`, which is what its `_exec` raises for any
   *    Turso error, so "catch everything" is the faithful translation).
   */
  const runStage = async (tags: string[], perTagN: number, boost: number) => {
    for (const tag of tags) {
      if (results.length + expansionResults.length >= n * 2) break;
      let tagResults: ScoredMemoryRow[];
      try {
        tagResults = (await search(client, tag, stageOpts(opts, perTagN))) as ScoredMemoryRow[];
      } catch {
        break;
      }
      for (const tr of tagResults) {
        const id = String(tr.id);
        if (!seenIds.has(id)) {
          // `+= ` transcribed from blue, where it is vestigial: `seenIds` is
          // updated in the same breath, so no id can reach this line twice and
          // the left-hand `?? 0` is always 0. A row found by two stages keeps
          // the FIRST stage's boost and is NOT counted again. Kept in this form
          // because it is what blue does and because if the dedupe ever moves,
          // this is already the correct arithmetic.
          boostScores.set(id, (boostScores.get(id) ?? 0) + bm25Boost(tr) * boost);
          expansionResults.push(tr);
          seenIds.add(id);
        }
      }
    }
  };

  // Stage 3: search by stage-1 tags.
  await runStage(sortedTags(stage1Tags), STAGE1_TAG_N, BOOST_STAGE1_TAG);

  // Stage 3b: search by co-occurrence-expanded tags.
  await runStage(sortedTags(cooccurTags), COOCCUR_TAG_N, BOOST_COOCCUR);

  // Stage 4: second hop — tags of the expansion results, minus everything
  // already visited, searched again.
  const hop2Tags = new Set<string>();
  for (const r of expansionResults) {
    for (const t of tagsOf(r)) hop2Tags.add(t);
  }
  for (const t of stage1Tags) hop2Tags.delete(t);
  for (const t of cooccurTags) hop2Tags.delete(t);

  await runStage(sortedTags(hop2Tags), HOP2_TAG_N, BOOST_HOP2);

  // Merge: primary ++ expansion, sorted by boost, top n.
  //
  // Python's `list.sort(key=..., reverse=True)` is STABLE and `reverse=True`
  // does NOT reverse ties — equal-boost rows keep their input order, which puts
  // primary rows ahead of expansion rows and preserves composite order within
  // each group. `Array.prototype.sort` has been stable since ES2019, so a
  // `b - a` comparator reproduces that exactly.
  const allResults = [...results, ...expansionResults];
  allResults.sort(
    (a, b) => (boostScores.get(String(b.id)) ?? 0) - (boostScores.get(String(a.id)) ?? 0),
  );
  return allResults.slice(0, n);
}
