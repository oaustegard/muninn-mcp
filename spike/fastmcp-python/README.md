# Spike: Muninn MCP on FastMCP 4

**A spike, not a deployment.** It exists to answer one question with evidence
instead of argument:

> `docs/mcp-migration.md` §5 Stage 5 says the migration is only worth doing if it
> ends with **one** implementation. Can green simply *be* blue — blue's own
> Python behind an MCP endpoint — instead of a second implementation that a
> parity harness has to keep honest?

`remembering/scripts/provenance.py` already anticipated this: its
`MUNINN_WRITE_SOURCE` override exists so "the Python path imports
`remembering/scripts` unmodified whether it is in a session container or behind
an MCP endpoint." This is the first thing to take it up on that.

## Result

```
node harness/diff.mjs --green=fastmcp.json

  74 queries | 74 matched | 0 near-tie | 0 regressions | 0 declared gaps still open
  PASS
```

Against the TypeScript green's **67/74 with 7 declared gaps still open**.

**A trivial pass was the expected outcome and is not evidence about retrieval.**
Diffing this against blue compares blue to blue. That is the finding, not a flaw
in it: if green is blue, retrieval parity is free rather than earned.

What the run does establish, none of which was free:

| | |
|---|---|
| FastMCP 4 beta + `remembering/scripts` actually run together | yes — `fastmcp 4.0.0b3`, `mcp 2.0.0` |
| Transport/serialization does not distort results | yes — ids and composite scores survive the round trip intact |
| Every gap the TS port declared open | **all 9 closed**, for free |
| Cost of leaving the edge | ~11× median latency (below) |

### The nine gaps close because they stop being gaps

`strict`, `fetch_all`, `exploration`, the `recall("*")` wildcard guard and the
four expansion entries were all `known-gap` against TypeScript — each one a
behaviour someone would have had to port. Here they are just blue's behaviour.
`mode-exploration` is the sharpest case: the harness README calls it "the one
ranking behaviour that is NOT server-side SQL and therefore not free to port."
It costs nothing here.

### Latency is the real trade, and FastMCP is not what costs

| side | total | median | p90 | max |
|---|---|---|---|---|
| blue (Python, direct) | 101.4s | 519ms | 2046ms | 11036ms |
| green (TypeScript) | 17.2s | **50ms** | 266ms | 986ms |
| fastmcp (Python via MCP) | 115.3s | 547ms | 2408ms | 12999ms |

**FastMCP adds ~5%** over calling blue directly (547ms vs 519ms). The ~11× gap
against TypeScript is *blue's Python* — `requests`, a per-query HTTP round trip,
the retry wrapper — not the framework and not the container.

That cuts both ways, and the second way is easy to miss: because green would be
blue, optimising `turso.py` once makes **both** faster. Under the two-implementation
plan, the same optimisation has to be done twice and kept in step.

## Two findings that outlived the experiment

**1. `requests` rules out Python Workers.** `remembering/scripts/__init__.py`
imports `requests` at module load. It is not available under Pyodide, so this
cannot be a Python Worker — it must be a Container (GA April 2026), the same
conclusion Sage reached for its Go app. Migrating `turso.py` to `httpx` would
reopen the Worker option; nothing else in blue appears to block it.

**2. The gate cannot assert ordering on expansion-triggering queries — by either
implementation.** Before the access-tracking fix below, three sparse entries
(`conf-sparse`, `fts-embedded-quote`, `fts-all-specials`) came back `ORDER`
in a **blue-vs-blue** comparison. Diagnosis, in the order it was ruled out:

- Not hash randomisation. Blue returns identical order across
  `PYTHONHASHSEED=0..3`, so muninn-utilities#100's `sorted()` fix holds.
- Not within-process instability. Four consecutive calls in one process agree.
- It varies with *run context* — the same query returns a different order
  depending on what ran before it in that process.

The TIE classifier cannot excuse any of it, because expansion rows carry no
`composite_score` and the classifier (correctly) refuses to tie-analyse a score
that does not exist. So these entries are structurally un-assertable. They agree
when both sides are captured back to back under identical suppression, which is
why the run above passes — but that is agreement by protocol, not by property.
Worth knowing before anyone reads an expansion `ORDER` as a real regression.

**Ordinary bug, recorded because it is the trap the harness README warns about:**
the first `capture.py` did not neuter `_update_access_tracking`, so it bumped
`access_count` — a ranking input under `episodic=True` — while measuring it.
`episodic-true` reordered by 4.7e-2, three orders of magnitude past what score
drift could explain. `blue.py` has suppressed this from the start; now so does
this. Both sides report `suppressed 968 access_count bumps`, which is also a
cheap cross-check that they drive the same code paths.

## Running it

```bash
pip install --pre -r requirements.txt      # fastmcp 4.0.0b3 + requests
export TURSO_URL=... TURSO_TOKEN=...
export MUNINN_SCRIPTS=/path/to/muninn-utilities/remembering/scripts   # optional

npm run harness:blue                       # capture blue, from the repo root
python capture.py                          # -> harness/snapshots/fastmcp.json
node harness/diff.mjs --green=fastmcp.json
```

Capture the two **back to back**, for the reason `harness/README.md` gives: the
corpus is live, and a `supersede()` landing between them voids the run.

`--green=` / `--blue=` are new. The gate scores an *access path*, not a
particular implementation, so which file plays green is an argument rather than
a constant — which is what let this candidate be scored with no special-casing.

## What is NOT here

- **No write tools.** Stage 1 is read-only by construction and the spike honours
  it. `MUNINN_WRITE_SOURCE` is set anyway, so the first write tool added is
  attributable on day one rather than when someone remembers.
- **No deployment.** The `Dockerfile` builds the shape the decision implies;
  nothing has run it on Cloudflare. Cold-start and per-request cost in a real
  Container are **unmeasured** — the latency table above is in-process, and
  in-process is the *best* case.
- **No auth.** The real server needs the OAuth surface `src/mcp-oauth.ts`
  already implements. FastMCP 4 ships CIMD, which is where the 2026-07-28 spec
  points now that DCR is deprecated; that is a reason to look, not a result.
- **No resources.** The §8 progressive-disclosure layer (`muninn://reference/*`,
  `muninn://utilities/{name}`, the `muninn_docs` fallback door) exists only in
  the TypeScript. Porting it is real work this spike did not do.
- **No boot byte-equality check.** `src/boot.ts` is a byte-equal port of
  `_format_boot_output`; here `boot()` *is* that function, so byte-equality is
  definitional — but nothing asserts it, and the harness covers `recall` only.

## The decision this informs

Not "which framework is nicer." The question is whether **the write path** gets
ported a second time.

The TS port covers reads, and covers them well. Stage 3 needs `remember`,
`supersede`, `forget`, `reprioritize`, `strengthen`, `weaken`, `config_set` and
`journal` — plus their invariants: the `is_superseded`-vs-`refs` distinction
v5.7.0 had to fix, `read_only` config enforcement, and the supersede soft-delete
semantics that voided a harness run the day this spike was written. That is a
second port as large as the first, and every bug in it is a *data* bug. A wrong
ranking is embarrassing; a wrong write is not recoverable.

This spike says that port is optional.
