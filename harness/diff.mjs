/**
 * THE GATE — diff blue's snapshot against green's.
 *
 *   node harness/diff.mjs [--allow-known-gaps] [--quiet]
 *   node harness/diff.mjs --self-test        # hand-rolled checks on the TIE logic
 *
 * Exit 0 = PASS. Non-zero = FAIL. This is the thing CI runs and the thing
 * docs/mcp-migration.md §5 calls "the deliverable of this stage, more than the
 * Worker is". No credentials needed — it only reads the two snapshots.
 *
 * ------------------------------------------------------------------ THE RULE
 *
 * Two id lists match when they are EQUAL AS SEQUENCES. Not as sets.
 *
 * A set comparison would pass a perfectly inverted ranking, and inverted
 * ranking is the failure mode this port is most exposed to: bm25() returns
 * NEGATIVE scores, so the composite sorts ASCENDING, and a reviewer "fixing"
 * that to DESC produces a green that returns the right memories in the worst
 * possible order. Every row present, every row wrong. Order is the assertion.
 *
 * ------------------------------------------------------------- CLASSIFICATION
 *
 * A bare "FAIL" tells you nothing at 2am, so every mismatch is classified. The
 * classes are chosen to map onto CAUSES, not onto shapes:
 *
 *   ORDER      same rows, different sequence  -> ranking expression, not filters
 *   TIE        same rows, different sequence, but EVERY pair that changed
 *              places is closer together in composite score than the score can
 *              drift between the two captures. Not a regression, not something
 *              either implementation can control, and not something this gate
 *              is entitled to assert. See "NEAR-TIES" below for the arithmetic.
 *   EXTRA+     blue's list STARTS WITH green's and continues -> blue's
 *              multi-stage expansion appended rows green never looks for. The
 *              signature of the known expansion gap; if you see this on a query
 *              that returns >= 3 rows, it is NOT expansion and is a real bug.
 *   EXTRA      blue returned rows green did not -> green over-filters
 *              (an extra WHERE condition, or a filter that excludes NULLs)
 *   MISSING    green returned rows blue did not -> green under-filters
 *              (a missing WHERE condition — is_superseded is the classic)
 *   SET-DIFF   both directions -> filters AND ranking; start with the filters
 *   ERR-BLUE   blue refused, green answered -> a guard green does not implement
 *   ERR-GREEN  green failed, blue answered -> usually a real green bug
 *   ERR-BOTH   both refused -> agreement, counted as a match
 *   COUNT      the ids agree but the recorded `count` does not -> a capture bug
 *
 * ------------------------------------------------------------------ KNOWN GAPS
 *
 * queries.json marks entries `expect: "known-gap"` where green is documented
 * not to implement the behaviour yet. They are still run and still shown,
 * because "we know" decays into "we forgot". By default they still FAIL the
 * gate: Stage 1 is not done while they are red. `--allow-known-gaps` narrows
 * the exit code to UNEXPECTED mismatches only, which is what you want while the
 * port is mid-flight and what you must NOT ship as the final gate.
 *
 * The reverse case is reported too and is the more interesting one: a known-gap
 * entry that MATCHES is a candidate for promotion to `expect: "parity"` — the
 * gap closed and nobody updated the query set.
 *
 * ------------------------------------------------------------------ NEAR-TIES
 *
 * THE PROBLEM. The composite score is a function of WALL-CLOCK TIME:
 *
 *     composite = bm25 * (1 + priority*0.3) * conf_factor
 *                      * 1.0 / (1.0 + (julianday('now') - julianday(m.t)) * 0.01)
 *
 * Only the last factor moves. It is monotone in `t`, which is why it was once
 * assumed the ORDER it induces is stable. It is not, because its DERIVATIVE
 * with respect to wall-clock time depends on the row's age:
 *
 *     d/dt ln|composite|  =  -0.01 / (1 + 0.01 * age_days)
 *
 * A one-day-old row's score decays at ~0.01/day; a 194-day-old row's at
 * ~0.0034/day. Rows of different ages therefore CONVERGE AND CROSS, continuously
 * and forever. Two rows tied to five decimal places will swap places, and there
 * is no "capture them closer together" that fixes it — only one that makes it
 * rarer. Work it: over the ~108 s a single blue capture takes, age advances by
 * 0.00125 days, and for a 120-day-old row that is a relative score change of
 * 0.01 * 0.00125 / 2.2 ~= 5.7e-06 — the SAME ORDER OF MAGNITUDE as the 4.2e-06
 * gap that decided the first real instance of this. The pair can cross inside a
 * single capture run. Back-to-back is not a fix; it is a smaller dice roll.
 *
 * THE TEST. When the id SETS agree and only the sequence differs, we look at
 * every pair of rows that changed places relative to each other, and ask
 * whether the score could have carried them past each other in the time
 * available. If x precedes y on blue and follows it on green, then over the
 * capture window their log-score difference travelled at least
 *
 *     sep(x,y)  =  relgap_blue(x,y) + relgap_green(x,y)
 *
 * (they were sep apart in total: gap_blue closing to zero, then reopening to
 * gap_green on the other side). Compare that against the largest differential
 * drift physically available in the window — that is EPS below. Every inverted
 * pair must fit. One that does not means something other than time moved the
 * ranking, and the whole entry stays ORDER and stays a regression.
 *
 * Three preconditions before any of that is allowed to run, each of which is a
 * way this test could otherwise lie:
 *
 *   1. Both sides must have a score for EVERY row. Blue's non-FTS `_query`
 *      path (strict / fetch_all / falsy search) computes no composite at all,
 *      so a `null` appears and the entry is not eligible.
 *   2. Both id lists must be duplicate-free, or "the pair's positions" is not
 *      well defined.
 *   3. Both score sequences must be NON-DECREASING — i.e. the composite really
 *      is the sort key for that result. This is the load-bearing guard, not a
 *      tautology: blue's multi-stage expansion re-sorts the union by PROVENANCE
 *      BOOST (3.0/2.0/1.5/1.0), not by composite, and a boost-ordered list can
 *      contain arbitrary composite inversions that have nothing to do with
 *      drift. Refusing those keeps the expansion gap classified as the gap it
 *      is.
 *
 * THE EPSILON. Derived, not chosen. Two inputs:
 *
 *   DECAY_PER_DAY = 0.01 — read straight out of the ranking expression above
 *     (`* 0.01` on the age term). Not a tunable.
 *
 *   AGE_SPREAD — the largest possible difference in the decay rates of two rows
 *     in the same result. The rate factor is 1/(1 + 0.01*age): 1.0 for a row
 *     written this second, falling toward 0 for an infinitely old one. Measured
 *     against the live corpus (2468 active rows) on 2026-07-29 the age range was
 *     0.016 .. 194.05 days, giving a spread of 0.99984 - 0.33999 = 0.660. We use
 *     1.0 instead — the supremum over ANY corpus. It costs a factor of 1.5 in
 *     tightness and buys a constant that never has to be re-derived as the
 *     corpus ages, and re-derivation is exactly the maintenance nobody does.
 *
 *   WINDOW — the wall-clock span in which both captures happened, computed FROM
 *     THE SNAPSHOTS (captured_at minus elapsed_s gives each run's start). Not a
 *     constant: a tight back-to-back capture earns a tight epsilon, a sloppy one
 *     is told, in the printed derivation, exactly how much slack it bought.
 *
 *     EPS = DECAY_PER_DAY * (WINDOW_seconds / 86400) * AGE_SPREAD
 *
 *   For the run this was built against — blue 108.5 s, green 14 s, 294 s skew,
 *   so a 402 s window — EPS came out 4.65e-05, and the offending pair's
 *   separation was 1.4e-05. Eleven times inside, and the pair's gap was itself
 *   right at the drift scale for its 94-day age difference.
 *
 * WHAT A TOO-LARGE EPSILON WOULD HIDE. EPS is a RELATIVE bound, so at 4.65e-05
 * the gate stops asserting the order of rows whose composite scores agree to
 * about one part in 21,000 — roughly the fifth significant figure. Any real
 * ranking divergence is orders of magnitude coarser than that: flipping ASC to
 * DESC, dropping the priority factor, coalescing confidence in the filter,
 * losing `is_superseded = 0`, mistyping 0.3 as 0.03 — every one of those moves
 * scores by percent or more and produces inversions between rows that are
 * nowhere near each other. The class of bug this cannot see is "green computes
 * a composite that is wrong by less than 0.005% and only ever reorders rows
 * that were already within 0.005%", which is not a bug an order comparison
 * could ever have caught. It is bounded above by the WINDOW clamp below, so it
 * cannot quietly grow to something meaningful.
 *
 * WHY NOT RECOMPUTE BOTH SIDES AT A COMMON INSTANT? It was the other candidate
 * and it is worse, for three reasons:
 *
 *   - It is not possible. Recomputing the composite needs bm25(), and bm25 is a
 *     function of corpus-wide term statistics inside the FTS index. There is no
 *     client-side re-derivation of it, and the raw bm25_score you could snapshot
 *     is itself only valid for the index as it stood at query time.
 *   - It would assert the wrong thing. The gate's job is to compare WHAT THE TWO
 *     ACCESS PATHS RETURNED. Re-ranking both sides with our own arithmetic would
 *     compare our formula against itself and pass a green whose ORDER BY is
 *     inverted — the single failure mode this harness exists to catch.
 *   - It would mean snapshotting the whole ranking input vector per row, which
 *     blue.py deliberately refuses: two of those inputs (`access_count`,
 *     `last_accessed`) are written by the act of reading.
 *
 * Freezing `now` — binding a timestamp parameter instead of `julianday('now')` —
 * would genuinely fix it, and is out of reach here: it is a change to blue's and
 * green's production ranking SQL, not to the harness, and it would change what
 * users get, not just what the gate sees.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = new Set(process.argv.slice(2));
const ALLOW_GAPS = argv.has("--allow-known-gaps");
const QUIET = argv.has("--quiet");

function load(name) {
  const path = join(HERE, "snapshots", name);
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    console.error(
      `\nMissing snapshot: ${path}\n\n` +
        "Capture both sides first, back to back:\n" +
        "  TURSO_URL=... TURSO_TOKEN=... npm run harness:blue\n" +
        "  TURSO_URL=... TURSO_TOKEN=... npm run harness:green\n",
    );
    process.exit(2);
  }
  const parsed = JSON.parse(raw);
  // Tolerate a bare array so a hand-assembled snapshot still diffs.
  return Array.isArray(parsed) ? { records: parsed } : parsed;
}

const spec = JSON.parse(readFileSync(join(HERE, "queries.json"), "utf-8"));
const meta = new Map(spec.queries.map((q) => [q.id, q]));
// The gate scores an ACCESS PATH, not a particular implementation, so which
// file plays "green" is an argument rather than a constant. That is what lets a
// candidate green — e.g. spike/fastmcp-python — be scored by this same gate
// with no special-casing. `--blue=` is the symmetric case, for comparing two
// captures of the same side to check the corpus held still.
const argFile = (flag, dflt) => {
  const hit = [...argv].find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : dflt;
};
const BLUE_FILE = argFile("--blue", "blue.json");
const GREEN_FILE = argFile("--green", "green.json");
const blue = load(BLUE_FILE);
const green = load(GREEN_FILE);
if (BLUE_FILE !== "blue.json" || GREEN_FILE !== "green.json") {
  console.log(`  comparing: blue=${BLUE_FILE}  green=${GREEN_FILE}`);
}
const byId = (snap) => new Map(snap.records.map((r) => [r.id, r]));
const B = byId(blue);
const G = byId(green);

// ------------------------------------------------------------- capture hygiene
//
// Both sides read the SAME live database (§4: data is single-homed), so the
// corpus can move between captures. Nothing here can prove it did not — the
// best we can do is show you how wide the window was and let you judge.
const warnings = [];
if (blue.captured_at && green.captured_at) {
  const skew = Math.abs(Date.parse(green.captured_at) - Date.parse(blue.captured_at)) / 1000;
  const line = `capture skew: ${skew.toFixed(0)}s (blue ${blue.captured_at}, green ${green.captured_at})`;
  if (skew > 600) {
    warnings.push(
      `${line}\n    >10 minutes apart. A write between the captures shows up here as a\n` +
        `    MISSING/EXTRA that no code change will fix. Re-capture back to back\n` +
        `    before you debug anything below.`,
    );
  } else if (!QUIET) {
    console.log(`  ${line}`);
  }
}
if (blue.access_tracking_suppressed === false) {
  warnings.push(
    "blue ran with access tracking ON — that capture incremented access_count on\n" +
      "    every row it returned, which is a ranking input under episodic=true. The\n" +
      "    NEXT run's episodic entries may reorder for that reason alone.",
  );
}
for (const id of meta.keys()) {
  if (!B.has(id)) warnings.push(`query "${id}" is in queries.json but missing from blue.json`);
  if (!G.has(id)) warnings.push(`query "${id}" is in queries.json but missing from green.json`);
}
for (const id of B.keys()) if (!meta.has(id)) warnings.push(`blue.json has stale query "${id}"`);

// ------------------------------------------------------------- the epsilon
//
// See the NEAR-TIES block in the header for the derivation. Everything here is
// either read out of the ranking expression or measured off the snapshots; the
// only judgement calls are the two clamps, and both are argued in place.

/** Straight out of the composite: `* 0.01` on the age term. Not a tunable. */
const DECAY_PER_DAY = 0.01;

