/**
 * THE GATE — diff blue's snapshot against green's.
 *
 *   node harness/diff.mjs [--allow-known-gaps] [--quiet]
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
const blue = load("blue.json");
const green = load("green.json");
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

// ----------------------------------------------------------------- classifying

const sameSeq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (long, short) => short.length < long.length && short.every((x, i) => x === long[i]);

function classify(b, g) {
  if (!b || !g) return { cls: "NO-DATA", ok: false };

  const bErr = b.ids === null;
  const gErr = g.ids === null;
  if (bErr && gErr) return { cls: "ERR-BOTH", ok: true };
  if (bErr) return { cls: "ERR-BLUE", ok: false };
  if (gErr) return { cls: "ERR-GREEN", ok: false };

  if (sameSeq(b.ids, g.ids)) {
    // Counts are derived from ids on both sides, so a disagreement means a
    // capture script is lying, not that the databases differ.
    if (b.count !== b.ids.length || g.count !== g.ids.length) return { cls: "COUNT", ok: false };
    return { cls: "MATCH", ok: true };
  }

  const bs = new Set(b.ids);
  const gs = new Set(g.ids);
  const missing = g.ids.filter((x) => !bs.has(x)); // in green, not in blue
  const extra = b.ids.filter((x) => !gs.has(x)); // in blue, not in green

  if (!missing.length && !extra.length) return { cls: "ORDER", ok: false, missing, extra };
  if (!missing.length) {
    // Blue's list beginning with green's entire list is the expansion
    // signature: primary hits first, expansion rows appended.
    return { cls: startsWith(b.ids, g.ids) ? "EXTRA+" : "EXTRA", ok: false, missing, extra };
  }
  if (!extra.length) return { cls: "MISSING", ok: false, missing, extra };
  return { cls: "SET-DIFF", ok: false, missing, extra };
}

// --------------------------------------------------------------------- verdicts

const rows = [];
for (const q of spec.queries) {
  const b = B.get(q.id);
  const g = G.get(q.id);
  const r = classify(b, g);
  const known = q.expect === "known-gap";
  rows.push({
    q,
    b,
    g,
    ...r,
    known,
    // "Surprise" cuts both ways and both are worth a human's attention:
    // a parity entry that broke, and a known gap that quietly closed.
    surprise: known && r.ok ? "gap-closed" : !known && !r.ok ? "regression" : null,
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
  const tag = r.ok ? "ok  " : r.known ? "GAP " : "FAIL";
  console.log(
    `${tag} ${r.q.id.padEnd(W)} ${r.cls.padEnd(9)} ` +
      `blue=${String(r.b?.count ?? "-").padStart(3)} green=${String(r.g?.count ?? "-").padStart(3)}`,
  );
}

const bad = rows.filter((r) => !r.ok);
if (bad.length) {
  console.log("\n=== mismatch detail " + "=".repeat(48));
  for (const r of bad) {
    console.log(`\n--- ${r.q.id}   [${r.cls}]${r.known ? "  (declared known-gap)" : "  ** REGRESSION **"}`);
    console.log(`    why : ${r.q.why}`);
    if (r.known) console.log(`    gap : ${r.q.gap}`);
    console.log(`    args: ${JSON.stringify(r.q.args)}`);
    console.log(`    blue: ${short(r.b?.ids ?? null, 8)}${r.b?.error ? `  ${r.b.error}` : ""}`);
    console.log(`    grn : ${short(r.g?.ids ?? null, 8)}${r.g?.error ? `  ${r.g.error}` : ""}`);
    if (r.extra?.length) console.log(`    only in blue  (${r.extra.length}): ${short(r.extra, 8)}`);
    if (r.missing?.length) console.log(`    only in green (${r.missing.length}): ${short(r.missing, 8)}`);
    if (r.g?.notes) for (const n of r.g.notes) console.log(`    note: ${n}`);
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

const promote = rows.filter((r) => r.surprise === "gap-closed");
if (promote.length) {
  console.log("\n=== gaps that appear to have CLOSED " + "=".repeat(33));
  console.log("    These are marked known-gap in queries.json but matched. Verify, then");
  console.log("    promote them to expect:\"parity\" so they can never silently reopen.");
  for (const r of promote) console.log(`    ${r.q.id}`);
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
  ORDER: "same rows, different order — ranking",
  "EXTRA+": "blue continued past green's list — expansion signature",
  EXTRA: "blue returned rows green did not — green over-filters",
  MISSING: "green returned rows blue did not — green under-filters",
  "SET-DIFF": "rows differ both ways — filters first, then ranking",
  "ERR-BLUE": "blue refused, green answered",
  "ERR-GREEN": "green failed, blue answered",
  COUNT: "ids agree, recorded count does not — capture bug",
  "NO-DATA": "a snapshot is missing this query",
};
for (const [cls, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cls.padEnd(10)} ${String(n).padStart(5)}   ${MEANING[cls] ?? ""}`);
}
console.log(
  `\n  ${rows.length} queries | ${rows.filter((r) => r.ok).length} matched | ` +
    `${regressions} regressions | ${gapFails} declared gaps still open`,
);

const fail = ALLOW_GAPS ? regressions > 0 : bad.length > 0;
if (fail) {
  console.log(
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
