#!/usr/bin/env python3
"""
BLUE capture — run the frozen golden query set through the live Python.

Blue is `remembering/scripts/` from muninn-utilities: `memory.py::recall` sitting
on `turso.py::_fts5_search`. It is the SPECIFICATION, not a competing
implementation. Everything this script does is in service of writing down what
blue answered, as neutrally as possible, so `diff.mjs` can hold green to it.

    TURSO_URL=... TURSO_TOKEN=... python3 harness/blue.py

Writes harness/snapshots/blue.json. Exit 0 on a clean capture, 2 if credentials
are missing, 1 if the query set itself is unreadable.

--------------------------------------------------------------------- WHAT WE
--------------------------------------------------------------------- COMPARE

We record ID ORDER, and — since the near-tie fix — THE COMPOSITE SCORE THAT
PRODUCED IT. Nothing else. No row contents.

Row contents are not comparable, because two of the columns are written BY THE
ACT OF READING: `access_count` and `last_accessed` are bumped on every recall.
A row-level diff of two captures taken minutes apart would fail on every row for
reasons that have nothing to do with the port.

Order IS the assertion — docs/mcp-migration.md §5 asks for "identical id-order
on ranked recalls", and a set comparison would pass a fully-inverted ranking.
So: ids, in order. Nothing sorted, nothing truncated, nothing deduplicated.

--------------------------------------------------------------------- WHY THE
--------------------------------------------------------------------- SCORES

`composite_score` is NOT an assertion. It is EVIDENCE ABOUT THE ASSERTION, and
it is recorded for exactly one purpose: to let `diff.mjs` tell a near-tie
reordering apart from a ranking regression.

The score contains `julianday('now')`. It is evaluated server-side at query
time, so blue and green get different values for the same row simply by running
at different instants — and, crucially, rows of DIFFERENT AGES DRIFT AT
DIFFERENT RATES, because the recency factor is
`1.0 / (1.0 + (julianday('now') - julianday(m.t)) * 0.01)`. Two rows whose
scores differ in the sixth decimal place can therefore cross over between
blue's capture and green's — or between two runs of the same side.

An earlier version of this file argued that "the RANKING is stable under that
(the recency factor is monotone in `t` and applies uniformly)". That is wrong,
and the harness caught it: the factor is monotone in `t`, but its DERIVATIVE
with respect to wall-clock time is not uniform across rows, so the induced
order is not stable. Ids alone cannot distinguish "these two rows are a
0.0004%-apart tie that drifted" from "green's ranking expression is wrong".
The score can. See the epsilon derivation in `diff.mjs`.

NOT EVERY ROW HAS ONE. `composite_score` is computed only on the FTS5 path
(`turso.py::_fts5_search`). Blue's other path — `memory.py::_query`, reached by
`strict=True`, `fetch_all=True`, or any falsy `search` — is a plain
`SELECT * FROM memories ... ORDER BY t DESC` with no ranking expression at all,
so those rows carry NO score and we record `null`. That is not a gap to paper
over: those queries are not ranked by composite, so composite gaps could not
explain a reordering in them anyway, and `diff.mjs` refuses to call them ties.

------------------------------------------------------------------- SIDE
------------------------------------------------------------------- EFFECTS

Blue's reads are NOT side-effect-free, and this matters more than it sounds.

  1. `recall()` fires `_update_access_tracking()` on a daemon thread for every
     row it returns. That buffers +1 per id and flushes to Turso at 50 entries
     or at process exit (memory.py's atexit hook).
  2. `access_count` is a RANKING INPUT under `episodic=True`:
     `* (1.0 + ln(1.0 + COALESCE(m.access_count, 0)) * 0.2)`.
  3. Therefore running the harness changes the answer the harness will get next
     time. A gate that perturbs its own inputs is not a gate.

The database is single-homed (§4) — blue and green hit the SAME rows — so this
is not a "blue's copy drifts" problem, it is a "the corpus moves under both of
you, unevenly" problem. Whoever runs first pays for the second.

We handle it in two ways, and you should understand both:

  * `auto_strengthen` is FORCED to False. Blue's auto_strengthen bumps
     `priority` on the top 3 results, and priority is in the composite for BOTH
     modes: `* (1.0 + COALESCE(m.priority, 0) * 0.3)`. That is a permanent
     ranking mutation, not a soft one. It is never appropriate for a harness.

  * Access tracking is NEUTERED BY DEFAULT (see `_suppress_access_tracking`).
     This does not change what THIS run returns — tracking happens after the
     rows are chosen — it only stops this run from moving the next one. Set
     MUNINN_HARNESS_TRACK_ACCESS=1 to restore production behaviour if you are
     deliberately measuring the tracking path.

Even neutered, the corpus is live: someone can `remember()` between your blue
and green captures. Capture the two back to back. `captured_at` is written into
both snapshots so `diff.mjs` can tell you how far apart they were.
"""

import importlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
QUERIES = HERE / "queries.json"
OUT = HERE / "snapshots" / "blue.json"

# Blue lives outside this repo. Default to the checkout muninn-utilities uses in
# a session; override for a different checkout or for the /mnt/skills mount.
DEFAULT_SCRIPTS = "/home/user/muninn-utilities/remembering/scripts"
SCRIPTS = Path(os.environ.get("MUNINN_SCRIPTS", DEFAULT_SCRIPTS)).resolve()

# Args the query set is not allowed to set, because this script owns them.
# `raw` because we want plain dicts, not MemoryResult wrappers; auto_strengthen
# because of the priority mutation described above.
RESERVED = ("raw", "auto_strengthen")


# ---------------------------------------------------------------- corpus drift

#: Columns whose value moving means a row changed identity for retrieval
#: purposes. `deleted_at` is the one that matters most and the least obvious:
#: `supersede()` soft-deletes the original WITHOUT touching `updated_at`, so a
#: watermark built only on created_at/updated_at misses exactly the mutation
#: that reorders results.
MUTATION_COLUMNS = ("created_at", "updated_at", "deleted_at")


def corpus_mutations(turso, since_iso: str) -> list:
    """Ids of memories that changed at or after `since_iso`.

    The gate diffs two captures of a LIVE corpus. If anything writes between
    blue's first query and green's last, the two sides answer different
    questions and every affected entry reads as a green regression — which is
    how a single `supersede()` can present as thirteen independent failures.

    Recording the mutated ids at capture time lets `diff.mjs` prove that class
    apart from a real one without needing credentials of its own.

    Timestamps are ISO-8601 UTC with a `Z` suffix, so lexicographic comparison
    is chronological.
    """
    where = " OR ".join(f"{c} >= ?" for c in MUTATION_COLUMNS)
    try:
        rows = turso._exec(
            f"SELECT id, created_at, updated_at, deleted_at FROM memories WHERE {where}",
            [since_iso] * len(MUTATION_COLUMNS),
        )
    except Exception as e:                                  # never fail a capture
        print(f"!! could not read corpus mutations: {str(e)[:120]}")
        return None
    return [
        {"id": r["id"],
         "at": max(x for x in (r["created_at"], r["updated_at"], r["deleted_at"]) if x),
         "kind": "created" if r["created_at"] >= since_iso
                 else "deleted" if (r["deleted_at"] or "") >= since_iso
                 else "updated"}
        for r in rows
    ]


def load_blue():
    """Import blue as a package.

    `scripts/` uses relative imports (`from . import state`), so it must be
    imported AS a package — a bare `sys.path.insert(SCRIPTS)` plus
    `import memory` fails on the first relative import. The idiom the
    remembering test suite uses is to put the PARENT on the path and import
    `scripts.memory`; we do the same but derive the package name from the
    directory so a differently-named checkout still works.
    """
    if not SCRIPTS.is_dir():
        die(2, f"MUNINN_SCRIPTS does not exist: {SCRIPTS}\n"
               f"Point it at a remembering/scripts directory.")
    sys.path.insert(0, str(SCRIPTS.parent))
    pkg = SCRIPTS.name
    try:
        memory = importlib.import_module(f"{pkg}.memory")
        turso = importlib.import_module(f"{pkg}.turso")
    except ImportError as e:
        die(2, f"Could not import blue from {SCRIPTS}: {e}\n"
               f"Expected a Python package (an __init__.py alongside memory.py).")
    return memory, turso


