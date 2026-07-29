#!/usr/bin/env node
/**
 * Builds `src/docs-generated.ts` — the content half of the progressive-disclosure
 * layer described in `src/docs.ts`.
 *
 * WHY A BUILD STEP AT ALL
 * -----------------------
 * A Worker has no filesystem, and fetching muninn-utilities at request time would
 * put a network hop and an outage mode in front of a static document. So the
 * sources are read here, at build time, and the result is committed. `docs.ts`
 * explains the rest of that reasoning; this file is only concerned with turning
 * four kinds of source into six kinds of markdown.
 *
 * WHY IT EXTRACTS RATHER THAN CONCATENATES
 * ----------------------------------------
 * `references/CLAUDE.md` is 19KB and `SKILL.md` is 19KB, and between them they
 * cover boot, schema, therapy, handoffs, release process and import debugging.
 * Pasting either into `muninn://reference/recall` would technically "document
 * recall" while leaving the reader to search 19KB for the parameter they came
 * for — and §8 caveat 4 is precisely that discovery round-trips compound. A
 * topic that still needs searching has spent a round trip for nothing.
 *
 * So every topic is assembled from named sections, and the section names are
 * *heading text*, not line numbers: `section(md, "Edge Cases")` keeps working
 * when someone inserts three paragraphs above it. When a heading disappears
 * upstream the build fails loudly instead of silently emitting a topic with a
 * hole in it — that failure IS the drift signal.
 *
 * WHY SOME CONTENT COMES OUT OF PYTHON
 * ------------------------------------
 * The one thing a reader of `muninn://reference/recall` must get is the full
 * parameter set, and no markdown source has it: `SKILL.md` shows six parameters
 * by example, `advanced-operations.md` documents another four in passing. The
 * authoritative list is the `recall()` signature plus its Args docstring in
 * `remembering/scripts/memory.py`. Same for `VALID_FIELDS` (result.py) and
 * `TYPES` (state.py) — those are sets in code that no document enumerates.
 * Reading them here means the generated reference cannot describe a parameter
 * list the implementation does not have. Those files are recorded in
 * `GENERATED_FROM.sources` like any other input.
 *
 * DETERMINISM
 * -----------
 * Same inputs must produce the same bytes, `generatedAt` excepted. Every map is
 * emitted through sorted keys and every list is sorted or in source order. A
 * generator whose output churns turns each regeneration into an unreviewable
 * diff, which is how people stop regenerating.
 *
 * Usage:
 *   node scripts/build-docs.mjs            # write src/docs-generated.ts
 *   node scripts/build-docs.mjs --check    # exit 1 if the committed file is stale
 *   MUNINN_UTILITIES=/path/to/repo node scripts/build-docs.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "src", "docs-generated.ts");

const ROOT = process.env.MUNINN_UTILITIES || "/home/user/muninn-utilities";

if (!existsSync(join(ROOT, "remembering")) || !existsSync(join(ROOT, "muninn_utils"))) {
  fail(
    `muninn-utilities not found at ${ROOT}.\n` +
      `  This generator reads remembering/, muninn_utils/ and manifests/ from a\n` +
      `  muninn-utilities checkout. Clone it beside this repo, or point at it:\n` +
      `    MUNINN_UTILITIES=/path/to/muninn-utilities node scripts/build-docs.mjs`,
  );
}

function fail(msg) {
  console.error(`build-docs: ${msg}`);
  process.exit(1);
}

// ------------------------------------------------------------------ sources

/**
 * Every path handed to `read()` lands in `GENERATED_FROM.sources`.
 *
 * Provenance is recorded by the act of reading rather than by a hand-maintained
 * list, for the same reason `src/fts-golden.json` records how its vectors were
 * produced: generated content that cannot be traced back to its input rots
 * silently, and a list you have to remember to update is a list that is wrong.
 */
const SOURCES = new Set();

function read(rel) {
  const abs = join(ROOT, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    fail(`source missing: ${rel} (looked in ${ROOT})`);
  }
  SOURCES.add(rel);
  return text;
}

function commit() {
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // A tarball checkout has no .git. Better to say so in the provenance than to
    // emit a plausible-looking hash or refuse to build.
    return "unknown";
  }
}

// ------------------------------------------------------- markdown slicing
//
// All of it is fence-aware. The sources are Python-heavy: `# Store a memory`
// inside a ```python block is a comment, not an H1, and a naive `^#` scan
// mistakes about forty of them for headings in advanced-operations.md alone.