/**
 * Supremum of |1/(1+0.01*a1) - 1/(1+0.01*a2)| over any two rows.
 *
 * The measured value against the live corpus on 2026-07-29 (ages 0.016..194.05
 * days, 2468 active rows) was 0.660. 1.0 is the limit as the older row's age
 * goes to infinity, so it holds for every corpus this will ever run against. A
 * 1.5x looser epsilon is a good price for a constant that cannot go stale.
 */
const AGE_SPREAD = 1.0;

/**
 * Hard ceiling on the window used for EPS, in seconds.
 *
 * 900 s ~= the >600 s skew the hygiene check already warns about, plus the two
 * capture durations. Past that, a WRITE between the captures is a likelier
 * explanation for a reordering than drift is, and the gate must not keep
 * loosening itself to accommodate a bad capture. Clamping errs toward crying
 * wolf — an ORDER verdict you can investigate — rather than toward hiding.
 */
const MAX_WINDOW_S = 900;

/**
 * Floor, in seconds. A capture cannot be instantaneous, and blue's own run
 * (~110 s) is a lower bound on how far apart two of its queries are evaluated.
 * Guards against a hand-edited snapshot with elapsed_s: 0 producing EPS = 0 and
 * a wall of spurious ORDER verdicts.
 */
const MIN_WINDOW_S = 120;

