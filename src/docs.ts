/**
 * The progressive-disclosure layer: docs/mcp-migration.md §8.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Tool *count* is the obvious budget; tool *width* is the bigger one. `recall()`
 * takes 19 parameters. Rendered as JSON Schema with honest descriptions that is
 * roughly 2k tokens for ONE tool, re-sent in every conversation on the connector
 * whether or not the tool is ever called. Ten tools at that width spend the
 * entire budget before the user has said anything.
 *
 * So the schemas stay narrow and the rest of the surface moves here, to be read
 * on demand. Layer 0 is the tool schema; layer 1 is this content, addressed as
 * `muninn://` resources; layer 2 is the utility dispatcher.
 *
 * TWO DOORS, ONE IMPLEMENTATION
 * -----------------------------
 * §8 caveat 2 is the reason this module is transport-shaped rather than
 * resource-shaped. Resource auto-read is NOT guaranteed, and it varies by
 * exactly the surfaces §7 is worried about: Claude Code exposes generic
 * list/read tools so resources work well, while claude.ai connectors have
 * historically surfaced resources as user-attachable content rather than
 * something the model reads on its own. Since cross-surface robustness is the
 * whole argument for the migration, the action path must not depend on resource
 * support.
 *
 * Hence: every topic here is served BOTH as a `muninn://` resource AND through
 * the `muninn_docs(topic)` tool, from this one registry. Clients with resource
 * support use the resource; clients without use the tool. Neither is a fallback
 * bolted on later — they are the same rows.
 *
 * WHY THE CONTENT IS GENERATED, NOT FETCHED
 * -----------------------------------------
 * The source of truth for all of it lives in `muninn-utilities`: `references/`,
 * `SKILL.md`, `use_when.json`, `manifests/`. A Worker has no filesystem and
 * fetching another repo at request time would put a network hop and an outage
 * mode in front of a static document. So `scripts/build-docs.mjs` reads those
 * sources and emits `docs-generated.ts`, which is committed.
 *
 * That also settles §9 decision 13 ("are the manifests the resource payload, or
 * a build input?") in favour of build input — and not on taste. Manifests are
 * versioned per-utility with v0.3 and v0.4 both live; serving them directly
 * would couple this layer to manifest versioning forever. The Worker runtime
 * forces the better answer.
 */

import {
  REFERENCE_DOCS,
  UTILITY_INDEX,
  UTILITY_DOCS,
  GENERATED_FROM,
} from "./docs-generated.ts";

export { GENERATED_FROM };

/**
 * One unit of deferred documentation.
 *
 * `topic` and `uri` are two names for the same row — the tool takes the topic,
 * the resource takes the URI. Keeping them on one object is what stops the two
 * doors from drifting apart.
 */
export interface DocTopic {
  /** The `muninn_docs(topic)` key. Short, lowercase, no scheme. */
  topic: string;
  /** The resource URI, e.g. `muninn://reference/recall`. */
  uri: string;
  /** Human-readable name, shown in a client's resource picker. */
  title: string;
  /** One line: what a reader gets from this, so the picker is navigable. */
  description: string;
  /** Practically always `text/markdown`. */
  mimeType: string;
  /** The document itself. */
  text: string;
}

/** Provenance stamped into the generated module, so staleness is diagnosable. */
export interface DocProvenance {
  /** Commit of muninn-utilities the content was generated from. */
  commit: string;
  /** ISO timestamp of generation. */
  generatedAt: string;
  /** Source paths read, relative to the muninn-utilities root. */
  sources: string[];
}

export const URI_SCHEME = "muninn://";
export const UTILITY_URI_PREFIX = "muninn://utilities/";

/**
 * Every fixed-URI topic: the reference set plus the utility index.
 *
 * Per-utility docs are not here — they are addressed by a URI template and
 * enumerated by its `list` callback instead, so `resources/list` answers with
 * all 21 rows (4 fixed + 17 utilities) while this function returns 4.
 *
 * An earlier version of this comment claimed the split kept those 17 rows OUT of
 * `resources/list`, to protect the budget. That was over-cautious, and it was
 * also not what shipped. The budget §8 is defending is what enters context
 * *unbidden*: `tools/list` is re-sent in every conversation, which is why tool
 * schemas are rationed. `resources/list` is fetched when someone goes looking.
 * Paying 17 rows once, on demand, to make the utilities discoverable is the
 * right side of §8 caveat 3 — a resource nobody can find is dead weight, and
 * `resources/templates/list` alone tells you the shape of a URI without telling
 * you which names are valid.
 *
 * What this split does buy is that the 17 never reach a tool schema. That was
 * always the load-bearing half.
 */
export function allDocs(): DocTopic[] {
  return [...REFERENCE_DOCS, UTILITY_INDEX];
}

/** Lookup for the `muninn_docs(topic)` door. */
export function docByTopic(topic: string): DocTopic | undefined {
  const key = String(topic ?? "").trim().toLowerCase();
  return allDocs().find((d) => d.topic === key);
}

/**
 * Lookup for the `resources/read` door, including the `muninn://utilities/{name}`
 * template.
 *
 * Returns undefined rather than throwing: the spec requires `resources/read` on
 * an unknown URI to answer -32602 and explicitly forbids an empty `contents`
 * array, since that is ambiguous between "no content" and "no such resource".
 * The caller owns that distinction, so this returns absence, not an error.
 */
export function docByUri(uri: string): DocTopic | undefined {
  const key = String(uri ?? "").trim();
  const fixed = allDocs().find((d) => d.uri === key);
  if (fixed) return fixed;

  if (!key.startsWith(UTILITY_URI_PREFIX)) return undefined;
  const name = key.slice(UTILITY_URI_PREFIX.length);
  return utilityDoc(name);
}

/** Names of every utility with generated docs, sorted. */
export function utilityNames(): string[] {
  return Object.keys(UTILITY_DOCS).sort();
}

/** One utility's doc, as a DocTopic so both doors serve it identically. */
export function utilityDoc(name: string): DocTopic | undefined {
  const key = String(name ?? "").trim();
  const text = UTILITY_DOCS[key];
  if (text === undefined) return undefined;
  return {
    topic: `utilities/${key}`,
    uri: `${UTILITY_URI_PREFIX}${key}`,
    title: `Utility: ${key}`,
    description: `Goal, inputs, outputs, errors and an example for ${key}.`,
    mimeType: "text/markdown",
    text,
  };
}

/**
 * The one-line pointer that goes in a tool description.
 *
 * §8 caveat 3: "a resource nobody reads is dead weight". The pointer has to live
 * somewhere always-in-context, which means inside the thin tool descriptions —
 * and that sentence is the single piece of schema text that cannot be
 * economised. Forgetting it is the classic PD failure: immaculate deferred
 * documentation that never gets loaded.
 *
 * Returns `undefined` for a topic the loaded registry does not serve, rather
 * than synthesising `muninn://reference/<topic>` and hoping. An earlier version
 * did synthesise, and it would have shipped `muninn_config` pointing at a dead
 * `muninn://reference/boot`: the `muninn_docs` door degrades to a list of real
 * topics, but `resources/read` on that URI is just -32602. **No pointer is
 * better than a dead pointer** — the tool still works, it simply offers no
 * deferred reference. A caller that wants a fallback should pick among
 * candidates that exist (see `pointerFor` in resources.ts) rather than invent
 * one here.
 */
export function pointerTo(topic: string): string | undefined {
  const doc = docByTopic(topic);
  if (!doc) return undefined;
  return `Full reference: ${doc.uri} (or muninn_docs topic="${topic}").`;
}
