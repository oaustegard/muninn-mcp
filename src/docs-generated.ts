/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by `npm run build:docs` (scripts/build-docs.mjs) from the sources in
 * muninn-utilities. Committed so the Worker bundle is self-contained; see the
 * header of `docs.ts` for why the content is generated rather than fetched, and
 * the header of the generator for how each topic's boundaries were chosen.
 *
 * To refresh: `npm run build:docs`. To detect staleness in CI:
 * `node scripts/build-docs.mjs --check`.
 */

import type { DocTopic, DocProvenance } from "./docs.ts";

export const GENERATED_FROM: DocProvenance = {
  commit: "64fefda379018c073e378bd6be50d289655a45f1",
  generatedAt: "2026-07-29T01:57:36.173Z",
  sources: [
    "manifests/blog-publish/muninn-blog-publish.v0.4.json",
    "manifests/boot-ledger/muninn-boot-ledger.v0.4.json",
    "manifests/bsky-card/muninn-bsky-card.v0.4.json",
    "manifests/bsky-limit/muninn-bsky-limit.v0.4.json",
    "manifests/correction-gate/muninn-correction-gate.v0.4.json",
    "manifests/issue-close/muninn-issue-close.v0.4.json",
    "manifests/memory-tfidf/muninn-memory-tfidf.v0.4.json",
    "manifests/news-watch/muninn-news-watch.v0.4.json",
    "manifests/perch-publish/muninn-perch-publish.v0.4.json",
    "manifests/perch-triage/muninn-perch-triage.v0.4.json",
    "manifests/recall-sufficiency/muninn-recall-sufficiency.v0.4.json",
    "manifests/remind/muninn-remind.v0.4.json",
    "manifests/satisfaction-skew/muninn-satisfaction-skew.v0.4.json",
    "manifests/task-policy/muninn-task-policy.v0.4.json",
    "manifests/verify-patch/muninn-verify-patch.v0.4.json",
    "manifests/whtwnd/muninn-whtwnd.v0.4.json",
    "manifests/zeitgeist-delta/muninn-zeitgeist-delta.v0.4.json",
    "muninn_utils/use_when.json",
    "remembering/SKILL.md",
    "remembering/references/CLAUDE.md",
    "remembering/references/advanced-operations.md",
    "remembering/scripts/memory.py",
    "remembering/scripts/result.py",
    "remembering/scripts/state.py",
  ],
};