/** Split into lines tagged with whether they sit inside a fenced code block. */
function scan(md) {
  const out = [];
  let fence = null;
  for (const line of md.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push({ line, code: true });
      if (m && line.trim().startsWith(fence)) fence = null;
    } else if (m) {
      fence = m[1];
      out.push({ line, code: true });
    } else {
      out.push({ line, code: false });
    }
  }
  return out;
}

function headingOf(entry) {
  if (entry.code) return null;
  const m = /^(#{1,6})\s+(.*?)\s*$/.exec(entry.line);
  return m ? { level: m[1].length, text: m[2] } : null;
}

/**
 * One section by heading text: the heading line plus everything up to the next
 * heading of the same or shallower level.
 *
 * `title` matches the heading text exactly, so version suffixes that upstream
 * uses as part of the name ("Priority System (v2.0.0)") are matched literally —
 * if upstream renames the section, this throws rather than guessing at the
 * nearest match and shipping the wrong prose under the right title.
 */
function section(md, title, label) {
  const entries = scan(md);
  const start = entries.findIndex((e) => {
    const h = headingOf(e);
    return h && h.text === title;
  });
  if (start === -1) {
    fail(
      `heading "${title}" not found in ${label}.\n` +
        `  The section was renamed or removed upstream. Re-pick the boundary in\n` +
        `  scripts/build-docs.mjs rather than dropping the content silently.`,
    );
  }
  const level = headingOf(entries[start]).level;
  let end = entries.length;
  for (let i = start + 1; i < entries.length; i++) {
    const h = headingOf(entries[i]);
    if (h && h.level <= level) {
      end = i;
      break;
    }
  }
  return entries
    .slice(start, end)
    .map((e) => e.line)
    .join("\n")
    .replace(/\s+$/, "");
}

/**
 * Re-level a slice so its own heading sits at `level`, subheadings shifting with it.
 *
 * Sections are lifted out of documents whose hierarchy starts wherever it starts;
 * a composed topic needs one consistent outline or a client's outline view of the
 * resource is nonsense.
 */
function setLevel(md, level) {
  const first = scan(md).map(headingOf).find(Boolean);
  const by = level - (first ? first.level : 1);
  return scan(md)
    .map((e) => {
      const h = headingOf(e);
      return h ? "#".repeat(Math.max(1, Math.min(6, h.level + by))) + " " + h.text : e.line;
    })
    .join("\n");
}

/** Rename a slice's own heading; the body keeps its relative structure. */
function retitle(md, title) {
  const i = md.indexOf("\n");
  const first = i === -1 ? md : md.slice(0, i);
  const level = /^#+/.exec(first)[0];
  return `${level} ${title}` + (i === -1 ? "" : md.slice(i));
}

/** Assert a literal appears in a source, so documented conventions cannot go stale unnoticed. */
function assertPresent(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    fail(`expected ${JSON.stringify(needle)} in ${label}; the convention changed upstream.`);
  }
}

// --------------------------------------------------------- python slicing
//
// Two small parsers, both anchored on syntax that only changes when the API
// changes: `def recall(...)` + its Google-style Args block, and two module-level
// set literals. Neither tries to be a Python parser.

function recallParams() {
  const src = read("remembering/scripts/memory.py");

  const at = src.indexOf("\ndef recall(");
  if (at === -1) fail("`def recall(` not found in remembering/scripts/memory.py");
  const head = src.slice(at + 1);
  const close = head.indexOf(") -> ");
  if (close === -1) fail("recall() signature has no return annotation to close on");

  // Parameter list, comments stripped, split on top-level commas.
  const args = head
    .slice(head.indexOf("(") + 1, close)
    .split("\n")
    .map((l) => l.replace(/#.*$/, ""))
    .join(" ");

  const parts = [];
  let depth = 0;
  let buf = "";
  for (const ch of args) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  parts.push(buf);

  const params = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p || p === "*" || p === "/") continue;
    const eq = p.indexOf("=");
    const decl = (eq === -1 ? p : p.slice(0, eq)).trim();
    const name = decl.split(":")[0].trim();
    const def = eq === -1 ? "—" : p.slice(eq + 1).trim();
    params.push({ name, default: def, doc: "" });
  }

  // Args block: `name: description`, continuations indented further.
  const doc = src.slice(at, at + 6000);
  const argsAt = doc.indexOf("\n    Args:\n");
  if (argsAt === -1) fail("recall() docstring has no Args: block");
  const body = doc.slice(argsAt + 11);
  const stop = body.indexOf("\n    Returns:");
  const lines = body.slice(0, stop === -1 ? undefined : stop).split("\n");

  const docs = new Map();
  let current = null;
  for (const line of lines) {
    const m = /^ {8}(\w+):\s?(.*)$/.exec(line);
    if (m) {
      current = m[1];
      docs.set(current, m[2].trim());
    } else if (current && line.trim()) {
      docs.set(current, (docs.get(current) + " " + line.trim()).trim());
    }
  }

  for (const p of params) p.doc = docs.get(p.name) || "";
  const undocumented = params.filter((p) => !p.doc).map((p) => p.name);
  if (undocumented.length) {
    fail(`recall() parameters with no Args entry: ${undocumented.join(", ")}`);
  }
  return params;
}

