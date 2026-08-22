# The parity harness

> "Gate: the parity harness. A frozen set of ~50 golden queries — every `recall`
> shape in `references/`, plus the boot payload — run against blue-Python and
> green-MCP, results normalized and diffed. Byte-equal on the boot payload;
> identical id-order on ranked recalls. **This harness is the deliverable of this
> stage, more than the Worker is.**"
>
> — `muninn-utilities/docs/mcp-migration.md` §5, Stage 1

Blue is the Python at `remembering/scripts/` (`memory.py::recall` over
`turso.py::_fts5_search`). Green is the TypeScript in `src/`. They hit the **same
Turso database** — data is single-homed (§4) — so this compares two *access
paths*, never two datasets.

## Files

| | |
|---|---|
| `queries.json` | The frozen golden set. 74 `recall` shapes, each with a `why`. |
| `blue.py` | Runs the set through the live Python → `snapshots/blue.json`. |
| `green.mjs` | Runs it through `src/turso.ts` + `src/tools.ts` → `snapshots/green.json`. |
| `diff.mjs` | The gate. Reads both snapshots, classifies, exits non-zero on mismatch. |
| `regen-fts-vectors.py` | Regenerates `src/fts-golden.json` from blue. No credentials needed. |

## Run it

```bash
export TURSO_URL=...        # both sides read these two names
export TURSO_TOKEN=...

npm run harness             # capture blue, capture green, diff
```

Or step by step:

```bash
npm run harness:blue
npm run harness:green
npm run harness:diff        # add -- --allow-known-gaps while the port is mid-flight
```

**Capture blue and green back to back.** The corpus is live; a `remember()`
between the two captures shows up as a mismatch that no code change will fix.
`diff.mjs` prints the skew and warns above ten minutes.

### A write during the captures voids the run — and one write can void many entries

Twenty-four seconds of skew was enough. A live run produced **thirteen SET-DIFF
regressions**, every one of which had the same shape: green returned a row blue
never saw, and blue kept a row green had dropped. All thirteen were one event —
a `supersede()` that landed at `03:48:43`, between blue's main body and green's
run. It wrote a new memory and soft-deleted the one it replaced, so **every**
result set that was `LIMIT`ed around either row shifted by one. Green was
correct throughout; the measurement was not.

Two things make this worth defending against rather than remembering:

- **The skew warning does not catch it.** That warns above ten minutes. The
  hazard is not how *long* the window is, it is whether anything *wrote* during
  it, and a 24-second window was plenty.
- **`supersede()` does not bump `updated_at`.** It sets `deleted_at` on the
  original and inserts a replacement, so a watermark built on
  `created_at`/`updated_at` alone misses exactly the mutation that reorders
  results. `deleted_at` is in `MUTATION_COLUMNS` for that reason.

So both capture scripts now record `corpus_mutations` — every id whose
`created_at`, `updated_at` or `deleted_at` falls inside that side's run — and
`diff.mjs` reclassifies a failure as **`SKEW`** when *every* disputed id is in
that set. One disputed id outside it and the entry stays a regression.

**`SKEW` is void, `TIE` is passing.** They are the only two classes that can stop
a failure counting, and they make different claims. `TIE` says the gate declines
to assert an ordering the ranking does not have — re-running changes nothing.
`SKEW` says the comparison never happened — the run exits **non-zero** and prints
`INCONCLUSIVE`, because accepting it would be accepting a measurement already
known to be invalid. `--allow-known-gaps` does not launder it.

Both are covered by `node harness/diff.mjs --self-test`, half of the `SKEW` cases
being ones it must **refuse** — a partially-mutated disputed set, a pure reorder,
and snapshots carrying no mutation data at all. As with `TIE`: "it stopped
complaining" is not evidence.

Snapshots captured before this existed have no `corpus_mutations` field;
`diff.mjs` warns and reclassifies nothing.

Back-to-back narrows the window for a *write* to land between the captures. It
does **not** make deep-tail ordering reproducible — the composite score moves
continuously with wall-clock time, and near-tied rows cross over inside a single
capture run. See *Ranked order is not reproducible in the tail* below; that is
what the `TIE` classification is for, and it is not something a faster capture
fixes.

### Without credentials

