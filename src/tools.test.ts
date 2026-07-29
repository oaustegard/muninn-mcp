/** Coverage for formatting and dispatch, with Turso injected. */
import { formatRecall, relativeAge, recall, type Deps } from "./tools.ts";

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
  db: () => ({ execute: async (q: Record<string, unknown>) => { captured = q; return { rows: [] }; } }) as never,
};
await recall({ TURSO_URL: "x", TURSO_TOKEN: "y" }, { query: "z", n: 999 }, capture);
eq("n is capped at 50", (captured.args as unknown[])[(captured.args as unknown[]).length - 1], 50);
await recall({ TURSO_URL: "x", TURSO_TOKEN: "y" }, { query: "z", n: 0 }, capture);
eq("n floors at 1 rather than 0", (captured.args as unknown[])[(captured.args as unknown[]).length - 1], 10);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
