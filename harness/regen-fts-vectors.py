#!/usr/bin/env python3
"""
Regenerate src/fts-golden.json from the live Python.

    python3 harness/regen-fts-vectors.py            # check only, exit 1 on drift
    python3 harness/regen-fts-vectors.py --write    # rewrite the file

NO CREDENTIALS NEEDED. `_escape_fts5_server` is a pure string function; this
script never opens a connection. That makes it the one part of the harness that
runs anywhere, and therefore the one part that can be wired into CI today.

------------------------------------------------------------------ WHY IT EXISTS

src/fts-golden.json holds 33 vectors that were produced by RUNNING BLUE. That is
what makes turso.test.ts a parity test and not a unit test: the expectations are
blue's actual behaviour, frozen, rather than a second author's opinion of what
blue does.

Until now nothing in this repo could reproduce them. A frozen artefact with no
regenerator is not frozen, it is ABANDONED — blue's escaper could change and the
vectors would keep asserting the old behaviour, and green would keep passing
against a spec that had moved. This closes that loop.

--------------------------------------------------------------- THE INPUT SET

The inputs are read back OUT of the existing file and never hardcoded here.

That is the important design decision. The 33 inputs are a curated adversarial
set — every FTS5 special char, every keyword operator in both cases, empty and
whitespace-only strings, tab and newline, CJK, emoji, accented Latin, a
backslash, a percent sign, an apostrophe inside a word. Recreating that list
from memory would quietly lose cases, and losing a case looks exactly like
passing. So the file is the input registry as well as the output; adding a
vector means adding an `{"in": ...}` entry and re-running with --write.

--------------------------------------------------------------- THE FORMAT

Byte-for-byte reproduction of the existing file is a HARD requirement, and it is
also this script's self-test: if the bytes match for unchanged inputs, then the
import path, the function and the serializer are all correct, and any future
diff is a real behaviour change rather than a formatting artefact.

The format is `json.dumps(..., indent=1, ensure_ascii=False)` plus a trailing
newline. Both non-defaults are load-bearing:

  indent=1        the file was generated that way; indent=2 (the obvious guess)
                  rewrites all 33 entries and buries the one real change.
  ensure_ascii    the file stores literal 'café', '日本語', '🐦'. With the
    =False        default True those become \\uXXXX escapes and the diff is
                  total. It also matters semantically: the vectors are there to
                  prove non-ASCII survives the escaper intact, which is hard to
                  read through escapes.

Verified: this script reproduces the committed file exactly, 1899 characters /
1919 bytes, for the current input set.
"""

import importlib
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN = HERE.parent / "src" / "fts-golden.json"

DEFAULT_SCRIPTS = "/home/user/muninn-utilities/remembering/scripts"
SCRIPTS = Path(os.environ.get("MUNINN_SCRIPTS", DEFAULT_SCRIPTS)).resolve()


def load_escaper():
    """Import blue's escaper.

    Same package dance as blue.py: `scripts/` uses relative imports, so the
    PARENT goes on sys.path and the directory name is the package name.

    We import `scripts.turso` rather than `scripts` — the package __init__ pulls
    in memory, config, result, aliases and hints, none of which this needs, and
    memory.py registers an atexit flush hook on import. For a script that only
    wants one pure string function, the narrower import is the honest one.
    """
    if not SCRIPTS.is_dir():
        sys.exit(f"MUNINN_SCRIPTS does not exist: {SCRIPTS}")
    sys.path.insert(0, str(SCRIPTS.parent))
    turso = importlib.import_module(f"{SCRIPTS.name}.turso")
    return turso._escape_fts5_server


def render(vectors):
    """Serialize in the committed file's exact format. See module docstring."""
    return json.dumps(vectors, indent=1, ensure_ascii=False) + "\n"


def main():
    write = "--write" in sys.argv[1:]

    if not GOLDEN.is_file():
        sys.exit(f"Missing {GOLDEN} — this script regenerates it, it does not create it "
                 f"from nothing (the input set lives in the file).")
    original = GOLDEN.read_text(encoding="utf-8")
    existing = json.loads(original)

    escape = load_escaper()

    # Inputs come from the file; only the outputs are recomputed. An entry with
    # no "out" is legal — that is how you add a new vector: write the input,
    # run --write, review what blue says.
    vectors = [{"in": v["in"], "out": escape(v["in"])} for v in existing]
    rendered = render(vectors)

    changed = [
        (v["in"], v.get("out"), n["out"])
        for v, n in zip(existing, vectors)
        if v.get("out") != n["out"]
    ]

    print(f"blue:      {SCRIPTS}")
    print(f"golden:    {GOLDEN}")
    print(f"vectors:   {len(vectors)}")

    if rendered == original:
        print("\nIDENTICAL — blue reproduces the committed file byte for byte.")
        print("The vectors are live, not abandoned.")
        return 0

    if changed:
        print(f"\nBEHAVIOUR CHANGED on {len(changed)} vector(s):")
        for inp, old, new in changed:
            print(f"  in : {inp!r}")
            print(f"  was: {old!r}")
            print(f"  now: {new!r}")
        print("\nThis means blue's _escape_fts5_server has changed. That is a SPEC")
        print("change, not a test failure: green's escapeFts5 in src/turso.ts must be")
        print("updated to match BEFORE these vectors are rewritten, or the port has")
        print("silently forked. Confirm the Python change was intentional first.")
    else:
        print("\nOnly the SERIALIZATION differs — the outputs are unchanged.")
        print("Something is off in render(); see the format notes in this file's")
        print("docstring (indent=1, ensure_ascii=False, trailing newline).")
        print(f"  committed: {len(original)} chars   regenerated: {len(rendered)} chars")

    if write:
        GOLDEN.write_text(rendered, encoding="utf-8")
        print(f"\nWROTE {GOLDEN}")
        print("Now run `npm test` — turso.test.ts asserts green against these vectors,")
        print("so a rewrite that green does not match will fail there, loudly, which")
        print("is the whole point.")
        return 0

    print("\nRe-run with --write to update the file.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