function captureWindowSeconds() {
  const endB = Date.parse(blue.captured_at);
  const endG = Date.parse(green.captured_at);
  const elB = Number(blue.elapsed_s);
  const elG = Number(green.elapsed_s);
  if (![endB, endG, elB, elG].every(Number.isFinite)) {
    // `captured_at`/`elapsed_s` are written by both capture scripts, so this is
    // a hand-assembled or truncated snapshot. Fall back to the ceiling and say
    // so: refusing to tie-analyse at all would turn a missing metadata field
    // into a fake regression, which is precisely the cry-wolf failure this
    // whole classification exists to prevent.
    return { seconds: MAX_WINDOW_S, derived: false, clamped: false, raw: null };
  }
  // Each side ran over [captured_at - elapsed_s, captured_at]. The worst-case
  // separation between the two evaluations of any single query is the span that
  // covers both runs.
  const raw = (Math.max(endB, endG) - Math.min(endB - elB * 1000, endG - elG * 1000)) / 1000;
  const seconds = Math.min(Math.max(raw, MIN_WINDOW_S), MAX_WINDOW_S);
  return { seconds, derived: true, clamped: seconds !== raw, raw };
}

const WINDOW = captureWindowSeconds();
const EPS = DECAY_PER_DAY * (WINDOW.seconds / 86400) * AGE_SPREAD;

if (WINDOW.clamped && WINDOW.raw > MAX_WINDOW_S) {
  warnings.push(
    `capture window ${WINDOW.raw.toFixed(0)}s exceeds the ${MAX_WINDOW_S}s ceiling; the\n` +
      `    near-tie epsilon is pinned at ${EPS.toExponential(2)} rather than growing with it. Reordering\n` +
      `    over a window this wide is more likely a WRITE than score drift — re-capture.`,
  );
}
if (!WINDOW.derived) {
  warnings.push(
    `could not derive the capture window from the snapshots (captured_at / elapsed_s\n` +
      `    missing or unparseable), so the near-tie epsilon defaulted to the ${MAX_WINDOW_S}s ceiling,\n` +
      `    ${EPS.toExponential(2)}. That is the LOOSEST this gate ever gets — re-capture with the\n` +
      `    current blue.py / green.mjs to earn a tighter one.`,
  );
}
// Printed unconditionally, not just when a tie fires: the epsilon is a claim
// this gate makes about what it will and will not assert, and a reader should
// see it on a passing run too.
if (!QUIET) {
  console.log(
    `  near-tie epsilon: ${EPS.toExponential(3)} relative ` +
      `(= ${DECAY_PER_DAY}/day decay x ${WINDOW.seconds.toFixed(0)}s window x ${AGE_SPREAD} age-spread)`,
  );
}

// ----------------------------------------------------------------- classifying

const sameSeq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (long, short) => short.length < long.length && short.every((x, i) => x === long[i]);

/**
 * Relative gap between two composite scores.
 *
 * Relative, not absolute, because the drift is MULTIPLICATIVE: the recency
 * factor scales the whole product, so the quantity that moves at a bounded rate
 * is ln|composite|, and |a-b|/max(|a|,|b|) is its first-order stand-in. An
 * absolute epsilon would be far too tight at the head of a result (|score| ~ 2.5)
 * and far too loose in the tail.
 */
function relGap(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 ? Math.abs(a - b) / scale : 0;
}

const nonDecreasing = (xs) => xs.every((v, i) => i === 0 || v >= xs[i - 1]);