export const REFERENCE_DOCS: DocTopic[] = [
  {
    topic: "recall",
    uri: "muninn://reference/recall",
    title: "recall() parameter reference",
    description: "All 19 recall() parameters with defaults and semantics, plus search behaviour, time windows, result objects and edge cases.",
    mimeType: "text/markdown",
    text: `# \`recall()\` — full parameter reference

The \`recall\` tool schema carries only the arguments that account for nearly
every call. The rest of the parameter set is documented here instead of being
re-sent in every conversation: 19 live parameters (plus 1 deprecated),
generated from the \`recall()\` signature and Args docstring in
\`remembering/scripts/memory.py\`, so it cannot drift from the implementation.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| \`search\` | \`None\` | Text to search for in memory summaries (FTS5 ranked search). Note: Wildcards like '*' are treated as literal text, not patterns. Use fetch_all=True for comprehensive retrieval instead. |
| \`query\` | \`None\` | Alias for search. Both names accepted as first-class. If both are provided, query wins. |
| \`n\` | \`10\` | Max number of results |
| \`tags\` | \`None\` | Filter by tags |
| \`type\` | \`None\` | Filter by memory type |
| \`conf\` | \`None\` | Minimum confidence threshold |
| \`tag_mode\` | \`"any"\` | "any" (default) matches any tag, "all" requires all tags |
| \`strict\` | \`False\` | If True, skip FTS5/ranking and order by timestamp DESC |
| \`session_id\` | \`None\` | Filter by session identifier (optional) |
| \`auto_strengthen\` | \`False\` | If True, automatically strengthen top 3 results |
| \`raw\` | \`False\` | If True, return plain dicts instead of MemoryResult objects |
| \`expansion_threshold\` | \`3\` | Minimum results before triggering query expansion (default 3). Set to 0 to disable expansion entirely. |
| \`fetch_all\` | \`False\` | If True, retrieve all memories without search filtering. When True, the search parameter is ignored. |
| \`since\` | \`None\` | Filter memories created at or after this ISO timestamp. |
| \`until\` | \`None\` | Filter memories created at or before this ISO timestamp. |
| \`tags_all\` | \`None\` | Convenience parameter requiring ALL specified tags. Cannot be combined with tags_any. |
| \`tags_any\` | \`None\` | Convenience parameter requiring ANY of the specified tags. Cannot be combined with tags_all. |
| \`episodic\` | \`False\` | If True, include access-pattern boosting in ranking (#296). Frequently accessed memories get a logarithmic boost, rewarding validated-useful memories over unaccessed ones. |
| \`exploration\` | \`False\` | If True, apply exploration boost favoring rarely-accessed memories (#paper-MIA). Adds 1/(1+access_count) bonus to ranking, preventing heavily-accessed memories from monopolizing results. Mutually exclusive with episodic (exploration wins if both set). |
| \`use_cache\` | \`True\` | Deprecated (v5.0.0). Ignored - all queries go to Turso. |

\`search\` and \`query\` are two names for the same argument; if both are given,
\`query\` wins. \`tags_all\` / \`tags_any\` are sugar over \`tags\` + \`tag_mode\` and
cannot be combined with each other.

## Calling patterns

\`\`\`python
from scripts import recall

# FTS5 search with BM25 ranking + Porter stemmer
memories = recall("dark mode")

# Filtered queries
decisions = recall(type="decision", conf=0.85, n=20)
tasks = recall("API", tags=["task"], n=15)
urgent = recall(tags=["task", "urgent"], tag_mode="all", n=10)

# Comprehensive retrieval (v4.1.0)
all_memories = recall(fetch_all=True, n=1000)  # Get all memories without search filtering

# Time-windowed queries (v4.3.0) - since/until with inclusive bounds
recent = recall("API", since="2025-02-01")
jan_memories = recall(since="2025-01-01", until="2025-01-31T23:59:59Z")

# Multi-tag convenience (v4.3.0)
both = recall(tags_all=["correction", "bsky"])    # AND: must have all tags
either = recall(tags_any=["therapy", "self-improvement"])  # OR: any tag matches

# Wildcard patterns are NOT supported - use fetch_all instead
# recall("*", n=1000)  # ❌ Raises ValueError
# recall(fetch_all=True, n=1000)  # ✅ Correct approach
\`\`\`

Results return as \`MemoryResult\` objects with attribute and dict access. Common aliases (\`m.content\` -> \`m.summary\`, \`m.conf\` -> \`m.confidence\`) resolve transparently.

## FTS5 Search with Porter Stemmer (v0.13.0)

Full-text search uses FTS5 with Porter stemmer for morphological variant matching:

\`\`\`python
from scripts import recall

# Searches match word variants automatically
# "running" matches "run", "runs", "runner"
results = recall("running performance")

# v3.7.0: Configurable expansion threshold
results = recall("term", expansion_threshold=5)  # Expand if < 5 results
results = recall("term", expansion_threshold=0)  # Disable expansion entirely
\`\`\`

**How it works:**
- FTS5 tokenizer: \`porter unicode61\` handles stemming
- BM25 ranking for relevance scoring
- Query expansion extracts tags from partial results when below threshold (default 3)
- Composite ranking: BM25 x salience x recency x access patterns

## Date-Filtered Queries

Query memories by temporal range:

\`\`\`python
from scripts import recall_since, recall_between

# Get memories after a specific timestamp
recent = recall_since("2025-12-01T00:00:00Z", n=50)
recent_bugs = recall_since("2025-12-20T00:00:00Z", type="anomaly", tags=["critical"])

# Get memories within a time range
december = recall_between("2025-12-01T00:00:00Z", "2025-12-31T23:59:59Z", n=100)
\`\`\`

**Notes:**
- Timestamps are exclusive (use \`>\` and \`<\` not \`>=\` and \`<=\`)
- Supports all standard filters: \`search\`, \`type\`, \`tags\`, \`tag_mode\`
- Sorted by timestamp descending (newest first)

## Type-Safe Results (v3.4.0)

\`recall()\`, \`recall_since()\`, and \`recall_between()\` return \`MemoryResult\` objects that validate field access:

\`\`\`python
from scripts import recall, MemoryResult, VALID_FIELDS

memories = recall("search term", n=10)

for m in memories:
    print(m.summary)      # Attribute-style
    print(m['summary'])   # Dict-style
    print(m.get('summary', 'default'))  # get() with default

    # v3.7.0: Common aliases resolve transparently
    print(m.content)      # Resolves to m.summary
    print(m.conf)         # Resolves to m.confidence

    # Truly invalid fields still raise errors
    print(m.foo)          # AttributeError with list of valid fields
\`\`\`

**Transparent aliases (v3.7.0):**
| Alias | Resolves To |
|-------|-------------|
| \`m.content\` | \`m.summary\` |
| \`m['text']\` | \`m['summary']\` |
| \`m.conf\` | \`m.confidence\` |
| \`m.timestamp\` | \`m.t\` |
| \`m.created\` | \`m.created_at\` |

**Backward compatibility:**
- MemoryResult supports all dict operations: \`in\`, \`len()\`, iteration, \`keys()\`, \`values()\`, \`items()\`
- Use \`m.to_dict()\` to convert back to plain dict when needed
- Use \`raw=True\` parameter to get plain dicts: \`recall("term", raw=True)\`

## Edge Cases

- **Empty recall results:** Returns \`MemoryResultList([])\`, not an error
- **Tag partial matching:** \`tags=["task"]\` matches memories with tags \`["task", "urgent"]\`
- **Confidence defaults:** \`decision\` type defaults to 0.8 if not specified
- **Invalid type:** Raises \`ValueError\` with list of valid types
- **Tag mode:** \`tag_mode="all"\` requires all tags present; \`tag_mode="any"\` (default) matches any
- **Query expansion:** When FTS5 returns fewer than \`expansion_threshold\` results (default 3), tags from partial matches find related memories. Set \`expansion_threshold=0\` to disable.

## Related

- Memory types and their defaults: \`muninn://reference/types\`
- Field names, tag conventions and priorities: \`muninn://reference/vocabulary\``,
  },
  {
    topic: "types",
    uri: "muninn://reference/types",
    title: "Memory types",
    description: "The 6 memory types, what each is for, and the confidence and priority defaults each one implies.",
    mimeType: "text/markdown",
    text: `# Memory types

**Type is required** on all write operations. Valid types:

| Type | Use For | Defaults |
|------|---------|----------|
| \`decision\` | Explicit choices: prefers X, always/never do Y | conf=0.8 |
| \`world\` | External facts: tasks, deadlines, project state | |
| \`anomaly\` | Errors, bugs, unexpected behavior | |
| \`experience\` | General observations, catch-all | |
| \`procedure\` | Workflows, step-by-step processes, decision trees | conf=0.9, priority=1 |
| \`analysis\` | Findings from structured analysis or research | |

\`\`\`python
from scripts import TYPES  # {'decision', 'world', 'anomaly', 'experience', 'procedure', 'analysis', ...}
\`\`\`

## Procedural Memories (v4.4.0)

Store reusable workflows and operational patterns as first-class memories:

\`\`\`python
from scripts import remember

# Store a workflow
id = remember(
    "Deploy workflow: 1) Run tests 2) Build artifacts 3) Push to staging 4) Smoke test 5) Promote to prod",
    "procedure",
    tags=["deployment", "workflow"],
)

# Retrieve workflows
procedures = recall(type="procedure", tags=["deployment"])
\`\`\`

Procedural memories default to \`confidence=0.9\` and \`priority=1\` (important), ensuring they survive age-based pruning. Use tags to categorize by domain and workflow name for targeted retrieval.

## Accepted but undocumented

\`state.py\` also accepts \`interaction\`. Valid on write, but
with no documented semantics or defaults — prefer a documented type unless you
know why you want one of these.

## Related

- Storing and querying by type: \`muninn://reference/recall\``,
  },
  {
    topic: "vocabulary",
    uri: "muninn://reference/vocabulary",
    title: "Recall vocabulary",
    description: "Valid result field names, the conventional tags the system writes and queries, priority levels and config categories.",
    mimeType: "text/markdown",
    text: `# Recall vocabulary

The names \`recall()\` understands. Getting a field or tag name wrong is the
most common way a query silently returns nothing, so this is the list to
check before assuming the corpus is empty.

## Result fields

\`MemoryResult\` validates attribute and key access against this set; anything
else raises rather than returning \`None\`.

\`access_count\`, \`alternatives\`, \`bm25_score\`, \`composite_rank\`, \`composite_score\`, \`confidence\`, \`created_at\`, \`deleted_at\`, \`has_full\`, \`id\`, \`last_accessed\`, \`priority\`, \`refs\`, \`relative_age\`, \`session_id\`, \`summary\`, \`summary_preview\`, \`t\`, \`tags\`, \`type\`, \`updated_at\`, \`valid_from\`

Common aliases (\`content\` → \`summary\`, \`conf\` → \`confidence\`, \`timestamp\` → \`t\`)
resolve transparently. Full alias table: \`muninn://reference/recall\`.

## Conventional tags

| Tag | Meaning |
|---|---|
| \`handoff\` | Work handed between environments. \`handoff_pending()\` queries \`handoff\` + \`pending\` together. |
| \`pending\` | Paired with \`handoff\` for work not yet picked up. |
| \`handoff-completed\` | Written by \`handoff_complete()\`, alongside a version tag. |
| \`therapy\` | Marks a recorded therapy session; \`therapy_scope()\` uses these as the cutoff. |
| \`consolidated\` | The synthesized summary \`consolidate()\` writes over a cluster. |
| \`reflection\` | Semantic memory produced by \`therapy_reflect()\`. |
| \`cross-episodic\` | Paired with \`reflection\` on cross-episodic patterns. |

Tag matching is exact and, by default, any-of: \`tags=["task"]\` matches a
memory tagged \`["task", "urgent"]\`. Use \`tag_mode="all"\` or \`tags_all\` to require
all of them.

## Priority System (v2.0.0)

Memories have a priority field that affects ranking in search results:

| Priority | Value | Description |
|----------|-------|-------------|
| Background | -1 | Low-value, can age out first |
| Normal | 0 | Default for new memories |
| Important | 1 | Boosted in ranking |
| Critical | 2 | Always surface, never auto-age |

\`\`\`python
from scripts import remember, reprioritize

# Set priority at creation
remember("Critical security finding", "anomaly", tags=["security"], priority=2)

# Adjust priority later
reprioritize("memory-uuid", priority=1)  # Upgrade to important
\`\`\`

**Ranking formula:**
\`\`\`
score = bm25_score * recency_weight * (1 + priority * 0.5)
\`\`\`

### Memory Consolidation (v3.3.0)

Biological memory consolidation pattern: memories that participate in active cognition consolidate more strongly.

\`\`\`python
from scripts import strengthen, weaken, recall

# Strengthen a memory (increment priority, max 2)
result = strengthen("memory-uuid", boost=1)

# Weaken a memory (decrement priority, min -1)
result = weaken("memory-uuid", drop=1)

# Auto-strengthen top results during recall (opt-in)
results = recall("important topic", auto_strengthen=True, n=10)
\`\`\`

## Config categories
Boot-time context loaded at conversation start.

\`\`\`sql
CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value TEXT,
    category TEXT,  -- 'profile', 'ops', or 'journal'
    updated_at TEXT
);
\`\`\`

Categories:
- \`profile\`: Identity and behavior (who is Muninn, memory rules)
- \`ops\`: Operational guidance (API reference, skill delivery rules)
- \`journal\`: Session summaries for cross-conversation context

## Progressive Disclosure (v2.1.0)

Ops entries can be marked as **boot-loaded** (default) or **reference-only** to reduce boot() output size:

\`\`\`python
from scripts import config_set_boot_load, ops

# Mark entry as reference-only (won't load at boot)
config_set_boot_load('github-api-endpoints', False)
config_set_boot_load('container-limits', False)

# Mark entry as boot-loaded (loads at boot)
config_set_boot_load('storage-discipline', True)

# Query ops with filtering
boot_ops = ops()                          # Only boot-loaded entries (default)
all_ops = ops(include_reference=True)     # All entries (boot + reference)
\`\`\`

**How it works:**
- \`boot()\` outputs only ops with \`boot_load=1\` (reduces token usage at boot)
- Reference-only ops (\`boot_load=0\`) appear in a **Reference Entries** index at the end of boot output
- Reference entries remain fully accessible via \`config_get(key)\` when needed

## Related

- Memory types: \`muninn://reference/types\`
- Parameter semantics: \`muninn://reference/recall\``,
  }
];