Three things work on any machine:

```bash
npm run harness:fts                                   # regenerate + verify FTS vectors
python3 harness/blue.py --dry-run                     # every kwarg checked against blue's real signature
node --experimental-strip-types harness/green.mjs --dry-run   # translation + bound parameters
```

`green.mjs --dry-run` is the cheap review pass: it prints the parameters green
would bind, which is where swapped `since`/`until`, a `type: ""` that became a
real predicate, or a tag pattern that lost its `ESCAPE` are all visible for free.

```bash
node harness/diff.mjs --self-test   # hand-rolled checks on the TIE and SKEW logic
```

`--self-test` exercises the near-tie classifier against synthetic cases, half of
which are reorderings it **must** refuse to excuse: a full reversal, an
`ASC`→`DESC` green, a long-range move past a tied cluster, missing scores, a
boost-ordered blue. The `TIE` class is the one part of this gate that can make a
failure disappear, so "it stopped complaining" is not evidence — this is.

`blue.py` and `green.mjs` both exit **2** with an explanatory message when
credentials are missing. Neither crashes and neither writes a partial snapshot.

## What it proves

- **Identical id order** on every ranked recall shape, which is §5's actual
  requirement. Not a set comparison: `bm25()` returns *negative* scores so the
  composite sorts `ASC`, and a reviewer "fixing" that to `DESC` produces a green
  that returns every right memory in the worst possible order. Order is the
  assertion — with one carve-out, argued in full below: the relative order of
  rows whose composite scores are closer together than the score drifts between
  captures is **not** asserted, because it is not a property either
  implementation has.
- **The FTS5 escaper still matches**, byte for byte, via `regen-fts-vectors.py`.
- **Filter semantics**, across the corners that no unit test reaches: NULL
  confidence against a threshold, LIKE's case-insensitivity versus `json_each`'s
  case-sensitivity, `_` as a LIKE wildcard inside a tag, `type: ""` under a
  truthiness guard versus a definedness guard.
- **Where green is still missing behaviour**, named and enumerated rather than
  discovered later — the 9 entries marked `known-gap`.

## What it does NOT prove

**Reading is not free, and it moves the ranking.** Blue's `recall()` spawns a
daemon thread that buffers `access_count += 1` for every row returned and flushes
to Turso. `access_count` is a ranking input under `episodic=True`
(`* (1.0 + ln(1.0 + access_count) * 0.2)`). So a naive harness perturbs the very
input it is measuring, and whoever runs first pays for the second. Mitigations:

- `auto_strengthen` is **forced off**. It bumps `priority`, which is in the
  composite for *both* modes — a permanent ranking mutation.
- Access tracking is **neutered by default** (`MUNINN_HARNESS_TRACK_ACCESS=1`
  restores it). This cannot change what the current run returns, since tracking
  happens after the rows are chosen; it stops the current run from moving the
  next one. `blue.json` records which mode was used, and `diff.mjs` warns when a
  snapshot was captured with tracking live.

Even so, the corpus is shared and mutable. **Two green runs are reproducible;
blue-then-green is only reproducible if nothing wrote in between.**

**Blue was not deterministic either — this is fixed, and the story is worth
keeping.** The first live run of this gate produced exactly one undeclared
mismatch: `n-one`, `recall('bluesky', n=1)`, where blue and green each returned a
different single row. Green was not at fault. Blue returned a *different answer
to the same query in different processes*:

```
PYTHONHASHSEED=0 → 8df0ab0d      PYTHONHASHSEED=3 → 8df0ab0d
PYTHONHASHSEED=1 → 889875b9      PYTHONHASHSEED=4 → 889875b9
PYTHONHASHSEED=2 → 6edc2ff8      PYTHONHASHSEED=5 → 8df0ab0d
```

The mechanism is in `memory.py::recall`. Any query returning fewer than
`expansion_threshold` (3) rows triggers the multi-stage expansion, which iterates
`for tag in stage1_tags` — a **`set` of strings** — and breaks out once
`len(results) + len(expansion_results) >= n * 2`. At `n=1` the cap is 2 and
`results` already holds 1, so **the first tag visited decides the entire answer**,
and set iteration order over strings is randomised per process by PEP 456 hash
randomisation. `cooccur_tags` and `hop2_tags` are sets on the same path.

