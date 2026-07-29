/**
 * The two doors onto `docs.ts`'s registry: `muninn://` resources and the
 * `muninn_docs(topic)` tool.
 *
 * WHY BOTH DOORS LIVE IN ONE FILE
 * -------------------------------
 * §8 caveat 2 is that resource auto-read is not guaranteed and varies by
 * surface: Claude Code exposes generic list/read tools so resources work well,
 * while claude.ai connectors have historically surfaced resources as
 * user-attachable content rather than something the model reads on its own.
 * Cross-surface robustness is the entire argument for the migration, so the
 * documentation path must not depend on resource support — hence the tool.
 *
 * The failure mode of "same content, two doors" is drift: the tool grows a
 * header, the resource grows a footer, and a year later they are two documents.
 * The guard is that both doors are built here, from one registry, and both hand
 * back `doc.text` unwrapped. `resources.test.ts` reads the same topic through
 * both and asserts byte equality, so the claim is checked rather than asserted.
 *
 * WHY THE REGISTRY IS INJECTABLE
 * ------------------------------
 * `docs-generated.ts` is produced by a build step. Tests that assert against
 * whatever it happens to contain would be testing the generator, and would go
 * red every time the content is regenerated. So everything here takes a
 * `DocRegistry`, defaulting to `docs.ts`, and the tests drive synthetic topics
 * through the same code paths.
 */

import { McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  allDocs,
  docByTopic,
  docByUri,
  pointerTo,
  UTILITY_URI_PREFIX,
  utilityDoc,
  utilityNames,
  type DocTopic,
} from "./docs.ts";

/**
 * The slice of `docs.ts` this module needs, named so tests can substitute it.
 *
 * Deliberately the module's own shape rather than a new abstraction: the point
 * is that `docs.ts` IS the registry, and this interface only exists so a test
 * can hand over a different set of rows.
 */
export interface DocRegistry {
  allDocs(): DocTopic[];
  docByTopic(topic: string): DocTopic | undefined;
  docByUri(uri: string): DocTopic | undefined;
  utilityNames(): string[];
  utilityDoc(name: string): DocTopic | undefined;
}

export const defaultRegistry: DocRegistry = {
  allDocs,
  docByTopic,
  docByUri,
  utilityNames,
  utilityDoc,
};

/** The URI template the per-utility docs are addressed by. */
export const UTILITY_URI_TEMPLATE = `${UTILITY_URI_PREFIX}{name}`;

/**
 * CACHING IS A PRIVACY BOUNDARY — read this before adding a resource.
 *
 * `server.ts` already carries half of this discipline: `tools/list` is public
 * because the tool list is identical for every caller, and NOTHING derived from
 * the memory corpus may ever be public, because recall results are one user's
 * private memory and a shared cache would hand them to the next caller.
 *
 * Every resource registered here is GENERATED DOCUMENTATION. It is byte-identical
 * for every caller, contains no memory rows, and changes only on deploy — the
 * three properties that make `cacheScope: "public"` correct rather than merely
 * convenient. The TTL matches `tools/list`'s five minutes for the same reason:
 * the content cannot change until the Worker is redeployed, and five minutes
 * bounds how long a stale deploy can be served.
 *
 * WHAT WOULD CHANGE IT: the first resource whose content, title, description or
 * *existence* depends on the corpus — `muninn://boot`'s composed payload, a
 * `muninn://memory/{id}` view, a resource listing a user's tags — is `"private"`,
 * and registering one also makes `resources/list` private, because a listing
 * that names one user's memories is itself that user's data. Do not reach for
 * this constant on the way past; decide, and say which of the two you decided.
 */
export const PUBLIC_DOC_CACHE_HINT: { ttlMs: number; cacheScope: "public" | "private" } = {
  ttlMs: 300_000,
  cacheScope: "public",
};

/**
 * The `resources/read` payload for one topic.
 *
 * The URI comes from the registry row rather than from the requested URL. Both
 * round-trip identically today (`new URL("muninn://utilities").toString()` is
 * stable), but the registry is the thing that decides what a topic's identity
 * is, and the response should quote it rather than echo the caller.
 */