export const UTILITY_INDEX: DocTopic = {
  topic: "utilities",
  uri: "muninn://utilities",
  title: "Utility index",
  description: "Routing index for 21 Muninn utilities: which one handles which task shape.",
  mimeType: "text/markdown",
  text: `# Utility index

Which utility handles which task shape. Read the line, then read that
utility's page for its actions, inputs and errors — nothing below is needed
until a task matches one of these shapes.

## With a detail page

- **\`blog_publish\`** — Publishing blog posts to austegard.com or muninn.austegard.com, linking Bluesky engagement widgets to posts, updating Atom feeds. → \`muninn://utilities/blog_publish\`
- **\`boot_ledger\`** — Auditing or pruning the boot payload: which boot-loaded triggers/ops/voice-signature entries cost the most tokens per unit of actual use, what to demote to reference-only, whether a collapse dropped boot cost. Ranks every boot_load=1 config entry by exact token cost vs a memory-corpus fire-rate proxy; ships an opt-in config_get fire counter (MUNINN_INSTRUMENT_FIRES) for exact go-forward data. Companion to correction_gate (one guards a write, this measures the whole payload). → \`muninn://utilities/boot_ledger\`
- **\`bsky_card\`** — Posting any link to Bluesky via API with a proper card preview (blog posts, tools, apps, dashboards, etc.) → \`muninn://utilities/bsky_card\`
- **\`bsky_limit\`** — Posting to Bluesky and need to verify/enforce the 300-grapheme limit. len() lies on emoji and combining marks. → \`muninn://utilities/bsky_limit\`
- **\`correction_gate\`** — A therapy correction is about to become boot-loaded context (new desire-trigger, ops entry). Held-in + held-out regression gate: does the correction catch the failure that motivated it, and does it regress nothing else (a trigger firing on an unrelated past input, boot bloat)? Gates only the three measurable slices — trigger-firing, recall precision, reindex; voice/relevance stay hand-evolved. Auto-runs from set_rule. → \`muninn://utilities/correction_gate\`
- **\`issue_close\`** — Closing a GitHub issue and capturing the behavioral lesson learned. Optionally tags the synthesis memory as a pending test for the next session. → \`muninn://utilities/issue_close\`
- **\`memory_tfidf\`** — therapy Phase 1 duplicate detection, Phase 2 structural pattern matching, memory deduplication, finding related memories across domains → \`muninn://utilities/memory_tfidf\`
- **\`news_watch\`** — Watch claude.com/blog for new posts during Daily Perch. Pure parsing + watermark state; HTTP fetching is delegated to the caller's web_fetch tool (claude.com WAFs raw container egress). → \`muninn://utilities/news_watch\`
- **\`perch_publish\`** — Publishing flight log discussions to the public perch section of muninn.austegard.com. → \`muninn://utilities/perch_publish\`
- **\`perch_triage\`** — Dream review, morning check-in, or any flight log processing. → \`muninn://utilities/perch_triage\`
- **\`recall_sufficiency\`** — Iterative recall that keeps searching until the answer is sufficient: recall -> judge coverage -> name the gap and re-search for it -> repeat. For autonomous/programmatic runs or cross-corpus retrieval where bailing at 'not found' is wrong; on a single rich KB plain recall() plus judgement is lighter. → \`muninn://utilities/recall_sufficiency\`
- **\`remind\`** — Oskar says "remind me", "don't let me forget", scheduling future reminders, checking/managing existing reminders. → \`muninn://utilities/remind\`
- **\`satisfaction_skew\`** — Auditing the failure:success storage skew — how many correction-tagged entries there are per satisfaction-analog, its monthly trend, and the shape distribution of registered analogs. Reach for it when re-evaluating the satisfaction-register (is it under-firing? is a 4th shape emerging?) or answering Weng-style questions about approach- vs avoidance-orientation in the corpus. Read-only measurement, never fires a trigger. → \`muninn://utilities/satisfaction_skew\`
- **\`task_policy\`** — Load the live policy for a perch autonomous task. Reads the {task}-command ops entry, recent preference memories, and the most recent real run, so task prompts route to fresh policy rather than hardcoded behavior. → \`muninn://utilities/task_policy\`
- **\`verify_patch\`** — PR creation, code review, verifying handoff specs, any time a diff needs vetting → \`muninn://utilities/verify_patch\`
- **\`whtwnd\`** — Publish, update, delete, and list WhiteWind blog entries via ATProto. Posts land in the user's PDS as \`com.whtwnd.blog.entry\` records and federate to the WhiteWind AppView. → \`muninn://utilities/whtwnd\`
- **\`zeitgeist_delta\`** — Running a zeitgeist and about to store the result. Prevents near-identical coverage of running stories (Iran/Hormuz, Norway F-16s) from bloating memory. → \`muninn://utilities/zeitgeist_delta\`

## Routing only

No install manifest upstream, so there is no generated page. The line below is
all the routing information there is; the utility's own module documents the rest.

- **\`bsky_moderation\`** — Moderating a Bluesky thread's repliers in bulk: extract DIDs+text of everyone who replied to a post (extract_thread_repliers, context-lean), classify them, then mute/block the matching accounts (moderate, bounded-parallel, dry_run-default). Two-stage: extraction + authed action, classification is the caller's job.
- **\`flowing\`** — You have 3+ sequential tool calls where the workflow shape is known upfront. Also when pipelines need checkpoint resume (fix step N, resume without re-running steps 1 to N-1), or when side-effects (memory storage, notifications) should not block the main pipeline.
- **\`github_rw\`** — Branch-aware GitHub writes from a spoke / career-search / any-repo workflow: commit a file to a branch, create a branch, open a PR, check live PR state. The write companion to gh_status; stops hand-rolling urllib contents-PUT + pulls boilerplate.
- **\`survey\`** — Seeing the WHOLE memory corpus at some resolution rather than searching it: what a period was about, how storage volume shifted over months, where the gaps are. The divergent counterpart to recall(). Fixed line budget, verbatim at the recent end, extractively collapsed with age.`,
};

