"""
Run the frozen golden set through the FastMCP spike and write a snapshot
`diff.mjs` can read.

Deliberately produces the SAME record shape as `harness/blue.py` and
`harness/green.mjs` — `{id, ids, scores, count, error}` plus the run metadata
and `corpus_mutations` — so the existing gate scores this candidate with no
special-casing. The harness compares ACCESS PATHS, not implementations; that is
exactly what makes it reusable here.

READ THE README BEFORE READING A VERDICT. This capture drives blue's own Python.
Diffing it against blue compares blue to blue, so a pass is expected and is not
evidence about retrieval. What it can still catch is the transport and
serialization layer distorting results — reordering, truncation, a score coerced
to a string — which would show up as an ordinary diff.

    python capture.py                 # -> harness/snapshots/fastmcp.json
    node harness/diff.mjs --green=fastmcp.json
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastmcp import Client                                    # noqa: E402
from server import mcp, SCRIPTS, load_blue                    # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
QUERIES = ROOT / "harness" / "queries.json"
OUT = ROOT / "harness" / "snapshots" / "fastmcp.json"

#: Owned by the capture script, never by the query set — same list blue.py
#: reserves, and for the same reasons (raw shape; priority mutation).
RESERVED = {"raw", "auto_strengthen"}

def suppress_access_tracking(memory):
    """Neuter `_update_access_tracking`, exactly as `harness/blue.py` does.

    NOT optional, and the reason is subtle enough that the first version of this
    script got it wrong. `recall()` buffers `access_count += 1` for every row it
    returns, and `access_count` is a ranking input under `episodic=True`
    (`* (1.0 + ln(1.0 + access_count) * 0.2)`). A capture that leaves it live
    perturbs the very input it is measuring, and the side that runs second is
    scored against a corpus the first side moved. The `episodic-true` entry
    reordered by 4.7e-2 — three orders of magnitude past what score drift could
    explain — until this was added.

    Rebinding the module attribute catches every call site, including the one in
    the daemon thread, which is spawned after the rebind.
    """
    calls = {"n": 0}

    def _noop(memory_ids):
        calls["n"] += len(memory_ids or [])

    memory._update_access_tracking = _noop
    return calls


#: First-class tool arguments. Everything else in a query's `args` is blue
#: vocabulary that rides in `filters` — the §8 split, exercised for real rather
#: than asserted.
FIRST_CLASS = {"search", "query", "n", "tags", "type"}


def to_tool_args(args: dict) -> dict:
    """Translate a golden-set entry (blue's kwargs) into the tool's schema."""
    a = {k: v for k, v in args.items() if k not in RESERVED}
    out: dict = {}
    # queries.json uses `search` for the positional; the tool calls it `query`.
    text = a.pop("search", None)
    if text is None:
        text = a.pop("query", None)
    else:
        a.pop("query", None)
    if text is not None:
        out["query"] = text
    for k in ("n", "tags", "type"):
        if k in a:
            out[k] = a.pop(k)
    if a:
        out["filters"] = a
    return out


def mutation_columns_probe(turso, since_iso: str):
    """Same corpus-drift probe the other two capture scripts run.

    Without it `diff.mjs` cannot tell a concurrent write apart from a real
    divergence, and one `supersede()` reads as many independent failures.
    """
    cols = ("created_at", "updated_at", "deleted_at")
    where = " OR ".join(f"{c} >= ?" for c in cols)
    try:
        rows = turso._exec(
            f"SELECT id, created_at, updated_at, deleted_at FROM memories WHERE {where}",
            [since_iso] * len(cols),
        )
    except Exception as e:
        print(f"!! could not read corpus mutations: {str(e)[:120]}")
        return None
    return [
        {
            "id": r["id"],
            "at": max(x for x in (r["created_at"], r["updated_at"], r["deleted_at"]) if x),
            "kind": "created" if r["created_at"] >= since_iso
            else "deleted" if (r["deleted_at"] or "") >= since_iso
            else "updated",
        }
        for r in rows
    ]


async def main() -> int:
    if not (os.environ.get("TURSO_URL") and os.environ.get("TURSO_TOKEN")):
        print("TURSO_URL and TURSO_TOKEN must be set.", file=sys.stderr)
        return 2

    queries = json.loads(QUERIES.read_text())["queries"]
    import importlib
    _blue_memory = importlib.import_module(f"{SCRIPTS.name}.memory")
    track = suppress_access_tracking(_blue_memory)
    print(f"fastmcp: blue at {SCRIPTS}")
    print(f"fastmcp: {len(queries)} queries\n")

    records = []
    t0 = time.time()
    run_start = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    async with Client(mcp) as client:
        for q in queries:
            args = to_tool_args(q["args"])
            t = time.time()
            try:
                res = await client.call_tool("recall", args)
                rows = (res.structured_content or {}).get("memories", [])
                ids = [r["id"] for r in rows]
                # None, not 0.0 — the non-FTS `_query` path computes no composite
                # and diff.mjs must not tie-analyse a score that does not exist.
                scores = [r.get("composite_score") for r in rows]
                rec = {"id": q["id"], "ids": ids, "scores": scores,
                       "count": len(ids), "error": None}
                mark = "    "
            except Exception as e:
                rec = {"id": q["id"], "ids": None, "scores": None, "count": 0,
                       "error": f"{type(e).__name__}: {str(e).splitlines()[0][:160]}"}
                mark = "ERR "
            rec["ms"] = int((time.time() - t) * 1000)
            records.append(rec)
            print(f"{mark}{q['id']:<38} n={rec['count']:<4} {rec['ms']:>5}ms"
                  + (f"  {rec['error'][:70]}" if rec["error"] else ""))

    turso = importlib.import_module(f"{SCRIPTS.name}.turso")

    snapshot = {
        "side": "green",                      # scored in green's slot by diff.mjs
        "source": "spike/fastmcp-python — FastMCP 4 wrapping remembering/scripts",
        "captured_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "elapsed_s": round(time.time() - t0, 1),
        "run_started_at": run_start,
        "corpus_mutations": mutation_columns_probe(turso, run_start),
        "access_tracking_suppressed": True,
        "access_bumps_suppressed": track["n"],
        "query_count": len(records),
        "records": records,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    errs = sum(1 for r in records if r["error"])
    ms = sorted(r["ms"] for r in records)
    print(f"\nwrote {OUT}")
    print(f"{len(records)} captured, {errs} errored, {snapshot['elapsed_s']}s")
    print(f"latency ms: min={ms[0]} median={ms[len(ms)//2]} max={ms[-1]}")
    print(f"suppressed {track['n']} access_count bumps")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
