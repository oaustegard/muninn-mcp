/**
 * Coverage for the doc generator, in the repo's hand-rolled style.
 *
 * What is worth testing here is not "does markdown come out" — the eye does that
 * better — but the three properties that fail silently:
 *
 *   1. The index and the URI template agree on every name. If they drift,
 *      `muninn://utilities` advertises resources `resources/read` answers -32602
 *      on, and nothing in the type system notices.
 *   2. Topics are extracts, not dumps. A regression here looks like success:
 *      the resource still resolves, it is just 19KB of the wrong thing.
 *   3. Output is deterministic. A generator that churns stops being run.
 *
 * Requires a muninn-utilities checkout (MUNINN_UTILITIES, default
 * /home/user/muninn-utilities) for the same reason the generator does.
 */

import { build } from "./build-docs.mjs";

let pass = 0, fail = 0;
const eq = (n, g, w) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));
const ok = (n, cond, detail = "") =>
  cond ? (pass++, console.log("OK  " + n)) : (fail++, console.log(`FAIL ${n}${detail ? "\n  " + detail : ""}`));

const AT = "2026-01-01T00:00:00Z";
const b = build(AT);
const bytes = (s) => Buffer.byteLength(s, "utf8");

// ------------------------------------------------------- shape of the module

eq("three reference topics", b.reference.map((t) => t.topic), ["recall", "types", "vocabulary"]);
eq("index topic", [b.index.topic, b.index.uri], ["utilities", "muninn://utilities"]);

for (const t of [...b.reference, b.index]) {
  ok(`${t.topic}: has a title and a one-line description`,
     t.title.length > 0 && t.description.length > 20 && !t.description.includes("\n"));
  eq(`${t.topic}: mimeType`, t.mimeType, "text/markdown");
  ok(`${t.topic}: opens with an H1`, /^# \S/.test(t.text), t.text.slice(0, 40));
}

// ---------------------------------------------------- names agree both sides
//
// The naming decision is underscore (Python module name). Both the index bullets
// and the UTILITY_DOCS keys are normalized through moduleName(), so this asserts
// the normalization actually held rather than assuming it.

const advertised = [...b.index.text.matchAll(/muninn:\/\/utilities\/([\w-]+)/g)].map((m) => m[1]).sort();
const resolvable = Object.keys(b.utilities).sort();
eq("every advertised utility resolves", advertised, resolvable);
ok("no hyphenated names leaked from manifest directories",
   resolvable.every((n) => !n.includes("-")), resolvable.filter((n) => n.includes("-")).join(", "));
ok("routing-only utilities are listed but not advertised",
   /## Routing only/.test(b.index.text) && b.index.text.includes("`flowing`") &&
   !b.index.text.includes("muninn://utilities/flowing"));

// -------------------------------------------------------- extraction, not dump
//
// Upper bounds are deliberately generous: the point is to catch a slicer that
// silently degrades into "read the whole file", not to police prose length.

for (const t of b.reference) {
  ok(`${t.topic} is an extract (${(bytes(t.text) / 1024).toFixed(1)}KB < 12KB)`, bytes(t.text) < 12 * 1024);
}

// The recall topic's reason to exist: all 19 live parameters, in one table.
const params = [
  "search", "query", "n", "tags", "type", "conf", "tag_mode", "strict", "session_id",
  "auto_strengthen", "raw", "expansion_threshold", "fetch_all", "since", "until",
  "tags_all", "tags_any", "episodic", "exploration",
];
const recall = b.reference.find((t) => t.topic === "recall");
const missing = params.filter((p) => !recall.text.includes(`| \`${p}\` |`));
eq("recall documents every parameter", missing, []);
ok("recall carries none of SKILL.md's unrelated sections",
   !/Handoff|Therapy|Export\/Import|Boot Sequence/.test(recall.text));

const types = b.reference.find((t) => t.topic === "types");
ok("types has the type table", /\| `procedure` \|/.test(types.text) && /\| `analysis` \|/.test(types.text));

const vocab = b.reference.find((t) => t.topic === "vocabulary");
ok("vocabulary lists result fields", vocab.text.includes("`summary_preview`"));
ok("vocabulary lists conventional tags", vocab.text.includes("`handoff-completed`"));

// ------------------------------------------------------------- utility pages

ok("every utility page has goal/inputs/outputs/errors",
   Object.values(b.utilities).every((t) =>
     t.includes("**Goal:**") && t.includes("**Inputs:**") &&
     t.includes("**Outputs:**") && t.includes("**Errors:**")));
ok("utility pages stay compact (max < 4KB)",
   Math.max(...Object.values(b.utilities).map(bytes)) < 4096);

// ------------------------------------------------------------- provenance

ok("provenance names the sources actually read", b.source.includes('"muninn_utils/use_when.json"'));
ok("provenance records the python inputs", b.source.includes('"remembering/scripts/memory.py"'));
ok("generatedAt is threaded through", b.source.includes(AT));

// ------------------------------------------------------------- determinism

eq("same inputs, same bytes", build(AT).source === b.source, true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