Two consequences for anyone reading this gate:

1. **A mismatch on an expansion-triggering query is not evidence against green.**
   Re-run blue before believing one. Blue captured twice over this 64-query set
   differed on this entry and no other, so the blast radius is small — but it is
   not zero, and it is concentrated exactly where the ranking is hardest to reason
   about.
2. **Byte-equal SQL does not imply equal results** when application code sits
   above the SQL. §3's "the ranking is server-side SQL, so the port is tractable"
   holds for `_fts5_search` and stops holding at `recall()`. The expansion layer
   is Python, it is order-dependent, and porting it will reproduce this
   non-determinism unless it is fixed on the way across — sorting the tag sets
   before iterating would make blue reproducible and cost nothing.

**Fixed in muninn-utilities#100** by sorting the three tag sets before iterating,
and `n-one` now matches: blue returns `6edc2ff8` across every `PYTHONHASHSEED`,
and green — once the expansion was ported — returns the same. The entry has been
promoted to `expect: "parity"` so it can never silently reopen.

Two things survive the fix and are the reason this section stays:

1. **You cannot diff against an oracle that disagrees with itself.** Blue being
   reproducible is a precondition for the gate meaning anything, not a nicety. If
   a future mismatch looks like green's fault, re-run blue before believing it.
2. **Byte-equal SQL does not imply equal results** when application code sits
   above the SQL. §3's "the ranking is server-side SQL, so the port is tractable"
   holds for `_fts5_search` and stops holding at `recall()`. The expansion layer
   is Python, order-dependent, and porting it faithfully meant porting the
   `sorted()` too — a port made before #100 would have inherited the
   non-determinism.

This is also why the gate compares green's `recallWithExpansion`, not its bare
`search()`: blue's records come from `recall()`, and diffing against a layer that
never expands compares two different questions.

**Ranked order is not reproducible in the tail, by either side, and the gate
cannot assert it.** The composite score is a function of wall-clock time:

```
composite = bm25 × (1 + priority×0.3) × (1 + conf×0.15)
                 × 1.0 / (1.0 + (julianday('now') - julianday(m.t)) × 0.01)
```

`julianday('now')` is evaluated server-side at query time, so every row's score
drifts continuously. The factor is monotone in `t`, which invites the assumption
that the *order* it induces is stable. It is not — the derivative depends on the
row's age:

```
d/dt ln|composite| = -0.01 / (1 + 0.01 × age_days)
```

A one-day-old row decays at ~0.01/day; a 194-day-old one at ~0.0034/day. Rows of
different ages converge and cross, forever. **Capturing closer together does not
fix this.** Over the ~90–110 s a single blue capture takes, age advances by
~0.00125 days, which for a 120-day-old row is a relative score change of
`0.01 × 0.00125 / 2.2 ≈ 5.7e-06` — the same order of magnitude as the `4.2e-06`
gap that decided the first real instance of it. **A near-tied pair can flip
inside one capture run.** Blue cannot reproduce its own tail ordering across two
runs any more than green can match blue's.

This is a limitation of comparing ranked output from a decaying score. It is not
a bug in blue, not a bug in green, and not something either could fix without
changing the ranking itself — freezing `now` into a bound parameter would do it,
but that changes what users get, not just what the gate sees.

So the gate stops asserting it, narrowly. `diff.mjs` classifies a reordering as
**`TIE`** — passing, not a regression — when the id *sets* agree and **every**
pair of rows that changed places is closer in composite score than the score
could have drifted in the capture window. Anything else stays `ORDER` and stays
a regression. To make that judgeable rather than magical:

- Both snapshots now record `composite_score` alongside each id. Blue's non-FTS
  `_query` path (`strict`, `fetch_all`, falsy `search`) computes no composite at
  all, so those records carry `null` and are **never** eligible for `TIE`.
- The epsilon is derived from the decay rate (`0.01`/day, read out of the SQL)
  times the capture window (computed from the snapshots' own `captured_at` and
  `elapsed_s`) times the worst-case spread in decay rates. It is printed with
  its derivation on every run. For a 400 s window it is ~4.6e-05 — roughly the
  fifth significant figure.
