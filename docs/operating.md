# Operating muninn-mcp

How to run the parity gate, what its verdicts mean, and which stage of
[`mcp-migration.md`](https://github.com/oaustegard/muninn-utilities/blob/main/docs/mcp-migration.md)
you are allowed to be in. For getting a Worker deployed, see
[`deploying.md`](./deploying.md).

---

## The stage you are in decides what is safe

The migration is staged deliberately, and the stages are not decorative — each
one has an entry gate and a rollback, and the rollback for a later stage is
expensive in a way the earlier ones are not.

| Stage | Green points at | Green may | Rollback |
|---|---|---|---|
| 1 | a **branch** database | read | delete the branch |
| 2 | production | read | stop calling the tool |
| 3 | production | read + write, `source=mcp` | soft-delete rows by `source` |
| 4 | production | everything; instructions flip | revert the instructions |

**Stage 1 is where this repo is.** `TURSO_URL` must point at a branch database:

```bash
turso db create muninn-green --from-db <production>
```

The reason is not that reads are dangerous — they are idempotent, which is what
makes Stage 2 the one genuinely free cutover in the whole plan. It is that a
branch is the only place where being wrong costs nothing at all, and the parity
harness has not yet been green on the production corpus, which is larger and
messier than the branch.

There are no write tools in this deployment. Not disabled — **absent**. If you
find yourself adding one before the gate is green on production, that is the
plan being skipped, not a feature landing early.

---

## Running the parity gate

The harness compares blue (the Python skill talking to Turso) against green
(this Worker's retrieval layer talking to the same Turso) over a frozen query
set, and diffs the id order.

```bash
npm run harness          # capture both sides, then diff
npm run harness:blue     # ~110s — the Python side
npm run harness:green    # ~15s  — the TypeScript side
npm run harness:diff     # instant — the verdict
```

Needs `TURSO_URL` and `TURSO_TOKEN` in the environment, and a checkout of
`muninn-utilities` (set `MUNINN_SCRIPTS` if it is not at
`/home/user/muninn-utilities/remembering/scripts`). Both capture scripts exit 2
with a legible message if credentials are missing, rather than writing a partial
snapshot.

### Reading a verdict

`diff.mjs` classifies every query rather than just passing or failing it,
because "green disagrees" is not one thing:

| Class | Means |
|---|---|
| `MATCH` | identical id sequence |
| `EXTRA+` | blue continued past green's list — the expansion signature |
| `ORDER` | same rows, different order — ranking |
| `SET-DIFF` | rows differ both ways — filters first, then ranking |
| `ERR-BLUE` / `ERR-GREEN` | one side refused or failed |

Only mismatches **not** declared as `known-gap` in `queries.json` count as
regressions. `--allow-known-gaps` gates on regressions alone, which is the mode
CI would use.

**Read the counts, not just the verdict.** A `parity` entry where both sides
returned zero rows passes trivially. If a query group is suspiciously quiet, the
search terms have probably drifted out of the corpus rather than the port having
become perfect.

---

## Three things the gate cannot prove

These are limitations of comparing two access paths to one live, mutable
database. None of them is a bug in either implementation, and pretending the
gate is stronger than it is would be worse than the gaps themselves.

**Reading is not free, and it moves the ranking.** Blue's `recall()` spawns a
thread that increments `access_count` on every row it returns, and
`access_count` is a ranking input under `episodic`. So a naive harness perturbs
the input it is measuring, and whoever runs first pays for the second. The
capture neuters tracking by default and forces `auto_strengthen` off — that one
bumps `priority`, which is in the composite for *both* modes and is a permanent
mutation. `blue.json` records which mode was used.

**It compares an access path, not a dataset.** There is one database. The
harness cannot detect data corruption, only disagreement about how to read it.

**The composite score is a function of wall-clock time.** The recency term is
`1.0 / (1.0 + (julianday('now') - julianday(m.t)) * 0.01)`, so every row's score
drifts continuously — and rows of different ages drift at *different rates*. Two
rows whose scores differ by a few parts per million will swap order between two
captures, and the drift within a single ~110-second capture is the same order of
magnitude as the gaps being resolved deep in a large-`n` tail. **Capturing the
two sides closer together does not fix this**, which is why the harness
classifies near-ties rather than advising better timing.

---

## Regenerating the golden artefacts

Two generated files are committed, and both can rot silently if nobody
regenerates them. Each has a command that proves it hasn't.

```bash
npm run harness:fts      # src/fts-golden.json — 33 FTS5 escaping vectors
npm run build:docs       # src/docs-generated.ts — the muninn:// resource content
node scripts/build-docs.mjs --check   # CI drift check, exits 1 on divergence
```

`harness:fts` regenerates the FTS vectors **by running the live Python**, so a
divergence between blue's `_escape_fts5_server` and green's `escapeFts5` shows
up as a changed file rather than as a mystery months later. It should report
`IDENTICAL`.

`build:docs` reads `muninn-utilities` (override the root with
`MUNINN_UTILITIES`) and rewrites the resource content. It is deterministic apart
from the `generatedAt` stamp, so a real change is legible in the diff.

---

## When something looks wrong

**A first call fails with 503 after an idle period.** Expected, not a
credentials problem — Turso cold-starts, and Workers make it worse because any
request may hit a cold isolate. `withRetry` handles it with blue's own budget
(5 attempts, 500ms base, doubling, jittered). If you see it surface to a caller,
the retry budget was exhausted, which usually means the egress proxy is having a
worse day than a cold start.

**A gate mismatch on a sparse query.** Check whether the query returns fewer
than 3 rows. Below that threshold blue runs a multi-stage expansion, and that
layer is Python sitting *above* the SQL — the "ranking is server-side SQL"
property that makes this port tractable stops holding exactly there.

**A gate mismatch you cannot explain.** Re-run blue before believing it. The
harness has already caught blue disagreeing with itself once
(muninn-utilities#100), and an oracle that is not reproducible cannot be diffed
against.

**A tool description points at a `muninn://` URI that 404s.** It shouldn't — a
test reads every URI in every shipped description back through the protocol. If
it happens, `src/docs-generated.ts` is stale relative to the tool descriptions;
run `npm run build:docs`.