def _suppress_access_tracking(memory):
    """Replace `_update_access_tracking` with a no-op.

    Both `recall()` and `_query()` call this by MODULE-GLOBAL name, so rebinding
    the attribute on the module intercepts every call site — including the one
    inside the daemon thread, which is spawned after the rebind.

    This is the least invasive point to cut. Patching `_exec` would also stop
    the writes but would break the reads; patching `_flush_access_tracking`
    alone would leave the in-process buffer growing and still flush at exit.
    """
    calls = {"n": 0}

    def _noop(memory_ids):
        calls["n"] += len(memory_ids or [])

    memory._update_access_tracking = _noop
    return calls


def die(code, msg):
    print(f"\n{msg}\n", file=sys.stderr)
    sys.exit(code)


def score_of(row):
    """Pull `composite_score` off a raw row, or None if this path has none.

    Deliberately total: it never raises and never invents a value. A missing or
    unparseable score becomes None, and `diff.mjs` treats a None anywhere in a
    record as "this record cannot be tie-analysed" rather than as a zero. A
    fabricated 0.0 here would be worse than useless — 0.0 sits in the middle of
    the real range (composite is NEGATIVE, because bm25() is), so it would look
    like a plausible score and could silently license a bogus TIE verdict.

    Rows from `_fts5_search` always have it. Rows from `_query` never do; see
    the module docstring.
    """
    v = row.get("composite_score")
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def one_line(s, limit=400):
    """Errors are compared and printed inline, so flatten them.

    Blue's credential errors in particular are multi-line instruction blocks;
    left raw they wreck the diff table for no benefit.
    """
    return " ".join(str(s).split())[:limit]