- `TIE` requires both score sequences to be **non-decreasing**, i.e. the
  composite really is the sort key. Blue's expansion re-sorts by provenance
  boost, so expansion results can never be excused as ties.
- The near-tie section prints the actual gaps on both sides, so you can overrule
  the verdict.

What this **cannot** catch, and you should know it: a green whose composite is
wrong by less than the epsilon and which only ever reorders rows that were
already that close. No order comparison could catch that. Everything coarser —
`ASC`→`DESC`, a dropped factor, `0.3` mistyped as `0.03`, a lost
`is_superseded = 0` — moves scores by percent or more and still fails as `ORDER`.

**It compares an access path, not a dataset.** There is one database. This
harness cannot detect data corruption, only disagreement about how to read it.

**Sparse queries are expected to diverge, and that is the interesting part.**
Blue runs a four-stage expansion whenever the primary search returns fewer than
`expansion_threshold` (default 3) rows: it harvests tags from stage-1 results,
expands them through the PMI co-occurrence index, re-searches, takes a second
hop, then re-sorts everything by a provenance-weighted boost score
(3.0 / 2.0 / 1.5 / 1.0). Green has none of this. Every `sparse-*` entry, and
every filter narrow enough to fall under three results, will diverge until
expansion lands.

`diff.mjs` classifies the expansion signature specially as **`EXTRA+`** — blue's
id list *starts with green's entire list* and continues. If you see `EXTRA+` on a
query returning three or more rows, that is **not** expansion and is a real bug.

Two entries — `sparse-expansion-disabled` and `sparse-single-hit-disabled` — pass
`expansion_threshold=0`. They are the **controls**: same sparse shape, expansion
off, so they must match today. If a control fails, the problem is in retrieval,
not in the missing expansion stage.

Also worth knowing about blue's expansion, because the harness surfaces it:
stages 3, 3b and 4 re-pass `type`, `tags`, `conf`, `since` and `until` — but
**not `session_id`**. A session-scoped recall that falls under the threshold can
therefore return rows from other sessions.

**No Worker, no MCP envelope, no OAuth.** `green.mjs` imports `src/turso.ts` and
`src/tools.ts` directly and builds its own libsql client, so the gate is runnable
before anything is deployed and a failure means retrieval rather than transport.
The cost is that nothing here exercises `src/index.ts`, `createMcpHandler`, the
JSON-RPC envelope, or auth.

**No boot payload.** §5 also asks for byte-equality on the boot payload. Green
serves no boot payload yet — there is no `boot` tool — so that half of the gate
is unwritten. This harness covers the `recall` half only.

**It is only as good as its corpus.** Search terms were chosen to be
corpus-shaped (`turso`, `mcp`, `bluesky`, `perch`, `boot`), but a `parity` entry
that returns zero rows on both sides passes trivially. Read the counts in the
verdict table, not just the verdicts. Entries returning `blue=0 green=0` are
proving nothing that day.

## The query set

74 entries. Each has an `id` (stable — never renumber, snapshots key off it), a
`why`, `args` in **blue's** kwarg vocabulary, and an `expect` of `parity` or
`known-gap` (with a `gap` naming the missing green feature).

65 `parity`, 9 `known-gap`.

| Group | n | Probes |
|---|---|---|
| `text-*` | 5 | Baseline ranking: one term, two terms, high recall, mixed case, six terms. |
| `n-*` | 5 | Default/1/50/200/0. Independently-written defaults, LIMIT 0, the tool layer's `[1,50]` clamp. |
| `type-*` | 5 | Type filter, type without a search term, unknown value, `""` under truthiness-vs-definedness, composed with `conf`. |
| `tags-*` | 10 | Both `tag_mode`s, empty list, ASCII case (LIKE vs `json_each`), `_` as a LIKE wildcard, non-ASCII, `tags_all`/`tags_any` sugar. |
| `conf-*` | 6 | 0 / 0.3 / 0.5 / 0.95 / 1.0 and a sparse one. 0.5 is where a `COALESCE` in the *filter* admits every NULL-confidence row. |
| `since-*` / `until-*` | 6 | Each bound alone, a window, an inverted window, `+02:00` offset, bare date. The last two probe `normalize_to_utc`. |
| `session-id-*` | 3 | Scoping, a nonexistent session, and composition with other filters. |
| `episodic-*` | 3 | The access-count boost — the one ranking input the harness itself perturbs. |
| `sparse-*` | 4 | **Highest value.** Under-three-result queries plus two expansion-disabled controls. |
| empty / whitespace | 4 | `""` (blue leaves FTS entirely), `"   "` (blue stays in FTS), tab+newline, no search arg at all. |
| `fts-*` | 7 | Embedded quote, infix `*`, all six specials, `AND`, lowercase `and`, keywords-only, `NEAR`, hyphen + CJK. |
| `mode-*` / `guard-*` | 4 | `strict`, `fetch_all`, `exploration`, and `recall("*")` raising `ValueError`. |