export const UTILITY_DOCS: Record<string, string> = {
  "blog_publish": `# blog_publish

**Muninn blog_publish** — Publish HTML pages to austegard.com via GitHub Pages, optionally update the Atom feed, optionally announce on Bluesky with a follow-up engagement-link commit. Encoded as a flowing DAG so the bsky chain is detached and partial-failure-tolerant.

Module: \`muninn_utils.blog_publish\` · CLI: \`python -m muninn_utils.blog_publish\`

Env: \`GH_TOKEN\` (secret), \`GITHUB_TOKEN\`? (secret), \`MUNINN_BSKY_HANDLE\`?, \`MUNINN_BSKY_APP_PASSWORD\`? (secret) (\`?\` = optional)

## Actions

### \`publish_and_announce\` — destructive

- **Goal:** Publish an HTML page and optionally announce it on Bluesky with engagement linking.
- **Inputs:** path (req), content (req), bsky_text (req if announcing), feed_entry (optional), repo (default oaustegard/austegard.com)
- **Outputs:** {page_url, commit_sha, feed_sha, deployed, bsky_post, update_sha, detached_failures}
- **Errors:** auth_invalid, commit_failed, deploy_timeout, bsky_text_too_long, target_unreachable

\`\`\`
publish_and_announce path='blog/post.html' content='<html>...</html>' bsky_text='New post: ...'
\`\`\``,
  "boot_ledger": `# boot_ledger

**Muninn boot_ledger** — Instrument the boot payload: rank every boot-loaded config entry by exact token cost against a fire-rate proxy, so the trigger/ops/voice catalog can be pruned instead of only grown.

Module: \`muninn_utils.boot_ledger\` · CLI: \`python -m muninn_utils.boot_ledger\`

## Actions

### \`report\` — None. Reads config + memories; writes nothing., idempotent

- **Goal:** Make the boot payload's cost-vs-use legible so it can be curated.
- **Inputs:** optional exec_fn (defaults to live Turso), as_json flag
- **Outputs:** markdown report string, or JSON {summary, rows[]}
- **Errors:** Pure core; adapters raise only on Turso/connection failure.

\`\`\`
from muninn_utils.boot_ledger import report; print(report())
\`\`\``,
  "bsky_card": `# bsky_card

**Muninn Bluesky Card** — Compose and publish Bluesky posts with rich link-card embeds (Open Graph preview). Python module; app-password auth; reads arbitrary URLs to extract OG metadata, then posts via the authenticated PDS.

Module: \`muninn_utils.bsky_card\` · CLI: \`python -m muninn_utils.bsky_card\`

Env: \`BSKY_HANDLE\`, \`BSKY_APP_PASSWORD\` (secret), \`BSKY_PDS\`? (\`?\` = optional)

## Actions

### \`whoami\` — read, idempotent

- **Goal:** Verify auth and confirm the configured handle resolves to a real DID.
- **Inputs:** (none)
- **Outputs:** {handle, did, pds}
- **Errors:** auth_invalid, handle_not_found, network_unreachable

\`\`\`
whoami
\`\`\`

### \`post_link\` — destructive

- **Goal:** Share a URL on Bluesky with a proper card preview.
- **Inputs:** text (≤300 graphemes), url, og_overrides? (manual title/description/image), languages? (BCP-47 array)
- **Outputs:** {uri, cid, url}
- **Errors:** text_too_long, url_unreachable, blob_upload_failed, auth_invalid, rate_limited

\`\`\`
post_link text='New post on the manifest spec' url='https://muninn.austegard.com/perch/...'
\`\`\`

### \`delete_post\` — destructive, idempotent

- **Goal:** Retract a Bluesky post by AT-URI.
- **Inputs:** uri (at:// URI from post_link)
- **Outputs:** {uri, deleted: true}
- **Errors:** uri_invalid, not_owned, auth_invalid

\`\`\`
delete-post uri='at://did:plc:abc.../app.bsky.feed.post/3l5...'
\`\`\``,
  "bsky_limit": `# bsky_limit

**Muninn bsky_limit** — Bluesky 300-grapheme length checker and truncator. len() lies on emoji and ZWJ sequences; this counts graphemes correctly and truncates at the last whitespace boundary.

Module: \`muninn_utils.bsky_limit\` · CLI: \`python -m muninn_utils.bsky_limit\`

## Actions

### \`fits\` — none, idempotent

- **Goal:** Check whether text fits Bluesky's 300-grapheme cap.
- **Inputs:** text (req), limit (int, default 300)
- **Outputs:** {fits: bool, length: int}
- **Errors:** (none — pure compute)

\`\`\`
fits text='Hello 👋' limit=300
\`\`\`

### \`truncate\` — none, idempotent

- **Goal:** Trim text to fit Bluesky's grapheme cap without breaking words.
- **Inputs:** text (req), limit (int, default 300), suffix (string, default '…')
- **Outputs:** {text: string, length: int, truncated: bool}
- **Errors:** (none — pure compute)

\`\`\`
truncate text='very long...' limit=50
\`\`\``,
  "correction_gate": `# correction_gate

**Muninn correction_gate** — Held-in + held-out regression gate for self-corrections before they become boot-loaded context. Weng Self-Harness stage 3: measure that a new trigger catches the failure that motivated it and regresses nothing else.

Module: \`muninn_utils.correction_gate\` · CLI: \`python -m muninn_utils.correction_gate\`

## Actions

### \`gate_config_correction\` — None. Pure computation; the recall runner (if used) reads the store., idempotent

- **Goal:** Refuse to boot-load a self-correction that fixes nothing or regresses an established behaviour.
- **Inputs:** key, category, before_value, after_value; optional motivating Case, benchmark dict, max_boot_chars
- **Outputs:** GateResult{passed, held_in_passed, regressions, stale, summary} or None
- **Errors:** Pure; raises only on malformed inputs. The remembering hook swallows import/gate errors and raises ValueError only on a decisive REJECT.

\`\`\`
gate_config_correction('recall-triggers','ops', old_json, new_json, motivating=Case(...))
\`\`\``,
  "issue_close": `# issue_close

**Muninn issue_close** — Close a GitHub issue with a learning synthesis. Posts the synthesis as a closing comment, then writes it as a \`decision\` memory tagged with the issue number — encoded as a flowing DAG so the close ack returns the moment GitHub returns 2xx, while the memory write happens detached.

Module: \`muninn_utils.issue_close\` · CLI: \`python -m muninn_utils.issue_close\`

Env: \`GH_TOKEN\` (secret), \`GITHUB_TOKEN\`? (secret), \`TURSO_TOKEN\` (secret), \`TURSO_URL\` (\`?\` = optional)

## Actions

### \`close\` — destructive

- **Goal:** Close a GitHub issue with a learning synthesis and persist the synthesis as a decision memory.
- **Inputs:** number (req), synthesis (req), repo (default oaustegard/claude-skills), pending_test (bool), extra_tags (string[])
- **Outputs:** {issue_url, comment_url, memory_id, pending_test_applied, detached_failures}
- **Errors:** synthesis_empty, issue_not_found, auth_invalid, close_failed

\`\`\`
close number=619 synthesis='Pattern X works because Y' repo=oaustegard/claude-skills
\`\`\``,
  "memory_tfidf": `# memory_tfidf

**Muninn memory_tfidf** — TF-IDF index over Muninn's memory summaries. Read-only similarity search, near-duplicate detection, clustering, and outlier identification across the memory store.

Module: \`muninn_utils.memory_tfidf\` · CLI: \`python -m muninn_utils.memory_tfidf\`

Env: \`TURSO_TOKEN\` (secret), \`TURSO_URL\` (\`?\` = optional)

## Actions

### \`build_and_query\` — read, idempotent

- **Goal:** Run a TF-IDF similarity query over the memory store.
- **Inputs:** mode (duplicates|similar|clusters|outliers), threshold (float), id (for similar), n (for similar/outliers)
- **Outputs:** {mode: string, results: array, build_time_ms: number, total_memories: int}
- **Errors:** tracking_unconfigured (TURSO_* not set), tracking_unreachable, mode_unknown, id_not_found

\`\`\`
build_and_query mode=duplicates threshold=0.8
\`\`\``,
  "news_watch": `# news_watch

**Muninn news_watch** — Watch claude.com/blog for new posts during Daily Perch. Pure parsing + watermark state; HTTP fetching is delegated to the caller's web_fetch tool (claude.com WAFs raw container egress).

Module: \`muninn_utils.news_watch\` · CLI: \`python -m muninn_utils.news_watch\`

Env: \`TURSO_TOKEN\` (secret), \`TURSO_URL\` (\`?\` = optional)

## Actions

### \`parse_claude_blog\` — none, idempotent

- **Goal:** Parse a fetched copy of claude.com/blog into structured post records.
- **Inputs:** content (req: rendered blog-index page; markdown or HTML — the regex shape matches either)
- **Outputs:** {posts: [{url, title, date (YYYY-MM-DD), category}]}
- **Errors:** (none — returns an empty list on parse miss)

\`\`\`
parse_claude_blog content='...blog page text...'
\`\`\`

### \`filter_new\` — none, idempotent

- **Goal:** Filter parsed posts down to those newer than the watermark.
- **Inputs:** posts (req: from parse_claude_blog), last_seen (ISO date or null)
- **Outputs:** {new_posts: [...]}
- **Errors:** (none — pure compute)

\`\`\`
filter_new posts=[...] last_seen='2026-05-20'
\`\`\`

### \`get_last_seen\` — read, idempotent

- **Goal:** Fetch the watermark for the next perch run.
- **Inputs:** key (optional, default 'claude-blog-last-seen-iso')
- **Outputs:** {last_seen: string|null}
- **Errors:** tracking_unconfigured

\`\`\`
get_last_seen
\`\`\`

### \`set_last_seen\` — write, idempotent

- **Goal:** Advance the watermark to the supplied ISO date.
- **Inputs:** iso (req: YYYY-MM-DD), key (optional, default 'claude-blog-last-seen-iso')
- **Outputs:** {stored: bool}
- **Errors:** tracking_unconfigured, iso_invalid

\`\`\`
set_last_seen iso='2026-05-27'
\`\`\`

### \`format_for_report\` — none, idempotent

- **Goal:** Format filtered posts for the perch HTML report.
- **Inputs:** new_posts (req: list from filter_new)
- **Outputs:** {html: string}
- **Errors:** (none — pure compute)

\`\`\`
format_for_report new_posts=[{url, title, date, category}]
\`\`\``,
  "perch_publish": `# perch_publish

**Muninn perch_publish** — Publish a perch flight log (GitHub discussion) to muninn.austegard.com/perch/ as HTML, updating the perch index and Atom feed.

Module: \`muninn_utils.perch_publish\` · CLI: \`python -m muninn_utils.perch_publish\`

Env: \`GH_TOKEN\` (secret), \`GITHUB_TOKEN\`? (secret) (\`?\` = optional)

## Actions

### \`publish_flight_log\` — destructive

- **Goal:** Publish a perch flight log discussion as a public HTML page.
- **Inputs:** number (req: discussion #), repo (default oaustegard/muninn.austegard.com)
- **Outputs:** {url, slug, commit_sha}
- **Errors:** auth_invalid, discussion_not_found, commit_failed

\`\`\`
publish_flight_log number=430
\`\`\``,
  "perch_triage": `# perch_triage

**Muninn perch_triage** — Triage open Perch flight-log discussions by reaction signal. Groups them into action buckets (auto-close, discuss, file-issue, hold, correct, nag). Optional auto-close path executes the THUMBS_UP/LAUGH bucket.

Module: \`muninn_utils.perch_triage\` · CLI: \`python -m muninn_utils.perch_triage\`

Env: \`GH_TOKEN\` (secret), \`GITHUB_TOKEN\`? (secret), \`TURSO_TOKEN\`? (secret), \`TURSO_URL\`? (\`?\` = optional)

## Actions

### \`triage\` — destructive

- **Goal:** Triage Perch flight logs by reaction; optionally auto-close the obvious-good bucket.
- **Inputs:** auto_close (bool, default true), nag_days (int, default 3), limit (int, default 25)
- **Outputs:** {auto_closed, discuss_priority, file_issues, hold, correction, close_not_useful, close_celebrate, nag, unreacted_recent} — each an array of log dicts
- **Errors:** auth_invalid, category_not_found, network_unreachable, tracking_unconfigured (when auto_close=true and TURSO_* not set)

\`\`\`
triage auto_close=false nag_days=3
\`\`\`

### \`triage_report\` — read, idempotent

- **Goal:** Render a triage result as text.
- **Inputs:** result (optional triage output dict)
- **Outputs:** {report: string}
- **Errors:** (inherits from triage when result=null)

\`\`\`
triage_report
\`\`\``,
  "recall_sufficiency": `# recall_sufficiency

**Muninn recall_sufficiency** — Iterative recall that searches until the answer is sufficient: recall, judge coverage, name the missing piece, re-search for it, repeat. The portable kernel of agentic RAG minus the multi-agent framing.

Module: \`muninn_utils.recall_sufficiency\` · CLI: \`python -m muninn_utils.recall_sufficiency\`

## Actions

### \`recall_until_sufficient\` — Reads the memory store; no writes., idempotent

- **Goal:** Get a complete-enough set of memories for a multi-part question without bailing at the first 'not found'.
- **Inputs:** question (req), judge (callable, default term_coverage_judge), max_iters (int, default 4), n (int, default 6)
- **Outputs:** LoopState{pool, gaps, queries, iters, satisfied, stalled}
- **Errors:** Re-raises the last recall() error only after exhausting internal transient-failure backoff.

\`\`\`
recall_until_sufficient question='discharge meds, diet, and allergies for the patient'
\`\`\``,
  "remind": `# remind

**Muninn remind** — Reminder system over the Muninn memory store. Create one-shot or recurring reminders, mark them done, snooze them, sweep stale ones. All persistence rides on the same Turso DB as the rest of Muninn's memory subsystem.

Module: \`muninn_utils.remind\` · CLI: \`python -m muninn_utils.remind\`

Env: \`TURSO_TOKEN\` (secret), \`TURSO_URL\` (\`?\` = optional)

## Actions

### \`create\` — write

- **Goal:** Create a reminder.
- **Inputs:** what (req), due (ISO or shorthand like '+3d'), kind (nag|notice), recur_days, alert_before_days, tags, priority
- **Outputs:** {memory_id}
- **Errors:** tracking_unconfigured, due_unparseable

\`\`\`
create what='check verify_patch tracking review' due='+7d' kind='notice'
\`\`\`

### \`done\` — write

- **Goal:** Complete a reminder.
- **Inputs:** reminder_id (full or 8-char prefix), note (optional)
- **Outputs:** {status: string, next_due: string|null}
- **Errors:** tracking_unconfigured, reminder_not_found

\`\`\`
done reminder_id='abc12345' note='shipped'
\`\`\`

### \`snooze\` — write, idempotent

- **Goal:** Defer a reminder.
- **Inputs:** reminder_id, until (ISO or shorthand)
- **Outputs:** {status, new_due}
- **Errors:** tracking_unconfigured, reminder_not_found, until_unparseable

\`\`\`
snooze reminder_id='abc12345' until='+1w'
\`\`\`

### \`due\` — read, idempotent

- **Goal:** Show active reminders due soon (or overdue).
- **Inputs:** horizon_days (int, default 2)
- **Outputs:** {reminders: [{id, what, due, kind, age_days}]}
- **Errors:** tracking_unconfigured

\`\`\`
due horizon_days=7
\`\`\`

### \`list\` — read, idempotent

- **Goal:** Enumerate reminders.
- **Inputs:** include_done (bool, default false)
- **Outputs:** {reminders: [...]}
- **Errors:** tracking_unconfigured

\`\`\`
list include_done=true
\`\`\`

### \`sweep\` — write

- **Goal:** Clean up stale reminders.
- **Inputs:** archive_after_days (int, default 21), missed_cycles (int, default 2), dry_run (bool, default true)
- **Outputs:** {archived: [...], count: int, dry_run: bool}
- **Errors:** tracking_unconfigured

\`\`\`
sweep dry_run=false
\`\`\``,
  "satisfaction_skew": `# satisfaction_skew

**Muninn satisfaction_skew** — Measure the failure:success storage skew in the memory corpus — correction-tagged vs satisfaction-analog-tagged entries, the headline ratio, its monthly trend, and the shape distribution the satisfaction-register's SHAPE EVOLUTION clause needs.

Module: \`muninn_utils.satisfaction_skew\` · CLI: \`python -m muninn_utils.satisfaction_skew\`

## Actions

### \`measure_skew\` — None. Read-only; never writes memories or config, never fires a trigger., idempotent

- **Goal:** Make the failure:success storage skew measurable and re-runnable so the satisfaction-register rebalance decision rests on data, not eyeballing.
- **Inputs:** optional memories list (else Turso); optional fail_tags / success_tags / analog_tag overrides
- **Outputs:** SkewReport{total, fail_count, analog_count, success_count, ratio_analog, ratio_success, monthly[], shape_distribution{}, unshaped_analogs}
- **Errors:** Pure; raises only on malformed rows. Turso read errors propagate from the remembering _exec layer on the default path.

\`\`\`
measure_skew()  # or measure_skew(memories=[{'tags': ['correction'], 'created_at': '2026-06-01'}, ...])
\`\`\``,
  "task_policy": `# task_policy

**Muninn task_policy** — Load the live policy for a perch autonomous task. Reads the {task}-command ops entry, recent preference memories, and the most recent real run, so task prompts route to fresh policy rather than hardcoded behavior.

Module: \`muninn_utils.task_policy\` · CLI: \`python -m muninn_utils.task_policy\`

Env: \`TURSO_TOKEN\` (secret), \`TURSO_URL\` (\`?\` = optional)

## Actions

### \`load\` — read, idempotent

- **Goal:** Resolve a perch task's live policy from Turso.
- **Inputs:** task_name (req: e.g. 'zeitgeist'|'fly'|'sleep'|'dispatch'), n_prefs (int, default 5)
- **Outputs:** {instructions: string|null, preferences: array, last_run: object|null}
- **Errors:** tracking_unconfigured (no Turso creds; partial-success path leaves all three keys at null defaults)

\`\`\`
load task_name='zeitgeist' n_prefs=5
\`\`\`

### \`days_since_last_run\` — none, idempotent

- **Goal:** Compute the age of the most recent prior run.
- **Inputs:** policy (req: dict from load())
- **Outputs:** {days: number|null}
- **Errors:** (none — pure compute, returns null on parse miss)

\`\`\`
days_since_last_run policy={...}
\`\`\`

### \`format_summary\` — none, idempotent

- **Goal:** Render the policy as a one-line log message.
- **Inputs:** policy (req: dict from load()), task_name (req)
- **Outputs:** {summary: string}
- **Errors:** (none — pure compute)

\`\`\`
format_summary policy={...} task_name='zeitgeist'
\`\`\``,
  "verify_patch": `# verify_patch

**Muninn verify_patch** — Semi-formal patch verification with outcome tracking. Sends a unified diff plus context to a Claude model with a structured premises/trace/regression-check template, stores the verification result in memory, and exposes review/stamp helpers for post-merge calibration.

Module: \`muninn_utils.verify_patch\` · CLI: \`python -m muninn_utils.verify_patch\`

Env: \`ANTHROPIC_API_KEY\` (secret), \`TURSO_TOKEN\` (secret), \`TURSO_URL\` (\`?\` = optional)

## Actions

### \`verify_patch\` — write

- **Goal:** Get a structured review of a patch with persisted outcome tracking.
- **Inputs:** patch (req: unified diff text), context (optional), description (optional), model (default claude-sonnet-4-6)
- **Outputs:** {tracking_id, verdict, model, raw_response}
- **Errors:** auth_invalid, model_unavailable, storage_failed

\`\`\`
verify_patch patch='--- a/x.py\\n+++ b/x.py\\n...' context='function foo signature' description='fix off-by-one'
\`\`\`

### \`stamp_verification\` — write, idempotent

- **Goal:** Close the loop on a prediction.
- **Inputs:** tracking_id (req), outcome (req: merged|rejected|reverted), note (optional)
- **Outputs:** {stamped: bool, new_id: str}
- **Errors:** tracking_id_not_found, storage_failed

\`\`\`
stamp_verification tracking_id='abc123' outcome='merged'
\`\`\``,
  "whtwnd": `# whtwnd

**Muninn whtwnd** — Publish, update, delete, and list WhiteWind blog entries via ATProto. Posts land in the user's PDS as \`com.whtwnd.blog.entry\` records and federate to the WhiteWind AppView.

Module: \`muninn_utils.whtwnd\` · CLI: \`python -m muninn_utils.whtwnd\`

Env: \`BSKY_HANDLE\`, \`BSKY_APP_PASSWORD\` (secret) (\`?\` = optional)

## Actions

### \`post\` — destructive

- **Goal:** Publish a new WhiteWind blog post.
- **Inputs:** content (req, markdown), title (req), blobs (optional blob_metadata array)
- **Outputs:** {post_url, uri, cid, rkey}
- **Errors:** auth_invalid, content_too_long, blob_not_found, network_unreachable

\`\`\`
post content='# Title\\n\\nBody...' title='My Post'
\`\`\`

### \`update\` — write, idempotent

- **Goal:** Edit a previously-published WhiteWind entry.
- **Inputs:** rkey (req), content (req), title (req), blobs (optional)
- **Outputs:** {post_url, uri, cid, rkey}
- **Errors:** auth_invalid, rkey_not_found, network_unreachable

\`\`\`
update rkey='3l5...' content='...' title='Edited'
\`\`\`

### \`delete\` — destructive, idempotent

- **Goal:** Retract a WhiteWind entry.
- **Inputs:** rkey (req)
- **Outputs:** {deleted: bool}
- **Errors:** auth_invalid, network_unreachable

\`\`\`
delete rkey='3l5...'
\`\`\`

### \`list\` — read, idempotent

- **Goal:** Enumerate the user's published WhiteWind entries.
- **Inputs:** limit (int, default 50, max 100)
- **Outputs:** {entries: [{rkey, title, createdAt, preview}]}
- **Errors:** auth_invalid, network_unreachable

\`\`\`
list limit=20
\`\`\`

### \`upload_image\` — write

- **Goal:** Upload an image so it can be embedded in a WhiteWind entry.
- **Inputs:** image_path (req, local file path)
- **Outputs:** {blob_metadata, markdown, url, cid}
- **Errors:** file_not_found, mime_unsupported, blob_too_large, network_unreachable

\`\`\`
upload_image image_path='/tmp/header.png'
\`\`\``,
  "zeitgeist_delta": `# zeitgeist_delta

**Muninn zeitgeist_delta** — Semantic deduplication for zeitgeist drafts. Compares each topic section of a candidate zeitgeist memory against the N most-recent stored zeitgeists using Gemini embeddings (via Cloudflare AI Gateway) and emits a delta-only compressed version.

Module: \`muninn_utils.zeitgeist_delta\` · CLI: \`python -m muninn_utils.zeitgeist_delta\`

Env: \`CF_ACCOUNT_ID\`, \`CF_GATEWAY_ID\`, \`CF_API_TOKEN\` (secret), \`TURSO_TOKEN\` (secret), \`TURSO_URL\` (\`?\` = optional)

## Actions

### \`check_delta\` — read, idempotent

- **Goal:** Identify which sections of a candidate zeitgeist memory duplicate prior entries, and emit a compressed delta.
- **Inputs:** draft (req markdown), n_recent (int, default 5), threshold (float, default 0.85)
- **Outputs:** {report: [{section, verdict, similarity, ref_id?}], delta_text: string, total_sections: int, redundant_count: int}
- **Errors:** tracking_unconfigured, gateway_unreachable, embed_failed, draft_empty

\`\`\`
check_delta draft='# Topic A\\n...' n_recent=5 threshold=0.85
\`\`\``,
};