/**
 * Can score drift alone explain blue's and green's sequences differing?
 *
 * Called only when the id SETS are already known equal. Returns
 * `{ tie, pairs, worst, reason }`; `tie` is false unless every inverted pair
 * fits inside EPS, and `reason` says which precondition or which pair refused.
 *
 * Note what is NOT done here: blue's score is never compared to green's score
 * for the same row. It cannot be — they were evaluated at different instants,
 * which is the entire problem. Only WITHIN-SIDE gaps are used.
 */
function tieAnalysis(b, g, eps = EPS) {
  const no = (reason) => ({ tie: false, pairs: [], worst: 0, reason });

  const bs = b.scores;
  const gs = g.scores;
  if (!Array.isArray(bs) || !Array.isArray(gs))
    return no("snapshot carries no `scores` — re-capture with the current blue.py / green.mjs");
  if (bs.length !== b.ids.length || gs.length !== g.ids.length)
    return no("`scores` length does not match `ids` — capture bug");
  if (bs.some((v) => typeof v !== "number") || gs.some((v) => typeof v !== "number"))
    return no(
      "some rows carry no composite_score: blue's non-FTS _query path (strict / fetch_all / " +
        "falsy search) is a plain SELECT with no ranking expression, so drift cannot be assessed",
    );
  if (new Set(b.ids).size !== b.ids.length || new Set(g.ids).size !== g.ids.length)
    return no("duplicate ids in a result — a row's rank is not well defined");
  if (!nonDecreasing(bs))
    return no(
      "blue's rows are NOT in composite order, so composite is not the sort key here — blue's " +
        "multi-stage expansion re-sorts the union by provenance boost. Not a drift question.",
    );
  if (!nonDecreasing(gs)) return no("green's rows are NOT in composite order — green's ORDER BY is suspect");

  const gIdx = new Map(g.ids.map((x, i) => [x, i]));
  const pairs = [];
  let worst = 0;
  let failed = null;

  // O(n^2) over at most a few hundred ids. The pairwise form is deliberate:
  // testing only CONSECUTIVE gaps and chaining them would let a long run of
  // barely-separated rows permute arbitrarily, because eps-closeness is not
  // transitive. Testing the actual inverted pairs is self-limiting instead —
  // since both sequences are sorted, any row ranked between an inverted pair is
  // itself between them in score, so an inverted pair that is far apart in rank
  // is also far apart in score and fails on its own merits.
  for (let i = 0; i < b.ids.length; i++) {
    for (let j = i + 1; j < b.ids.length; j++) {
      const x = b.ids[i];
      const y = b.ids[j];
      const gx = gIdx.get(x);
      const gy = gIdx.get(y);
      if (gx < gy) continue; // same relative order on both sides — nothing to explain
      const gapB = relGap(bs[i], bs[j]);
      const gapG = relGap(gs[gx], gs[gy]);
      const sep = gapB + gapG;
      if (sep > worst) worst = sep;
      const ok = sep <= eps;
      if (!ok && !failed) failed = { x, y, sep };
      // bxi/byi = blue rank of x and y; gxi/gyi = green rank of the same two.
      // Spelled out because "which index belongs to which row" is exactly the
      // thing a reader has to trust when overruling a TIE verdict.
      pairs.push({ x, y, bxi: i, byi: j, gxi: gx, gyi: gy, gapB, gapG, sep, ok });
    }
  }

  if (!pairs.length) return no("sequences differ but no pair changed relative order — impossible; report this");
  if (failed)
    return {
      tie: false,
      pairs,
      worst,
      reason:
        `${String(failed.x).slice(0, 8)} and ${String(failed.y).slice(0, 8)} swapped across a separation of ` +
        `${failed.sep.toExponential(2)}, which is wider than the ${eps.toExponential(2)} the score can drift ` +
        `in a ${WINDOW.seconds.toFixed(0)}s window. Time did not do this.`,
    };
  return { tie: true, pairs, worst, reason: null };
}