def main():
    if not QUERIES.is_file():
        die(1, f"Missing query set: {QUERIES}")
    spec = json.loads(QUERIES.read_text(encoding="utf-8"))
    queries = spec["queries"]

    if "--dry-run" in sys.argv[1:]:
        # Print the calls without connecting. The point is to confirm the query
        # set is legal against THIS checkout of blue before spending a live
        # capture on it: a kwarg that was renamed or removed upstream shows up
        # here as a TypeError-in-waiting rather than as 64 identical failures.
        memory, _ = load_blue()
        import inspect

        sig = inspect.signature(memory.recall)
        accepted = set(sig.parameters)
        print(f"blue --dry-run: {SCRIPTS}\n")
        bad = 0
        for q in queries:
            args = {k: v for k, v in q["args"].items() if k not in RESERVED}
            unknown = sorted(set(args) - accepted)
            call = ", ".join(f"{k}={v!r}" for k, v in args.items())
            print(f"{q['id']}\n  recall({call}, raw=True, auto_strengthen=False)")
            if unknown:
                bad += 1
                print(f"  !! blue's recall() does not accept: {unknown}")
            print("")
        print(f"{len(queries)} queries, {bad} with unknown kwargs")
        return 1 if bad else 0

    memory, turso = load_blue()

    # Fail EARLY and LEGIBLY on missing credentials. Without this, every one of
    # the 64 queries would independently retry with backoff and then record the
    # same credential error, turning a 1-second config mistake into a multi-
    # minute run and a snapshot that looks like 64 distinct failures.
    try:
        turso._init()
    except Exception as e:
        die(2, "TURSO CREDENTIALS NOT SET — nothing was captured.\n\n"
               f"  {one_line(e, 600)}\n\n"
               "Blue looks for TURSO_URL and TURSO_TOKEN in the environment, then in\n"
               "/mnt/project/turso.env, /mnt/project/muninn.env, ~/.muninn/.env.\n"
               "Green (harness/green.mjs) reads the same two variable names, so one\n"
               "export drives both sides.")

    track = None
    if os.environ.get("MUNINN_HARNESS_TRACK_ACCESS") == "1":
        print("!! access tracking LEFT ON — this run will mutate access_count "
              "and perturb episodic ranking for the next run.")
    else:
        track = _suppress_access_tracking(memory)

    print(f"blue: {SCRIPTS}")
    print(f"blue: {len(queries)} queries\n")

    records = []
    t_start = time.time()
    run_start = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for q in queries:
        args = dict(q["args"])
        for r in RESERVED:
            if r in args:
                print(f"!! {q['id']}: dropping reserved arg {r!r} — blue.py owns it")
                args.pop(r)

        t0 = time.time()
        try:
            rows = memory.recall(raw=True, auto_strengthen=False, **args)
            # raw=True gives plain dicts. Take ids in the order returned; do not
            # sort, do not dedupe — blue's expansion merge CAN in principle
            # surface the same id twice and we want to see that if it happens.
            ids = [str(r["id"]) for r in rows]
            # Parallel to `ids`, same length, same order. Kept as a SEPARATE
            # array rather than a list of {id, score} objects so that every
            # existing consumer of `.ids` keeps working untouched — the gate's
            # sequence comparison is the load-bearing part and this change must
            # not be able to break it.
            scores = [score_of(r) for r in rows]
            rec = {"id": q["id"], "ids": ids, "scores": scores,
                   "count": len(ids), "error": None}
        except Exception as e:
            # Refusals are part of the contract: recall("*") raises ValueError on
            # purpose. `ids: null` distinguishes "refused" from "returned zero".
            rec = {"id": q["id"], "ids": None, "scores": None, "count": 0,
                   "error": f"{type(e).__name__}: {one_line(e)}"}
        rec["ms"] = int((time.time() - t0) * 1000)
        records.append(rec)

        mark = "ERR " if rec["error"] else "    "
        # "no-score" is worth surfacing at capture time, not just in the diff:
        # it is the visible signature of blue having taken the non-FTS _query
        # path for this entry, which is itself a fact about the query shape.
        noscore = "" if rec["ids"] is None or not rec["ids"] or all(
            s is not None for s in rec["scores"]) else "  [no composite_score — non-FTS _query path]"
        print(f"{mark}{q['id']:<28} n={rec['count']:<4} {rec['ms']:>5}ms"
              + (f"  {rec['error'][:80]}" if rec["error"] else "") + noscore)

    snapshot = {
        "side": "blue",
        "source": str(SCRIPTS),
        "captured_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "elapsed_s": round(time.time() - t_start, 1),
        # Recorded so a reader of an old snapshot knows whether that capture
        # moved the corpus. A snapshot with this true is not reproducible.
        "access_tracking_suppressed": track is not None,
        "access_bumps_suppressed": track["n"] if track else None,
        "query_count": len(records),
        # Rows the corpus changed while this capture was running. diff.mjs uses
        # these to tell "the corpus moved under us" apart from "green is wrong".
        "run_started_at": run_start,
        "corpus_mutations": corpus_mutations(turso, run_start),
        "records": records,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n",
                   encoding="utf-8")

    errs = sum(1 for r in records if r["error"])
    unscored = sum(1 for r in records
                   if r["ids"] and any(s is None for s in r["scores"]))
    print(f"\nwrote {OUT}")
    print(f"{len(records)} captured, {errs} errored, {snapshot['elapsed_s']}s")
    if unscored:
        print(f"{unscored} record(s) carry no composite_score (blue's non-FTS "
              f"_query path); diff.mjs will not tie-analyse those.")
    if track:
        print(f"suppressed {track['n']} access_count bumps "
              f"(set MUNINN_HARNESS_TRACK_ACCESS=1 to allow them)")
    # A capture always exits 0 if it captured. Errored queries are DATA — blue
    # refusing recall("*") is the expected answer for that entry, and diff.mjs
    # is the only thing entitled to call the run a failure.
    return 0


if __name__ == "__main__":
    sys.exit(main())