## Reading a failure

```
FAIL tags-case-mismatch    MISSING   blue=  0 green=  7
```

```
--- tags-case-mismatch   [MISSING]  ** REGRESSION **
    why : SQLite's LIKE is case-INSENSITIVE for ASCII; `value = ?` under
           json_each is case-SENSITIVE...
    args: {"search":"memory","tags":["Muninn"]}
    blue: []
    grn : [a1b2c3d4 e5f6...]
    only in green (7): [...]
```

| Class | Cause to look for |
|---|---|
| `ORDER` | The ranking expression. Same rows, wrong sequence, **and not explained by score drift** — `diff.mjs` prints the pair and the separation that ruled a tie out. |
| `TIE` | Nothing. Same rows, sequence differs only among rows too close in composite score to have a stable order. Passing; excluded from the regression count; printed in its own section with the gaps. |
| `SKEW` | Nothing *about green*. Every id the two sides disagree about was written, updated or soft-deleted **while the captures were running**. **Void, not passing** — the run exits non-zero and the only remedy is to capture again. |
| `EXTRA+` | Blue's list continues past green's — the expansion signature. |
| `EXTRA` | Green over-filters: an extra `WHERE`, or one that drops NULLs. |
| `MISSING` | Green under-filters: a missing `WHERE`. `is_superseded = 0` is the classic. |
| `SET-DIFF` | Both. Fix the filters first, then re-run before touching ranking. |
| `ERR-BLUE` | Blue refused where green answered — a guard green does not implement. |
| `ERR-GREEN` | Green threw. Usually a real bug. |
| `ERR-BOTH` | Both refused. Counted as agreement. |
| `COUNT` | ids agree, recorded counts do not — a bug in a *capture* script. |

`diff.mjs` also reports **gaps that appear to have closed**: entries marked
`known-gap` that now match. Verify and promote them to `expect: "parity"`, or
they can silently reopen. An entry matching at `blue=0 green=0` is flagged
`matches TRIVIALLY` and must **not** be promoted — a gap that closed on a query
returning nothing has not been shown to close, only to be untested that day.

And it reports **tool-layer drift**, green against green: `tools.ts::recall`
clamps `n` with `Math.min(Math.max(Number(n) || 10, 1), 50)`, so `n=200` becomes
50 and `n=0` becomes **10** (because `0 || 10`). That is by design, but it means
the MCP tool answers a slightly different question than `search()` does, and it
should be visible rather than hidden behind a passing gate.

## Maintaining the golden set

Frozen means frozen. Adding probes is good; changing or removing an existing
`id` destroys the ability to compare against past runs.

- **Add** entries at the end of their group, with a `why` that says what
  divergence they probe. An entry nobody can interpret is noise, not coverage.
- **Never reuse** an `id`.
- **Promote** `known-gap` → `parity` when `diff.mjs` reports the gap closed.
- **Adding an FTS vector**: add `{"in": "..."}` to `src/fts-golden.json` and run
  `npm run harness:fts -- --write`. The inputs are read back out of that file
  and are never hardcoded in the regenerator — the file is the input registry as
  well as the output, so a curated adversarial case cannot be lost by someone
  retyping the list from memory.
- **If `regen-fts-vectors.py` reports a behaviour change**, blue's escaper moved.
  That is a *spec* change, not a test failure: update `escapeFts5` in
  `src/turso.ts` to match **before** rewriting the vectors, or the port has
  silently forked.