// ------------------------------------------------------- tieAnalysis self-test
//
//   node harness/diff.mjs --self-test
//
// Hand-rolled assertions, no framework — same as the rest of this harness.
//
// This exists because the near-tie classification is the one piece of the gate
// that can make a failure DISAPPEAR, and "it stopped complaining" is exactly the
// evidence you cannot trust from a change like this. Half the cases below are
// reorderings that MUST still be reported; if this file ever starts excusing
// them, the gate has quietly stopped being a gate.
//
// Fixed eps = 1e-4 throughout so the cases do not depend on snapshot timings.
function selfTest() {
  const EPS_T = 1e-4;
  let pass = 0;
  let fail = 0;

  // Build a record from a list of [id, score] in the order returned.
  const rec = (pairs) => ({
    id: "t",
    ids: pairs.map((p) => p[0]),
    scores: pairs.map((p) => p[1]),
    count: pairs.length,
    error: null,
  });

  function check(name, b, g, wantTie, wantReasonFragment) {
    const r = tieAnalysis(b, g, EPS_T);
    const okTie = r.tie === wantTie;
    const okReason =
      !wantReasonFragment || (r.reason ?? "").toLowerCase().includes(wantReasonFragment.toLowerCase());
    if (okTie && okReason) {
      pass++;
      console.log(`  ok    ${name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${name}`);
      console.log(`        wanted tie=${wantTie}${wantReasonFragment ? ` reason~"${wantReasonFragment}"` : ""}`);
      console.log(`        got    tie=${r.tie} reason=${r.reason ?? "(none)"}`);
    }
  }

  console.log("tieAnalysis self-test (eps = 1e-4)\n");

  // --- the real case: one adjacent swap, scores a few ppm apart on both sides.
  // Modelled on n-over-tool-cap: 0647c8c0 / cfa62020, 5e-06 absolute apart on a
  // score of ~-1.2373. This is the ONLY shape that should be excused.
  check(
    "adjacent near-tie swap is a TIE",
    rec([["a", -2.0], ["x", -1.2373168], ["y", -1.2373115], ["b", -1.0]]),
    rec([["a", -2.0], ["y", -1.2373139], ["x", -1.2373121], ["b", -1.0]]),
    true,
  );

  // Note on how these are built: a real green result is ALWAYS sorted ascending
  // by its own composite (ORDER BY composite_score ASC), so a green that returns
  // a different order returns different SCORES too. The cases below respect
  // that. A green whose returned sequence is not ascending is a different and
  // more serious finding, tested separately at the end.

  // --- the same swap, but the two rows are ~1% apart on both sides: green
  // computed a materially different composite. Time cannot move rows that far.
  check(
    "swap of well-separated rows is NOT a tie",
    rec([["a", -2.0], ["x", -1.24], ["y", -1.23], ["b", -1.0]]),
    rec([["a", -2.0], ["y", -1.30], ["x", -1.20], ["b", -1.0]]),
    false,
    "wider than",
  );

  // --- a fully inverted ranking that is still internally sorted, e.g. a green
  // whose composite is reciprocated or negated. Every pair is inverted and the
  // head-to-tail pairs are nowhere near tied.
  check(
    "full reversal is NOT a tie",
    rec([["a", -2.0], ["b", -1.5], ["c", -1.0]]),
    rec([["c", -2.0], ["b", -1.5], ["a", -1.0]]),
    false,
    "wider than",
  );

  // --- the literal ASC->DESC bug: green returns the right rows in descending
  // composite order. Caught by the monotonicity precondition, which names it
  // more precisely than a tie-width argument would.
  check(
    "green sorted DESC is NOT a tie, and is diagnosed as such",
    rec([["a", -2.0], ["b", -1.5], ["c", -1.0]]),
    rec([["c", -1.0], ["b", -1.5], ["a", -2.0]]),
    false,
    "green's rows are NOT in composite order",
  );

  // --- a reversal of a genuinely near-tied triple. Every inverted pair is
  // inside eps, so this IS excused, and that is the intended behaviour: three
  // rows this close have no stable order either. Recorded here so the choice is
  // explicit rather than accidental — it is the widest thing TIE will forgive.
  check(
    "reversal WITHIN a near-tied triple is a TIE (documented consequence)",
    rec([["a", -1.2373170], ["b", -1.2373160], ["c", -1.2373150]]),
    rec([["c", -1.2373171], ["b", -1.2373161], ["a", -1.2373151]]),
    true,
  );

  // --- a row from the head jumping to the tail while the tail rows are tied.
  // The tie-cluster must not launder a long-range move: eps-closeness is tested
  // pairwise, never chained, so (h,p) is judged on its own 86% gap.
  check(
    "long-range move past a tied cluster is NOT a tie",
    rec([["h", -9.0], ["p", -1.2373170], ["q", -1.2373160], ["r", -1.2373150]]),
    rec([["p", -1.2373170], ["q", -1.2373160], ["r", -1.2373150], ["h", -1.0]]),
    false,
    "wider than",
  );

  // --- missing scores: blue's non-FTS _query path. Must refuse, not assume.
  check(
    "null scores refuse tie analysis",
    rec([["x", null], ["y", null]]),
    rec([["y", null], ["x", null]]),
    false,
    "no composite_score",
  );

  // --- an old snapshot with no `scores` key at all.
  check(
    "snapshot without a scores array refuses",
    { id: "t", ids: ["x", "y"], count: 2, error: null },
    { id: "t", ids: ["y", "x"], count: 2, error: null },
    false,
    "carries no `scores`",
  );

  // --- not sorted by composite: blue's expansion re-sorts by provenance boost.
  // Even though these two rows are within eps of each other, the sequence is not
  // score-ordered, so score gaps explain nothing and the entry must stay ORDER.
  check(
    "non-monotone (boost-ordered) blue refuses",
    rec([["x", -1.2373115], ["y", -1.2373168]]),
    rec([["y", -1.2373168], ["x", -1.2373115]]),
    false,
    "not in composite order",
  );

  // --- duplicate ids: blue's expansion merge can in principle emit one twice.
  check(
    "duplicate ids refuse tie analysis",
    rec([["x", -2.0], ["x", -1.5], ["y", -1.0]]),
    rec([["y", -1.0], ["x", -2.0], ["x", -1.5]]),
    false,
    "duplicate ids",
  );

  // --- scores/ids length mismatch: a capture bug, must not be excused.
  check(
    "scores/ids length mismatch refuses",
    { id: "t", ids: ["x", "y"], scores: [-2.0], count: 2, error: null },
    { id: "t", ids: ["y", "x"], scores: [-2.0, -1.0], count: 2, error: null },
    false,
    "length does not match",
  );

  // --- SKEW: the second class that can stop a failure counting. Like TIE it
  // gets adversarial cases, half of which it MUST refuse, because "it stopped
  // complaining" is not evidence that it is right.
  function checkMut(name, r, mutatedIds, known, want) {
    const got = explainedByMutation(r, new Map(mutatedIds.map((i) => [i, {}])), known);
    if (got === want) {
      pass++;
      console.log(`  ok    ${name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${name}`);
      console.log(`        wanted ${want}, got ${got}`);
    }
  }

  checkMut("all disputed ids mutated -> void",
    { missing: ["a"], extra: ["b"] }, ["a", "b"], true, true);
  checkMut("one disputed id NOT mutated -> stays a regression",
    { missing: ["a"], extra: ["b"] }, ["a"], true, false);
  checkMut("no disputed ids (a pure reorder) -> never void",
    { missing: [], extra: [] }, ["a", "b"], true, false);
  checkMut("snapshots carry no mutation data -> never void",
    { missing: ["a"], extra: ["b"] }, ["a", "b"], false, false);
  checkMut("green-only extras, all mutated -> void",
    { extra: ["a", "b"] }, ["a", "b", "c"], true, true);
  checkMut("blue-only missing, one unmutated -> stays a regression",
    { missing: ["a", "z"] }, ["a"], true, false);

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

if (argv.has("--self-test")) process.exit(selfTest());

function classify(b, g) {
  if (!b || !g) return { cls: "NO-DATA", ok: false };

  const bErr = b.ids === null;
  const gErr = g.ids === null;
  if (bErr && gErr) return { cls: "ERR-BOTH", ok: true };
  if (bErr) return { cls: "ERR-BLUE", ok: false };
  if (gErr) return { cls: "ERR-GREEN", ok: false };

  if (sameSeq(b.ids, g.ids)) {
    // Counts are derived from ids on both sides, so a disagreement means a
    // capture script is lying, not that the databases differ. `scores` is
    // checked the same way and for the same reason: it is written parallel to
    // `ids` by construction, so a length mismatch is a capture bug, and one
    // that would silently disable near-tie detection if left unreported.
    if (b.count !== b.ids.length || g.count !== g.ids.length) return { cls: "COUNT", ok: false };
    if (
      (Array.isArray(b.scores) && b.scores.length !== b.ids.length) ||
      (Array.isArray(g.scores) && g.scores.length !== g.ids.length)
    )
      return { cls: "COUNT", ok: false };
    return { cls: "MATCH", ok: true };
  }

  const bs = new Set(b.ids);
  const gs = new Set(g.ids);
  const missing = g.ids.filter((x) => !bs.has(x)); // in green, not in blue
  const extra = b.ids.filter((x) => !gs.has(x)); // in blue, not in green

  if (!missing.length && !extra.length) {
    // Same rows, different sequence. Before calling this a ranking regression,
    // ask whether wall-clock drift in the composite could have done it. A gate
    // that cries wolf gets ignored; a gate that hides real reordering is
    // worthless. tieAnalysis() is written to refuse rather than to excuse — the
    // reason it gives is printed either way.
    const tie = tieAnalysis(b, g);
    if (tie.tie) return { cls: "TIE", ok: true, missing, extra, tie };
    return { cls: "ORDER", ok: false, missing, extra, tie };
  }
  if (!missing.length) {
    // Blue's list beginning with green's entire list is the expansion
    // signature: primary hits first, expansion rows appended.
    return { cls: startsWith(b.ids, g.ids) ? "EXTRA+" : "EXTRA", ok: false, missing, extra };
  }
  if (!extra.length) return { cls: "MISSING", ok: false, missing, extra };
  return { cls: "SET-DIFF", ok: false, missing, extra };
}

// ----------------------------------------------------------- corpus mutation
//
// TIE and SKEW both make a failure stop counting as a regression, and they are
// NOT the same claim — the distinction is the whole reason SKEW is separate:
//
//   TIE  the gate declines to assert an ordering the ranking does not have.
//        The verdict PASSES. Re-running changes nothing.
//   SKEW the corpus changed underneath the two captures, so the two sides were
//        asked different questions. The verdict is VOID, not passing. The only
//        remedy is to capture again; accepting it would be accepting a
//        measurement we know to be invalid.
//
// This is provable rather than statistical: a row whose created_at/updated_at/
// deleted_at lands inside the capture window is a fact the capture scripts
// record. `supersede()` is the case that motivated it — it soft-deletes the
// original WITHOUT bumping updated_at, so one supersede lands as a new row AND
// removes an old one, shifting every LIMITed result set that contained either.
// Thirteen entries, one write.

const mutationsOf = (snap) => (Array.isArray(snap.corpus_mutations) ? snap.corpus_mutations : null);
const blueMut = mutationsOf(blue);
const greenMut = mutationsOf(green);
const MUT_KNOWN = blueMut !== null || greenMut !== null;
const MUTATED = new Map();
for (const m of [...(blueMut ?? []), ...(greenMut ?? [])]) {
  if (!MUTATED.has(m.id)) MUTATED.set(m.id, m);
}
if (!MUT_KNOWN) {
  warnings.push(
    "snapshots predate the corpus-mutation check (no `corpus_mutations` field) — " +
      "a concurrent write during capture will read as a green regression. Re-capture both sides.",
  );
}

/**
 * True when EVERY id the two sides disagree about was mutated mid-capture.
 *
 * Pure, and takes its state as arguments rather than closing over `MUTATED` —
 * `selfTest()` runs before those module consts initialise, so a closure here
 * would be unreachable from the one place that proves this logic correct.
 *
 * "Every" is the whole safety property. One disputed id outside the mutated set
 * means something other than the concurrent write also differed, and the entry
 * stays a regression.
 */
/**
 * Seconds between the two capture windows that NEITHER side observed.
 *
 * Each side probes for mutations since its OWN run start, so a write landing in
 * the gap *between* the runs is invisible to both — which is the original bug's
 * surviving form. The supersede that voided the first run happened DURING
 * blue's capture and is caught; the same write thirty seconds later would not
 * be, and would still read as a regression.
 *
 * This cannot be auto-excused: an unobserved window is an absence of evidence,
 * not evidence of a mutation, and excusing failures on it would be exactly the
 * laundering SKEW is careful not to do. So it is reported instead — a reader
 * who sees unexplained failures alongside a non-zero blind spot knows to
 * re-capture before debugging.
 */
function unobservedGapSeconds() {
  const start = (x) => Date.parse(x.run_started_at ?? x.captured_at);
  const end = (x) => Date.parse(x.captured_at);
  if ([start(blue), end(blue), start(green), end(green)].some(Number.isNaN)) return null;
  // Positive only when the windows are disjoint; overlapping runs have no blind spot.
  return Math.max(0, Math.max(start(blue) - end(green), start(green) - end(blue))) / 1000;
}

function explainedByMutation(r, mutated, known) {
  if (!known) return false;
  const disputed = [...(r.missing ?? []), ...(r.extra ?? [])];
  if (disputed.length === 0) return false;
  return disputed.every((id) => mutated.has(id));
}

// --------------------------------------------------------------------- verdicts

const rows = [];
for (const q of spec.queries) {
  const b = B.get(q.id);
  const g = G.get(q.id);
  const r = classify(b, g);
  const known = q.expect === "known-gap";
  // Void, not passing — see the SKEW note above. Only ever applied to an entry
  // that already failed, and only when EVERY disputed id was mutated mid-run.
  if (!r.ok && !known && explainedByMutation(r, MUTATED, MUT_KNOWN)) {
    r.wasCls = r.cls;
    r.cls = "SKEW";
    r.void = true;
  }
  rows.push({
    q,
    b,
    g,
    ...r,
    known,
    // "Surprise" cuts both ways and both are worth a human's attention:
    // a parity entry that broke, and a known gap that quietly closed.
    surprise: known && r.ok ? "gap-closed"
      : r.void ? null
      : !known && !r.ok ? "regression"
      : null,
  });
}

// --------------------------------------------------------------------- reporting

const W = 30;
const short = (ids, k = 4) =>
  ids === null
    ? "<error>"
    : ids.length === 0
      ? "[]"
      : `[${ids.slice(0, k).map((x) => String(x).slice(0, 8)).join(" ")}${ids.length > k ? ` +${ids.length - k}` : ""}]`;

console.log("\n=== per-query verdict " + "=".repeat(46));
for (const r of rows) {
  // TIE gets its own tag rather than hiding under "ok": it PASSES, but it is
  // not the same claim as MATCH, and a reader scanning this table should see
  // that the gate declined to assert an ordering rather than verified one.
  const tag = r.cls === "TIE" ? "tie " : r.cls === "SKEW" ? "VOID"
    : r.ok ? "ok  " : r.known ? "GAP " : "FAIL";
  console.log(
    `${tag} ${r.q.id.padEnd(W)} ${r.cls.padEnd(9)} ` +
      `blue=${String(r.b?.count ?? "-").padStart(3)} green=${String(r.g?.count ?? "-").padStart(3)}`,
  );
}

const bad = rows.filter((r) => !r.ok);
if (bad.length) {
  console.log("\n=== mismatch detail " + "=".repeat(48));
  for (const r of bad) {
    const label = r.cls === "SKEW" ? "  ** VOID — corpus moved mid-capture **"
      : r.known ? "  (declared known-gap)"
      : "  ** REGRESSION **";
    console.log(`\n--- ${r.q.id}   [${r.cls}]${label}`);
    console.log(`    why : ${r.q.why}`);
    if (r.known) console.log(`    gap : ${r.q.gap}`);
    console.log(`    args: ${JSON.stringify(r.q.args)}`);
    console.log(`    blue: ${short(r.b?.ids ?? null, 8)}${r.b?.error ? `  ${r.b.error}` : ""}`);
    console.log(`    grn : ${short(r.g?.ids ?? null, 8)}${r.g?.error ? `  ${r.g.error}` : ""}`);
    if (r.extra?.length) console.log(`    only in blue  (${r.extra.length}): ${short(r.extra, 8)}`);
    if (r.missing?.length) console.log(`    only in green (${r.missing.length}): ${short(r.missing, 8)}`);
    // For an ORDER verdict, say WHY the near-tie explanation was rejected. This
    // is the difference between "the gate disagrees" and "the gate disagrees
    // and here is the number that decided it".
    if (r.cls === "ORDER" && r.tie) {
      console.log(`    tie?: NO — ${r.tie.reason}`);
      if (r.tie.pairs.length)
        console.log(
          `          ${r.tie.pairs.length} pair(s) changed places, widest separation ` +
            `${r.tie.worst.toExponential(2)} vs epsilon ${EPS.toExponential(2)}`,
        );
    }
    if (r.g?.notes) for (const n of r.g.notes) console.log(`    note: ${n}`);
  }
}

// ------------------------------------------------------------------- near-ties
//
// Its own section, not a footnote in the summary. These entries PASSED, and the
// reader needs enough to overrule that judgement: the actual score gaps, the
// epsilon, and the derivation that produced it.
const ties = rows.filter((r) => r.cls === "TIE");
if (ties.length && !QUIET) {
  console.log("\n=== near-ties: reordered, NOT counted as regressions " + "=".repeat(16));
  console.log("    The composite score contains julianday('now') and rows of different ages");
  console.log("    decay at different rates, so near-tied rows cross over continuously. The");
  console.log("    entries below reordered by less than the score can drift between captures.");
  console.log("    Neither side is wrong; this ordering is not a property either can promise.");
  console.log("");
  console.log(
    `    epsilon ${EPS.toExponential(3)} = 0.01/day decay x ${WINDOW.seconds.toFixed(0)}s window` +
      ` (${(WINDOW.seconds / 86400).toExponential(2)} d) x ${AGE_SPREAD} age-spread` +
      (WINDOW.derived ? "" : "  [window not derivable from snapshots — DEFAULTED]") +
      (WINDOW.clamped && WINDOW.derived ? `  [clamped from ${WINDOW.raw.toFixed(0)}s]` : ""),
  );
  for (const r of ties) {
    console.log(`\n    --- ${r.q.id}   ${r.tie.pairs.length} inverted pair(s), ${r.b.ids.length} rows`);
    // Every number a reader needs to overrule this: both rows, both ranks on
    // both sides, both scores, the two gaps, their sum, and the epsilon.
    const rank = (i) => `#${String(i).padStart(3)}`;
    for (const p of r.tie.pairs.slice(0, 8)) {
      console.log(
        `        ${String(p.x).slice(0, 8)}   blue ${rank(p.bxi)} ${r.b.scores[p.bxi].toFixed(12)}` +
          `   green ${rank(p.gxi)} ${r.g.scores[p.gxi].toFixed(12)}`,
      );
      console.log(
        `        ${String(p.y).slice(0, 8)}   blue ${rank(p.byi)} ${r.b.scores[p.byi].toFixed(12)}` +
          `   green ${rank(p.gyi)} ${r.g.scores[p.gyi].toFixed(12)}`,
      );
      console.log(
        `        gap blue ${p.gapB.toExponential(3)} + gap green ${p.gapG.toExponential(3)}` +
          ` = ${p.sep.toExponential(3)}  <=  eps ${EPS.toExponential(3)}`,
      );
    }
    if (r.tie.pairs.length > 8) console.log(`        ... ${r.tie.pairs.length - 8} more pair(s)`);
  }
}

// The tool layer is compared against GREEN'S OWN result, never against blue:
// tools.ts::recall clamps n into [1,50] and turns n=0 into 10, so it is
// answering a slightly different question by design. Surfacing it here keeps
// that design decision visible instead of letting it hide behind a passing gate.
const toolDrift = rows.filter(
  (r) => r.g?.toolPrefixes && r.g.ids && !sameSeq(r.g.toolPrefixes, r.g.ids.map((x) => String(x).slice(0, 8))),
);
if (toolDrift.length && !QUIET) {
  console.log("\n=== tool-layer drift (green vs green — informational) " + "=".repeat(14));
  console.log("    tools.ts::recall clamps n to [1,50] and maps n=0 to 10.");
  for (const r of toolDrift) {
    console.log(
      `    ${r.q.id.padEnd(W)} search()=${r.g.ids.length} rows, tools.recall()=${r.g.toolPrefixes.length} rows`,
    );
  }
}

const voided = rows.filter((r) => r.cls === "SKEW");
if (voided.length) {
  console.log("\n=== VOID: the corpus changed during capture " + "=".repeat(25));
  console.log("    These entries are NOT evidence about green. The two sides were asked");
  console.log("    different questions because the corpus moved between them, so the");
  console.log("    comparison has no verdict to give. Re-capture blue and green.");
  console.log(`\n    ${MUTATED.size} row(s) changed inside the capture window:`);
  for (const m of [...MUTATED.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    console.log(`        ${m.at}  ${String(m.id).slice(0, 8)}  ${m.kind}`);
  }
  console.log("");
  for (const r of voided) {
    const disputed = [...(r.missing ?? []), ...(r.extra ?? [])];
    console.log(
      `    ${r.q.id.padEnd(W)} was ${String(r.wasCls).padEnd(9)}` +
        ` disputed: [${disputed.map((x) => String(x).slice(0, 8)).join(" ")}]`,
    );
  }
  // A supersede writes one row and soft-deletes another, so it can shift every
  // LIMITed result that contained either. One write, many entries: say so, or
  // the count reads as a broad failure rather than a single event.
  if (voided.length > 1) {
    console.log(
      `\n    ${voided.length} entries, ${MUTATED.size} mutated row(s) — a single write can` +
        ` void many\n    entries at once, because it shifts every result set that was LIMITed` +
        ` around it.`,
    );
  }
}

const blindSpot = unobservedGapSeconds();
const unexplained = rows.filter((r) => r.surprise === "regression");
if (blindSpot !== null && blindSpot > 0 && unexplained.length) {
  warnings.push(
    `${blindSpot.toFixed(0)}s between the two capture windows was observed by NEITHER side — ` +
      `each probes only its own run. A write in that gap reads as a regression and no code ` +
      `change will fix it. ${unexplained.length} unexplained failure(s) below; re-capture back ` +
      `to back before debugging them.`,
  );
}

const promote = rows.filter((r) => r.surprise === "gap-closed");
if (promote.length) {
  console.log("\n=== gaps that appear to have CLOSED " + "=".repeat(33));
  console.log("    These are marked known-gap in queries.json but matched. Verify, then");
  console.log("    promote them to expect:\"parity\" so they can never silently reopen.");
  // A gap that "closed" on an entry returning nothing on either side has not
  // been shown to close — it has been shown to be untested that day. The README
  // says to read the counts, not the verdicts; this makes that unmissable rather
  // than a discipline the reader has to remember.
  for (const r of promote) {
    const empty = (r.b?.ids?.length ?? 0) === 0 && (r.g?.ids?.length ?? 0) === 0;
    console.log(
      `    ${r.q.id.padEnd(W)}` +
        (empty
          ? "  !! blue=0 green=0 — matches TRIVIALLY, proves nothing. Do NOT promote"
          : `  blue=${r.b.ids.length} green=${r.g.ids.length}`),
    );
  }
}

if (warnings.length) {
  console.log("\n=== warnings " + "=".repeat(55));
  for (const w of warnings) console.log(`  ! ${w}`);
}

// ----------------------------------------------------------------------- summary

const counts = {};
for (const r of rows) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
const regressions = rows.filter((r) => r.surprise === "regression").length;
const gapFails = rows.filter((r) => !r.ok && r.known).length;

console.log("\n=== summary " + "=".repeat(56));
console.log("  class      count   meaning");
const MEANING = {
  MATCH: "identical id sequence",
  "ERR-BOTH": "both sides refused — agreement",
  TIE: "reordered within the score-drift bound — not assertable",
  ORDER: "same rows, different order — ranking",
  "EXTRA+": "blue continued past green's list — expansion signature",
  EXTRA: "blue returned rows green did not — green over-filters",
  MISSING: "green returned rows blue did not — green under-filters",
  "SET-DIFF": "rows differ both ways — filters first, then ranking",
  SKEW: "VOID — corpus changed mid-capture; not evidence either way",
  "ERR-BLUE": "blue refused, green answered",
  "ERR-GREEN": "green failed, blue answered",
  COUNT: "ids agree, recorded count does not — capture bug",
  "NO-DATA": "a snapshot is missing this query",
};
for (const [cls, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cls.padEnd(10)} ${String(n).padStart(5)}   ${MEANING[cls] ?? ""}`);
}
console.log(
  // "matched" keeps its old meaning (an agreeing verdict, including ERR-BOTH);
  // near-ties are broken out because they agreed on the ROWS while the gate
  // declined to assert their ORDER, and conflating the two would overstate what
  // this run proved.
  `\n  ${rows.length} queries | ${rows.filter((r) => r.ok && r.cls !== "TIE").length} matched | ` +
    `${ties.length} near-tie | ${regressions} regressions | ${gapFails} declared gaps still open`,
);

// A voided run must not report success. It is not a regression — but it is not
// a pass either, and `--allow-known-gaps` must not launder it into one.
const inconclusive = voided.length > 0;
const fail = (ALLOW_GAPS ? regressions > 0 : bad.length > 0) || inconclusive;
if (fail) {
  console.log(
    (inconclusive && regressions === 0 && bad.length === voided.length
      ? `\n  INCONCLUSIVE — ${voided.length} entr${voided.length === 1 ? "y" : "ies"} voided by a` +
        ` mid-capture write; no regressions. Re-run the harness.`
      : "") +
    `\n  FAIL — ${ALLOW_GAPS ? `${regressions} regression(s)` : `${bad.length} mismatch(es)`}` +
      (ALLOW_GAPS ? "" : gapFails ? `, of which ${gapFails} are declared known gaps` : ""),
  );
  if (!ALLOW_GAPS && gapFails === bad.length) {
    console.log("  (every failure is a declared gap — `--allow-known-gaps` gates on regressions only)");
  }
  process.exit(1);
}
console.log(
  `\n  PASS${ALLOW_GAPS && gapFails ? ` (${gapFails} declared gaps still open, not gated)` : ""}`,
);
process.exit(0);