export function docContents(doc: DocTopic) {
  return { contents: [{ uri: doc.uri, mimeType: doc.mimeType, text: doc.text }] };
}

/**
 * Resolve a `muninn_docs` topic, including the `utilities/<name>` form.
 *
 * `docByTopic` covers the fixed rows; per-utility docs are addressed by template
 * on the resource side and by this prefix on the tool side, and both end at
 * `utilityDoc`. Keeping the branch here rather than in each caller is what keeps
 * "the tool takes the topic, the resource takes the URI" true of every row.
 */
export function resolveTopic(registry: DocRegistry, topic: string): DocTopic | undefined {
  const key = String(topic ?? "").trim();
  const fixed = registry.docByTopic(key);
  if (fixed) return fixed;
  const lower = key.toLowerCase();
  if (!lower.startsWith("utilities/")) return undefined;
  return registry.utilityDoc(key.slice("utilities/".length));
}

/** Every fixed topic name, for the tool description and the not-found answer. */
export function topicNames(registry: DocRegistry): string[] {
  return registry.allDocs().map((d) => d.topic);
}

/**
 * The one-line pointer for a thinned tool description, resolved against the
 * registry that is actually loaded.
 *
 * §8 caveat 3 says the pointer is the one piece of schema text that cannot be
 * economised — but a pointer at a URI nobody serves is the same failure with
 * extra steps. `docs-generated.ts` is built by a separate step and its topic
 * names are fixed by §8's table, not by this file, so a tool names its topics
 * most-specific-first and takes the first one the registry actually has.
 *
 * When none of them resolve — the pre-generation placeholder, or a topic the
 * generator stopped emitting — the description ships with NO pointer sentence.
 * That is deliberate: `pointerTo` returns undefined rather than synthesising a
 * plausible URI, because `muninn_docs` degrades an unknown topic into a list of
 * real ones but `resources/read` on an invented URI is just -32602. A tool
 * without deferred documentation is merely thin; a tool advertising
 * documentation that does not exist spends a round trip to teach the caller not
 * to trust it.
 */
export function pointerFor(registry: DocRegistry, candidates: string[]): string {
  for (const topic of candidates) {
    const doc = resolveTopic(registry, topic);
    if (doc) return `Full reference: ${doc.uri} (or muninn_docs topic="${topic}").`;
  }
  return "";
}

/**
 * Register every fixed topic as a static resource, plus the utility template.
 *
 * The fixed rows come straight from `allDocs()`: one registration each, named by
 * topic so a client's resource picker shows `recall`, `types`, `utilities`
 * rather than a URI. Per-utility docs are NOT registered individually — that is
 * `docs.ts`'s deliberate choice, and the template below is what it buys.
 */
export function registerResources(server: McpServer, registry: DocRegistry = defaultRegistry): void {
  for (const doc of registry.allDocs()) {
    server.registerResource(
      doc.topic,
      doc.uri,
      {
        title: doc.title,
        description: doc.description,
        mimeType: doc.mimeType,
        // Generated documentation: identical for every caller. See
        // PUBLIC_DOC_CACHE_HINT for what would make a resource private.
        cacheHint: PUBLIC_DOC_CACHE_HINT,
      },
      // Closes over `doc`, so the read is a lookup-free constant. Registration
      // runs per request on the Worker's HTTP path, so this stays cheap.
      async () => docContents(doc),
    );
  }

  server.registerResource(
    "utility",
    new ResourceTemplate(UTILITY_URI_TEMPLATE, {
      /**
       * ~17 utilities enumerate here rather than as 17 static registrations.
       * `docs.ts` keeps them out of `allDocs()` so the server carries ONE row
       * for them; a client that wants the enumeration pays a round trip it chose
       * to make, instead of every conversation paying for it in context.
       */
      list: async () => ({
        resources: registry.utilityNames().flatMap((name) => {
          const doc = registry.utilityDoc(name);
          return doc
            ? [{ uri: doc.uri, name, title: doc.title, description: doc.description, mimeType: doc.mimeType }]
            : [];
        }),
      }),
      /**
       * Completion on `{name}`. Prefix, case-insensitive — the names are
       * snake_case module names and a caller half-remembering `perch_` should
       * get both `perch_publish` and `perch_triage`.
       */
      complete: {
        name: async (value: string) => {
          const prefix = String(value ?? "").toLowerCase();
          return registry.utilityNames().filter((n) => n.toLowerCase().startsWith(prefix));
        },
      },
    }),
    {
      title: "Utility reference",
      description: "Goal, inputs, outputs, errors and an example for one muninn_utils utility.",
      mimeType: "text/markdown",
      cacheHint: PUBLIC_DOC_CACHE_HINT,
    },
    /**
     * UNKNOWN URIs ARE AN ERROR, NEVER AN EMPTY READ.
     *
     * The template matches `muninn://utilities/<anything>`, so this callback —
     * not the SDK's registry lookup — is the only thing standing between a
     * typo'd utility name and a successful read of nothing. The spec requires
     * -32602 here and explicitly forbids answering with an empty `contents`
     * array, because a client cannot distinguish "exists but empty" from "does
     * not exist". `docByUri` returns undefined rather than throwing precisely so
     * that this decision is made here, in the layer that owns the protocol.
     *
     * `ResourceNotFoundError` is the SDK's own -32602 carrier and produces the
     * same body the static-resource path produces for an unregistered URI, so
     * both misses look identical to a client.
     */
    async (uri: URL) => {
      const doc = registry.docByUri(uri.toString());
      if (!doc) throw new ResourceNotFoundError(uri.toString());
      return docContents(doc);
    },
  );
}

