"""
Muninn MCP on FastMCP 4 — a SPIKE, not a deployment.

WHAT THIS IS FOR
----------------
`docs/mcp-migration.md` §5 Stage 5 says the migration is only worth doing if it
ends with ONE implementation. Today there are two: blue's Python
(`remembering/scripts/`) and green's TypeScript (`../../src/`). The parity
harness exists because of that duplication.

This spike asks whether the duplication can simply not happen: run blue's own
Python behind an MCP endpoint, so green IS blue.

`remembering/scripts/provenance.py` already anticipates exactly this — its
`MUNINN_WRITE_SOURCE` override exists so "the Python path imports
`remembering/scripts` unmodified whether it is in a session container or behind
an MCP endpoint". This file is the first thing to take it up on that.

WHAT A PASS PROVES, AND WHAT IT DOES NOT
----------------------------------------
Running the parity harness against this compares blue to blue. **A trivial pass
is the expected result and is not evidence about retrieval.** That is the point:
if green is blue, retrieval parity is free rather than earned.

What it does prove, none of which is free:

  1. FastMCP 4 beta + `remembering/scripts` actually run together — imports,
     env, `requests`, the lot.
  2. The transport and serialization layer does not DISTORT results. The tool
     returns structured content; the harness reads ids and composite scores back
     out of it. Any reordering, truncation or coercion shows up as a real diff.
  3. What leaving the edge costs. Latency is recorded per query; that number,
     not the verdict, is the interesting output.

READ-ONLY, LIKE GREEN
---------------------
Stage 1 is read-only by construction, and this spike honours it: no write tool
exists here. `MUNINN_WRITE_SOURCE` is still set, because the point of setting it
is that it is already correct on the day a write tool is added.
"""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path
from typing import Any

from fastmcp import FastMCP

# --------------------------------------------------------------------- blue

#: Where blue lives. Same default as `harness/blue.py`, same override name, so
#: the spike and the gate can never be pointed at different checkouts by
#: accident.
DEFAULT_SCRIPTS = "/home/user/muninn-utilities/remembering/scripts"
SCRIPTS = Path(os.environ.get("MUNINN_SCRIPTS", DEFAULT_SCRIPTS)).resolve()

#: Stamp every write this deployment makes as its own writer (§5 Stage 0). No
#: write tool exists yet; setting it now means the first one added is already
#: attributable, rather than needing someone to remember on the day.
os.environ.setdefault("MUNINN_WRITE_SOURCE", "mcp-fastmcp-spike@0.1.0")


def load_blue():
    """Import `remembering/scripts` as a package.

    It uses relative imports (`from . import state`), so it must be imported AS
    a package — the parent goes on the path and the package name is derived from
    the directory, exactly as `harness/blue.py` does it. Keeping the two loaders
    identical is deliberate: a spike that imports blue differently from the gate
    is not testing the same thing the gate tests.
    """
    if not SCRIPTS.is_dir():
        raise SystemExit(
            f"MUNINN_SCRIPTS does not exist: {SCRIPTS}\n"
            f"Point it at a remembering/scripts directory."
        )
    sys.path.insert(0, str(SCRIPTS.parent))
    pkg = SCRIPTS.name
    return (
        importlib.import_module(f"{pkg}.memory"),
        importlib.import_module(f"{pkg}.boot"),
        importlib.import_module(f"{pkg}.config"),
    )


_memory, _boot, _config = load_blue()

mcp = FastMCP(
    name="muninn-fastmcp-spike",
    version="0.1.0",
    instructions=(
        "Muninn's memory, served by blue's own Python. Read-only spike — "
        "see spike/fastmcp-python/README.md before believing anything it says."
    ),
)

# --------------------------------------------------------------------- tools


def _rows(results: Any) -> list[dict]:
    """Normalise blue's return into plain dicts.

    `recall()` hands back MemoryResult wrappers unless `raw=True`. The harness
    needs `composite_score`, which only the FTS5 path computes — rows off the
    non-FTS `_query` path legitimately have none, and must surface as null
    rather than as a fabricated number, or `diff.mjs` would tie-analyse a score
    that does not exist.
    """
    out = []
    for r in results or []:
        d = dict(r) if not isinstance(r, dict) else r
        out.append(
            {
                "id": d.get("id"),
                "summary": d.get("summary"),
                "type": d.get("type"),
                "tags": d.get("tags"),
                "confidence": d.get("confidence"),
                "priority": d.get("priority"),
                "t": d.get("t"),
                "composite_score": d.get("composite_score"),
            }
        )
    return out


@mcp.tool
def recall(
    query: str | None = None,
    n: int = 10,
    tags: list[str] | None = None,
    type: str | None = None,
    filters: dict | None = None,
) -> dict:
    """Search memories by text and tags.

    Mirrors green's narrow schema (§8): the four arguments that carry nearly
    every call are first-class, and the remaining fifteen of blue's nineteen
    ride in `filters` rather than in the tool schema. Full parameter list:
    `muninn://reference/recall`.
    """
    kwargs: dict[str, Any] = dict(filters or {})
    kwargs.update(n=n, raw=True)
    if tags:
        kwargs["tags"] = tags
    if type:
        kwargs["type"] = type
    # `auto_strengthen` mutates priority — a permanent ranking change. The gate
    # forces it off for that reason and so does this; a read must not move the
    # thing it is reading.
    kwargs["auto_strengthen"] = False
    return {"memories": _rows(_memory.recall(query, **kwargs))}


@mcp.tool
def memory_get(id: str) -> dict:
    """One memory by id. Accepts a unique id prefix, as blue does."""
    return {"memory": _rows([_memory.get(id, raw=True)])[0] if _memory.get(id, raw=True) else None}


@mcp.tool
def muninn_config(op: str = "list", key: str | None = None) -> dict:
    """The profile / ops / journal config store. `op`: list | get | profile | ops."""
    if op == "get" and key:
        return {"value": _config.config_get(key)}
    if op == "profile":
        return {"entries": _boot.profile()}
    if op == "ops":
        return {"entries": _boot.ops()}
    return {"entries": _config.config_list()}


@mcp.tool
def boot() -> str:
    """The composed boot payload — identity, profile, ops, recent memories."""
    return _boot.boot()


if __name__ == "__main__":
    # `http_app()` is what the container serves; `run()` is for local poking.
    mcp.run(transport="http", host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