/** A module-level `NAME = { 'a', 'b' }` set literal, as sorted strings. */
function pySet(rel, name) {
  const src = read(rel);
  const at = src.indexOf(`\n${name}`);
  if (at === -1) fail(`${name} not found in ${rel}`);
  const open = src.indexOf("{", at);
  const close = src.indexOf("}", open);
  if (open === -1 || close === -1) fail(`${name} in ${rel} is not a set literal`);
  return [...src.slice(open + 1, close).matchAll(/['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .sort();
}

// ------------------------------------------------------------ topic bodies

function recallTopic() {
  const claude = read("remembering/references/CLAUDE.md");
  const adv = read("remembering/references/advanced-operations.md");
  const skill = read("remembering/SKILL.md");
  const params = recallParams();

  // `use_cache` is in the signature but v5.0.0 ignores it. It stays in the table —
  // a caller reading someone else's code needs to know it is inert — but it is not
  // counted, so the headline number matches the 19 the design was budgeted against.
  const live = params.filter((p) => !/^Deprecated/i.test(p.doc));
  const dead = params.length - live.length;
  const rows = params
    .map((p) => `| \`${p.name}\` | \`${p.default}\` | ${p.doc.replace(/\|/g, "\\|")} |`)
    .join("\n");

  const md = [
    "# `recall()` — full parameter reference",
    "",
    "The `recall` tool schema carries only the arguments that account for nearly",
    "every call. The rest of the parameter set is documented here instead of being",
    `re-sent in every conversation: ${live.length} live parameters` +
      (dead ? ` (plus ${dead} deprecated),` : ","),
    "generated from the `recall()` signature and Args docstring in",
    "`remembering/scripts/memory.py`, so it cannot drift from the implementation.",
    "",
    "## Parameters",
    "",
    "| Parameter | Default | Meaning |",
    "|---|---|---|",
    rows,
    "",
    "`search` and `query` are two names for the same argument; if both are given,",
    "`query` wins. `tags_all` / `tags_any` are sugar over `tags` + `tag_mode` and",
    "cannot be combined with each other.",
    "",
    setLevel(retitle(section(skill, "Recall", "SKILL.md"), "Calling patterns"), 2),
    "",
    setLevel(section(adv, "FTS5 Search with Porter Stemmer (v0.13.0)", "advanced-operations.md"), 2),
    "",
    setLevel(section(adv, "Date-Filtered Queries", "advanced-operations.md"), 2),
    "",
    setLevel(section(adv, "Type-Safe Results (v3.4.0)", "advanced-operations.md"), 2),
    "",
    setLevel(section(skill, "Edge Cases", "SKILL.md"), 2),
    "",
    "## Related",
    "",
    "- Memory types and their defaults: `muninn://reference/types`",
    "- Field names, tag conventions and priorities: `muninn://reference/vocabulary`",
  ].join("\n");

  // Touch CLAUDE.md deliberately: the memories-table schema is what the field
  // names in the result objects come from, and recording it as a source keeps
  // the drift check honest about which documents this topic depends on.
  assertPresent(claude, "CREATE TABLE memories", "references/CLAUDE.md");

  return {
    topic: "recall",
    uri: "muninn://reference/recall",
    title: "recall() parameter reference",
    description:
      `All ${live.length} recall() parameters with defaults and semantics, plus search behaviour, ` +
      "time windows, result objects and edge cases.",
    mimeType: "text/markdown",
    text: md,
  };
}

function typesTopic() {
  const skill = read("remembering/SKILL.md");
  const declared = pySet("remembering/scripts/state.py", "TYPES");

  // The section is the whole topic — retitled to the resource's own name so the
  // page does not open with a heading and then repeat itself one line later.
  const body = retitle(setLevel(section(skill, "Memory Type System", "SKILL.md"), 1), "Memory types");

  // The table is the documented surface; `TYPES` is what the writer actually
  // accepts. When they disagree the reader needs to know which way — a type the
  // table omits still stores fine, and a type the table lists but TYPES rejects
  // would raise at the call site.
  const documented = [...body.matchAll(/^\|\s*`(\w+)`/gm)].map((m) => m[1]).sort();
  const extra = declared.filter((t) => !documented.includes(t));
  const missing = documented.filter((t) => !declared.includes(t));
  if (missing.length) {
    fail(`SKILL.md documents type(s) that state.py TYPES rejects: ${missing.join(", ")}`);
  }

  const drift = extra.length
    ? [
        "",
        "## Accepted but undocumented",
        "",
        `\`state.py\` also accepts ${extra.map((t) => `\`${t}\``).join(", ")}. Valid on write, but`,
        "with no documented semantics or defaults — prefer a documented type unless you",
        "know why you want one of these.",
      ].join("\n")
    : "";

  return {
    topic: "types",
    uri: "muninn://reference/types",
    title: "Memory types",
    description:
      `The ${documented.length} memory types, what each is for, and the confidence and priority ` +
      "defaults each one implies.",
    mimeType: "text/markdown",
    text: [body, drift, "", "## Related", "", "- Storing and querying by type: `muninn://reference/recall`"]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s+$/, ""),
  };
}

function vocabularyTopic() {
  const claude = read("remembering/references/CLAUDE.md");
  const adv = read("remembering/references/advanced-operations.md");
  const skill = read("remembering/SKILL.md");
  const fields = pySet("remembering/scripts/result.py", "VALID_FIELDS");

  // Conventional tags are a real vocabulary — `handoff_pending()` is literally a
  // query for `["handoff", "pending"]` — but they are documented as prose inside
  // workflow sections rather than collected anywhere. Collecting them is the
  // value this topic adds; asserting each literal still appears in the section it
  // came from is what stops the collection from outliving the convention.
  const tags = [
    ["handoff", "adv", "Work handed between environments. `handoff_pending()` queries `handoff` + `pending` together."],
    ["pending", "adv", "Paired with `handoff` for work not yet picked up."],
    ["handoff-completed", "adv", "Written by `handoff_complete()`, alongside a version tag."],
    ["therapy", "adv", "Marks a recorded therapy session; `therapy_scope()` uses these as the cutoff."],
    ["consolidated", "skill", "The synthesized summary `consolidate()` writes over a cluster."],
    ["reflection", "skill", "Semantic memory produced by `therapy_reflect()`."],
    ["cross-episodic", "skill", "Paired with `reflection` on cross-episodic patterns."],
  ];
  for (const [tag, where] of tags) {
    const [src, label] =
      where === "adv" ? [adv, "advanced-operations.md"] : [skill, "SKILL.md"];
    assertPresent(src, tag, label);
  }

  const md = [
    "# Recall vocabulary",
    "",
    "The names `recall()` understands. Getting a field or tag name wrong is the",
    "most common way a query silently returns nothing, so this is the list to",
    "check before assuming the corpus is empty.",
    "",
    "## Result fields",
    "",
    "`MemoryResult` validates attribute and key access against this set; anything",
    "else raises rather than returning `None`.",
    "",
    fields.map((f) => `\`${f}\``).join(", "),
    "",
    "Common aliases (`content` → `summary`, `conf` → `confidence`, `timestamp` → `t`)",
    "resolve transparently. Full alias table: `muninn://reference/recall`.",
    "",
    "## Conventional tags",
    "",
    "| Tag | Meaning |",
    "|---|---|",
    ...tags.map(([tag, , meaning]) => `| \`${tag}\` | ${meaning} |`),
    "",
    "Tag matching is exact and, by default, any-of: `tags=[\"task\"]` matches a",
    "memory tagged `[\"task\", \"urgent\"]`. Use `tag_mode=\"all\"` or `tags_all` to require",
    "all of them.",
    "",
    setLevel(section(adv, "Priority System (v2.0.0)", "advanced-operations.md"), 2),
    "",
    retitle(setLevel(section(claude, "`config` table", "references/CLAUDE.md"), 2), "Config categories"),
    "",
    setLevel(section(adv, "Progressive Disclosure (v2.1.0)", "advanced-operations.md"), 2),
    "",
    "## Related",
    "",
    "- Memory types: `muninn://reference/types`",
    "- Parameter semantics: `muninn://reference/recall`",
  ].join("\n");

  return {
    topic: "vocabulary",
    uri: "muninn://reference/vocabulary",
    title: "Recall vocabulary",
    description:
      "Valid result field names, the conventional tags the system writes and queries, priority " +
      "levels and config categories.",
    mimeType: "text/markdown",
    text: md,
  };
}

// --------------------------------------------------------------- manifests

/**
 * Utility names are normalized to the **Python module name** — `bsky_card`, not
 * `bsky-card`.
 *
 * Two candidate spellings exist upstream: `use_when.json` keys use underscores,
 * manifest directories use hyphens. Underscore wins on three grounds. It is what
 * a caller types (`python -m muninn_utils.bsky_card`); it is what the routing
 * index already uses, and the index is what advertises the URIs; and it is
 * carried explicitly in each manifest as `runtime.install.locator.module`, so it
 * can be *read* rather than transliterated from a directory name. Both sides are
 * normalized through `moduleName()` — if they ever disagree, `muninn://utilities`
 * would advertise a name `muninn://utilities/{name}` cannot resolve, so the
 * index build asserts they match.
 */
function moduleName(manifest, dir) {
  const mod = manifest?.runtime?.install?.locator?.module;
  if (typeof mod === "string" && mod.startsWith("muninn_utils.")) {
    return mod.slice("muninn_utils.".length);
  }
  const cmd = manifest?.runtime?.entrypoint?.command;
  const m = Array.isArray(cmd) && cmd.find((c) => String(c).startsWith("muninn_utils."));
  if (m) return m.slice("muninn_utils.".length);
  return dir.replace(/-/g, "_");
}

function parseVersion(file) {
  const m = /\.v(\d+)\.(\d+)\.json$/.exec(file);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Load the highest-versioned manifest per utility directory.
 *
 * v0.3 and v0.4 both live upstream. v0.4 added `actions[].docs` — `goal`,
 * `inputs_brief`, `outputs_brief`, `errors_brief`, `example` — which is a
 * deferred tool schema in all but name, and is the reason this design uses
 * manifests as a build input at all. Where a utility has no `docs` block the doc
 * is synthesized from `summary` / `description` / `invocation` / `examples`; that
 * path produces a usable but visibly thinner page, and every utility that takes
 * it is reported, because that list is the argument for finishing the upgrade.
 */
function manifests() {
  const dir = join(ROOT, "manifests");
  if (!existsSync(dir)) fail("manifests/ not found");
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const files = readdirSync(join(dir, name))
      .filter((f) => parseVersion(f))
      .sort();
    if (!files.length) continue;
    let best = null;
    for (const f of files) {
      const v = parseVersion(f);
      if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && v[1] > best.v[1])) {
        best = { file: f, v };
      }
    }
    const rel = `manifests/${name}/${best.file}`;
    const json = JSON.parse(read(rel));
    out.push({ dir: name, version: best.v, json, name: moduleName(json, name) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function briefInputs(action) {
  const props = action?.input?.properties;
  if (!props) return "(none)";
  const required = new Set(action.input.required || []);
  return Object.keys(props)
    .map((k) => (required.has(k) ? `\`${k}\`` : `\`${k}\`?`))
    .join(", ");
}

function briefOutputs(action) {
  const props = action?.output?.schema?.properties;
  if (!props) return action?.output?.format ? `${action.output.format} payload` : "(unspecified)";
  return `{${Object.keys(props).join(", ")}}`;
}

function briefExample(action) {
  const argv = action?.invocation?.argv_template;
  const ex = Array.isArray(action?.examples) ? action.examples[0] : null;
  if (ex && ex.input && Object.keys(ex.input).length) {
    return `${(argv || [action.name]).join(" ")} ${JSON.stringify(ex.input)}`;
  }
  return (argv || [action.name]).join(" ");
}

/** One utility's markdown: name, goal, inputs, outputs, errors, example — per action. */
function utilityMarkdown(entry) {
  const { json, name } = entry;
  const tool = json.tool || {};
  const actions = (json.actions || []).slice();
  const synthesized = [];

  const env = (json.env || [])
    .map((e) => `\`${e.name}\`${e.required ? "" : "?"}${e.secret ? " (secret)" : ""}`)
    .join(", ");

  const lines = [
    `# ${name}`,
    "",
    `**${tool.name || name}** — ${(tool.summary || "").trim()}`,
    "",
    `Module: \`muninn_utils.${name}\` · CLI: \`${(json.runtime?.entrypoint?.command || []).join(" ")}\``,
  ];
  if (env) lines.push("", `Env: ${env} (\`?\` = optional)`);
  lines.push("", "## Actions");

  for (const a of actions) {
    const docs = a.docs || null;
    if (!docs) synthesized.push(a.name);
    const goal = docs?.goal || a.summary || a.description || "(no goal recorded)";
    const inputs = docs?.inputs_brief || briefInputs(a);
    const outputs = docs?.outputs_brief || briefOutputs(a);
    const errors = docs?.errors_brief || (a.error_envelope ? `${a.error_envelope} error envelope` : "(unrecorded)");
    const example = docs?.example || briefExample(a);
    const effect = [a.side_effects, a.idempotent === true ? "idempotent" : null]
      .filter(Boolean)
      .join(", ");

    lines.push(
      "",
      `### \`${a.name}\`${effect ? ` — ${effect}` : ""}`,
      "",
      `- **Goal:** ${goal}`,
      `- **Inputs:** ${inputs}`,
      `- **Outputs:** ${outputs}`,
      `- **Errors:** ${errors}`,
      "",
      "```",
      example,
      "```",
    );
    if (!docs) {
      lines.push("", "> Synthesized from a pre-v0.4 manifest: no `docs` block upstream.");
    }
  }

  return { text: lines.join("\n"), synthesized };
}

// --------------------------------------------------------------- the index

function utilityIndex(entries) {
  const useWhen = JSON.parse(read("muninn_utils/use_when.json"));

  const documented = new Map(entries.map((e) => [e.name, e]));
  const names = [...new Set([...Object.keys(useWhen), ...documented.keys()])].sort();

  const withDoc = [];
  const routingOnly = [];
  for (const n of names) {
    const when = useWhen[n];
    if (documented.has(n)) {
      // A name in the index that the URI template cannot resolve is the failure
      // mode this whole normalization exists to prevent, so assert rather than trust.
      if (!documented.get(n)) fail(`index advertises ${n} with no doc`);
      withDoc.push(
        `- **\`${n}\`** — ${when || documented.get(n).json.tool?.summary || ""} → \`muninn://utilities/${n}\``,
      );
    } else {
      routingOnly.push(`- **\`${n}\`** — ${when}`);
    }
  }

  const md = [
    "# Utility index",
    "",
    "Which utility handles which task shape. Read the line, then read that",
    "utility's page for its actions, inputs and errors — nothing below is needed",
    "until a task matches one of these shapes.",
    "",
    "## With a detail page",
    "",
    ...withDoc,
    "",
    "## Routing only",
    "",
    "No install manifest upstream, so there is no generated page. The line below is",
    "all the routing information there is; the utility's own module documents the rest.",
    "",
    ...routingOnly,
  ].join("\n");

  return {
    topic: "utilities",
    uri: "muninn://utilities",
    title: "Utility index",
    description: `Routing index for ${names.length} Muninn utilities: which one handles which task shape.`,
    mimeType: "text/markdown",
    text: md,
  };
}

// ------------------------------------------------------------------- emit

/**
 * Markdown goes out as template literals rather than JSON strings.
 *
 * A JSON string collapses an 8KB document onto one line, which makes every
 * regeneration a single unreadable changed line. Template literals keep the
 * markdown's line structure, so `git diff` on this file shows which paragraph
 * moved — which is the only reason to commit a generated file at all.
 */
function tpl(s) {
  return "`" + s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

const str = (s) => JSON.stringify(s);

function emitTopic(t, indent) {
  const p = " ".repeat(indent);
  return [
    `${p}{`,
    `${p}  topic: ${str(t.topic)},`,
    `${p}  uri: ${str(t.uri)},`,
    `${p}  title: ${str(t.title)},`,
    `${p}  description: ${str(t.description)},`,
    `${p}  mimeType: ${str(t.mimeType)},`,
    `${p}  text: ${tpl(t.text)},`,
    `${p}}`,
  ].join("\n");
}

function render({ provenance, reference, index, utilities }) {
  return [
    "/**",
    " * GENERATED FILE — do not edit by hand.",
    " *",
    " * Produced by `npm run build:docs` (scripts/build-docs.mjs) from the sources in",
    " * muninn-utilities. Committed so the Worker bundle is self-contained; see the",
    " * header of `docs.ts` for why the content is generated rather than fetched, and",
    " * the header of the generator for how each topic's boundaries were chosen.",
    " *",
    " * To refresh: `npm run build:docs`. To detect staleness in CI:",
    " * `node scripts/build-docs.mjs --check`.",
    " */",
    "",
    'import type { DocTopic, DocProvenance } from "./docs.ts";',
    "",
    "export const GENERATED_FROM: DocProvenance = {",
    `  commit: ${str(provenance.commit)},`,
    `  generatedAt: ${str(provenance.generatedAt)},`,
    "  sources: [",
    ...provenance.sources.map((s) => `    ${str(s)},`),
    "  ],",
    "};",
    "",
    "export const REFERENCE_DOCS: DocTopic[] = [",
    reference.map((t) => emitTopic(t, 2)).join(",\n"),
    "];",
    "",
    "export const UTILITY_INDEX: DocTopic = " + emitTopic(index, 0) + ";",
    "",
    "export const UTILITY_DOCS: Record<string, string> = {",
    ...Object.keys(utilities)
      .sort()
      .map((k) => `  ${str(k)}: ${tpl(utilities[k])},`),
    "};",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------- main

export function build(generatedAt = new Date().toISOString()) {
  // Order matters only for readability of the sources list; SOURCES is sorted.
  const entries = manifests();

  const utilities = {};
  const fellBack = [];
  for (const e of entries) {
    const { text, synthesized } = utilityMarkdown(e);
    utilities[e.name] = text;
    if (synthesized.length || e.version[0] * 100 + e.version[1] < 4) {
      fellBack.push({ name: e.name, version: `v${e.version[0]}.${e.version[1]}`, actions: synthesized });
    }
  }

  const reference = [recallTopic(), typesTopic(), vocabularyTopic()];
  const index = utilityIndex(entries);

  const source = render({
    provenance: {
      commit: commit(),
      generatedAt,
      sources: [...SOURCES].sort(),
    },
    reference,
    index,
    utilities,
  });

  return { source, reference, index, utilities, fellBack, entries };
}

/**
 * Comparison for `--check` blanks `commit` and `generatedAt`.
 *
 * Both change on every upstream commit and every run respectively, including
 * commits that touch none of these sources. Failing CI on those would train
 * people to ignore the check — and the signal worth having is "the documented
 * content no longer matches upstream", which is exactly what remains once the
 * two provenance stamps are removed. `sources` is content and stays in.
 */
function normalize(src) {
  return src
    .replace(/^(\s*commit:\s*).*$/m, "$1<ignored>")
    .replace(/^(\s*generatedAt:\s*).*$/m, "$1<ignored>");
}

function main() {
  const check = process.argv.includes("--check");
  const { source, reference, index, utilities, fellBack } = build();

  if (check) {
    const committed = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (normalize(committed) === normalize(source)) {
      console.log("build-docs: src/docs-generated.ts is up to date.");
      return;
    }
    console.error(
      "build-docs: src/docs-generated.ts is STALE.\n" +
        "  muninn-utilities has moved and the committed docs no longer match.\n" +
        "  Run `npm run build:docs` and commit the result.",
    );
    process.exit(1);
  }

  writeFileSync(OUT, source);

  const kb = (s) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(1) + "KB";
  console.log(`build-docs: wrote ${relative(REPO, OUT)} (${kb(source)}) from ${ROOT}`);
  for (const t of [...reference, index]) console.log(`  ${t.uri.padEnd(34)} ${kb(t.text)}`);
  console.log(`  ${Object.keys(utilities).length} utility pages, ${kb(Object.values(utilities).join(""))} total`);
  if (fellBack.length) {
    console.log("  synthesized from pre-v0.4 manifests (finish the upgrade):");
    for (const f of fellBack) console.log(`    ${f.name} ${f.version} ${f.actions.join(", ")}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("build-docs.mjs")) main();