/**
 * The tool door's body: the same bytes `resources/read` returns, or — for an
 * unknown topic — the list of topics that exist.
 *
 * A wrong topic is a discovery failure, and this is the layer that can fix it:
 * the caller either mistyped or never saw the list, and both are answered by
 * printing it. Returning a bare error would spend a round trip to say "no".
 */
export function muninnDocs(topic: string, registry: DocRegistry = defaultRegistry): string {
  const doc = resolveTopic(registry, topic);
  if (doc) return doc.text;

  const asked = String(topic ?? "").trim();
  const topics = topicNames(registry);
  const utils = registry.utilityNames();
  const head = asked ? `No doc topic '${asked}'.` : "muninn_docs: a `topic` is required.";
  const lines = [
    `${head} Available topics: ${topics.length ? topics.join(", ") : "(none generated yet)"}.`,
  ];
  if (utils.length) {
    lines.push(`Per-utility docs: topic "utilities/<name>" where <name> is one of: ${utils.join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * Register `muninn_docs` — §9 decision 14, day one.
 *
 * Three lines of schema, and the description states which topics exist so the
 * model can pick one without a `resources/list` round trip. That list is derived
 * from the registry rather than written out here: a hardcoded list would drift
 * from the generator the first time a reference doc is added or renamed, and a
 * tool description that lies about its own enum is worse than one that says
 * nothing.
 */
export function registerDocsTool(server: McpServer, registry: DocRegistry = defaultRegistry): void {
  const topics = topicNames(registry);
  const utils = registry.utilityNames();
  const known = topics.length ? topics.join(", ") : "(none generated yet)";
  const perUtility = utils.length ? `, or utilities/<name>` : "";

  server.registerTool(
    "muninn_docs",
    {
      title: "Read Muninn reference docs",
      // PD applies to this tool too. What a client does NOT need in every
      // conversation is an explanation of the two-door design — that this
      // returns the same bytes as the `muninn://` resources matters to whoever
      // maintains the server, not to whoever calls it. Hence the comment here
      // and not a sentence in the schema.
      description:
        `Read one Muninn reference doc: the detail the other tool descriptions defer. ` +
        `Topics: ${known}${perUtility}.`,
      inputSchema: z.object({
        topic: z.string().describe(`One of: ${known}${perUtility}.`),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    // No try/catch: this reads a frozen in-bundle object. There is no I/O to
    // fail, and an unknown topic is answered rather than thrown.
    async (args) => ({
      content: [{ type: "text" as const, text: muninnDocs(String(args.topic ?? ""), registry) }],
    }),
  );
}

/** Both doors, one call — so a server cannot register one and forget the other. */
export function registerDocLayer(server: McpServer, registry: DocRegistry = defaultRegistry): void {
  registerResources(server, registry);
  registerDocsTool(server, registry);
}
