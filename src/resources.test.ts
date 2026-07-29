/**
 * Coverage for the progressive-disclosure layer — both doors, one registry.
 *
 * Two things shape this file.
 *
 * FIXTURES, NOT GENERATED CONTENT. `docs-generated.ts` is a build artefact.
 * Asserting against whatever it currently holds would test the generator, and
 * would go red every time the content is rebuilt — so the behavioural tests run
 * a synthetic `DocRegistry` through the real registration path. A short second
 * section runs against the real registry, asserting only things that hold for
 * ANY content (every registered topic reads back; an unknown URI errors).
 *
 * OVER THE WIRE, NOT AROUND IT. The claims here are protocol claims: an unknown
 * URI must produce -32602 and not an empty read; the resource and the tool must
 * return the same bytes; a cache scope must actually reach the response. Every
 * one of those lives in the SDK's request handling, so the tests drive
 * `buildServer` through `createMcpHandler` with real JSON-RPC rather than
 * calling the callbacks directly.
 */

import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer } from "./server.ts";
import { allDocs, utilityNames } from "./docs.ts";
import type { DocTopic } from "./docs.ts";
import {
  UTILITY_URI_TEMPLATE,
  defaultRegistry,
  docContents,
  muninnDocs,
  pointerFor,
  resolveTopic,
  topicNames,
  type DocRegistry,
} from "./resources.ts";
import type { Deps } from "./tools.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

// ------------------------------------------------------------------- fixtures

const FIXED: DocTopic[] = [
  {
    topic: "alpha",
    uri: "muninn://reference/alpha",
    title: "Alpha reference",
    description: "Everything about alpha.",
    mimeType: "text/markdown",
    text: "# Alpha\n\nBody with a unicode ± and a trailing newline.\n",
  },
  {
    topic: "utilities",
    uri: "muninn://utilities",
    title: "Utility index",
    description: "Which utility handles which task shape.",
    mimeType: "text/markdown",
    text: "# Utilities\n\n- remind\n",
  },
];

const UTILS: Record<string, string> = {
  remind: "# remind\n\nGoal: nag later.\n",
  perch_publish: "# perch_publish\n\nGoal: publish a flight log.\n",
  perch_triage: "# perch_triage\n\nGoal: triage.\n",
};

/** A stand-in for `docs.ts`, with the same lookup semantics and known content. */
const fixture: DocRegistry = {
  allDocs: () => FIXED,
  docByTopic: (topic) => FIXED.find((d) => d.topic === String(topic ?? "").trim().toLowerCase()),
  docByUri: (uri) => {
    const key = String(uri ?? "").trim();
    const hit = FIXED.find((d) => d.uri === key);
    if (hit) return hit;
    if (!key.startsWith("muninn://utilities/")) return undefined;
    return fixture.utilityDoc(key.slice("muninn://utilities/".length));
  },
  utilityNames: () => Object.keys(UTILS).sort(),
  utilityDoc: (name) => {
    const key = String(name ?? "").trim();
    const text = UTILS[key];
    if (text === undefined) return undefined;
    return {
      topic: `utilities/${key}`,
      uri: `muninn://utilities/${key}`,
      title: `Utility: ${key}`,
      description: `Goal, inputs, outputs, errors and an example for ${key}.`,
      mimeType: "text/markdown",
      text,
    };
  },
};

// ---------------------------------------------------------------- wire driver

const CFG = { TURSO_URL: "x", TURSO_TOKEN: "y" };
/** Turso is never reached on a doc path; a client that throws proves it. */
const DEPS: Deps = {
  db: () => ({ execute: async () => { throw new Error("the doc layer must not touch Turso"); } }) as never,
};

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };

/**
 * One JSON-RPC round trip against a freshly built server.
 *
 * The 2026-07-28 envelope (`_meta` with the protocol version) is what makes the
 * response carry `ttlMs`/`cacheScope`; a 2025-era request has no cache fields at
 * all, so the cache assertions below have to speak the modern dialect.
 */
async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  opts: { registry?: DocRegistry; modern?: boolean } = {},
): Promise<Rpc> {
  const handler = createMcpHandler(() => buildServer(CFG, DEPS, opts.registry ?? fixture));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method, params };
  if (opts.modern) {
    headers["mcp-protocol-version"] = "2026-07-28";
    headers["mcp-method"] = method;
    // The 2026 revision routes on headers and rejects a request whose headers
    // and body disagree, so a named method must name itself twice.
    const named = params.uri ?? params.name;
    if (typeof named === "string") headers["mcp-name"] = named;
    body.params = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
  }
  const res = await handler.fetch(
    new Request("https://muninn.test/", { method: "POST", headers, body: JSON.stringify(body) }),
  );
  const text = await res.text();
  const at = text.indexOf("data: ");
  return JSON.parse(at >= 0 ? text.slice(at + 6) : text) as Rpc;
}

const uris = (r: Rpc) => (r.result?.resources as Array<{ uri: string }> ?? []).map((x) => x.uri).sort();
const firstContent = (r: Rpc) =>
  (r.result?.contents as Array<Record<string, unknown>> ?? [])[0] ?? {};
const toolText = (r: Rpc) =>
  ((r.result?.content as Array<{ text: string }> ?? [])[0] ?? { text: "" }).text;

// ------------------------------------------------------ registration coverage

{
  const list = await rpc("resources/list");
  const listed = uris(list);
  // Every fixed topic in the registry gets a resource — the claim §8 makes.
  eq("every fixed topic registers a resource",
     FIXED.every((d) => listed.includes(d.uri)), true);
  // The template's list callback is what makes the ~17 per-utility docs
  // discoverable without 17 static registrations.
  eq("the template lists every utility",
     fixture.utilityNames().every((n) => listed.includes(`muninn://utilities/${n}`)), true);
  eq("nothing else is registered", listed.length, FIXED.length + fixture.utilityNames().length);
  const names = (list.result?.resources as Array<{ name: string }>).map((r) => r.name);
  eq("fixed resources are named by topic", names.includes("alpha"), true);
  eq("listed utilities are named by utility name", names.includes("perch_triage"), true);
}

{
  const t = await rpc("resources/templates/list");
  const templates = t.result?.resourceTemplates as Array<{ uriTemplate: string; mimeType?: string }>;
  eq("the utility template is advertised", templates.map((x) => x.uriTemplate), [UTILITY_URI_TEMPLATE]);
  eq("the template carries a mimeType", templates[0].mimeType, "text/markdown");
}

// -------------------------------------------------------------------- reading

{
  const r = await rpc("resources/read", { uri: "muninn://reference/alpha" });
  const c = firstContent(r);
  eq("a known URI reads its text", c.text, FIXED[0].text);
  eq("a known URI reads its mimeType", c.mimeType, "text/markdown");
  // The response quotes the registry's URI rather than echoing the request.
  eq("the content is addressed by the registry's URI", c.uri, FIXED[0].uri);
  eq("exactly one content part", (r.result?.contents as unknown[]).length, 1);
}

{
  const r = await rpc("resources/read", { uri: "muninn://utilities/perch_publish" });
  eq("a templated URI reads its utility doc", firstContent(r).text, UTILS.perch_publish);
  // The static index and the template share a prefix; the index must win.
  const idx = await rpc("resources/read", { uri: "muninn://utilities" });
  eq("the utility index is not swallowed by the template", firstContent(idx).text, FIXED[1].text);
}

// -------------------------------------------------- unknown URIs are an error

{
  const r = await rpc("resources/read", { uri: "muninn://utilities/no_such_utility" });
  eq("an unknown templated URI is -32602", r.error?.code, -32602);
  // The spec forbids answering with an empty `contents` array: a client cannot
  // tell "exists but empty" from "does not exist". So there must be no result
  // at all, not a result with nothing in it.
  eq("an unknown templated URI returns no result at all", r.result, undefined);
  eq("the error names the URI", r.error?.message.includes("muninn://utilities/no_such_utility"), true);

  const f = await rpc("resources/read", { uri: "muninn://reference/no_such_doc" });
  eq("an unknown fixed URI is -32602", f.error?.code, -32602);
  eq("an unknown fixed URI returns no result at all", f.result, undefined);
  // Both misses look the same to a client: one lookup, one error shape.
  eq("both misses share an error shape",
     r.error?.message.replace("utilities/no_such_utility", "…") ===
       f.error?.message.replace("reference/no_such_doc", "…"), true);
}

// ----------------------------------------------------------------- completion

{
  const complete = (value: string) =>
    rpc("completion/complete", {
      ref: { type: "ref/resource", uri: UTILITY_URI_TEMPLATE },
      argument: { name: "name", value },
    });
  eq("completion is a prefix match",
     (await complete("perch")).result?.completion, { values: ["perch_publish", "perch_triage"], total: 2, hasMore: false });
  eq("an empty prefix completes everything",
     ((await complete("")).result?.completion as { values: string[] }).values, fixture.utilityNames());
  eq("completion is case-insensitive",
     ((await complete("PERCH_T")).result?.completion as { values: string[] }).values, ["perch_triage"]);
  eq("a miss completes to nothing",
     ((await complete("zzz")).result?.completion as { values: string[] }).values, []);
}

// --------------------------------------------------------------- capabilities

{
  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  const caps = init.result?.capabilities as Record<string, Record<string, unknown>>;
  eq("the resources capability is declared", caps.resources !== undefined, true);
  // We send no notifications and honour no subscriptions, so we claim neither.
  eq("listChanged is not claimed", caps.resources.listChanged, false);
  eq("subscribe is not claimed", "subscribe" in caps.resources, false);
  // Completion IS honoured — the template has a complete callback.
  eq("completions is claimed, because it is implemented", caps.completions !== undefined, true);
}

// ------------------------------------------------------------- cache scoping
// Generated documentation is identical for every caller and changes only on
// deploy, so it is public. Anything derived from the memory corpus would be
// private — see PUBLIC_DOC_CACHE_HINT.

{
  const read = await rpc("resources/read", { uri: "muninn://reference/alpha" }, { modern: true });
  eq("a doc read is publicly cacheable", read.result?.cacheScope, "public");
  eq("a doc read carries the deploy-bounded TTL", read.result?.ttlMs, 300_000);

  const list = await rpc("resources/list", {}, { modern: true });
  eq("the resource listing is publicly cacheable", list.result?.cacheScope, "public");

  const templates = await rpc("resources/templates/list", {}, { modern: true });
  eq("the template listing is publicly cacheable", templates.result?.cacheScope, "public");

  const tools = await rpc("tools/list", {}, { modern: true });
  eq("tools/list stays publicly cacheable", tools.result?.cacheScope, "public");
}

// ------------------------------------------------------- two doors, one thing

{
  const viaResource = firstContent(await rpc("resources/read", { uri: "muninn://reference/alpha" })).text;
  const viaTool = toolText(await rpc("tools/call", { name: "muninn_docs", arguments: { topic: "alpha" } }));
  // The claim §8 caveat 2 rests on: not "similar content", the same bytes.
  eq("muninn_docs returns the resource's bytes exactly", viaTool, viaResource);
  eq("and they are the registry's bytes", viaTool, FIXED[0].text);

  const utilResource = firstContent(await rpc("resources/read", { uri: "muninn://utilities/remind" })).text;
  const utilTool = toolText(await rpc("tools/call", { name: "muninn_docs", arguments: { topic: "utilities/remind" } }));
  eq("the template's rows go through both doors too", utilTool, utilResource);
}

{
  const miss = await rpc("tools/call", { name: "muninn_docs", arguments: { topic: "nope" } });
  const text = toolText(miss);
  // A wrong topic is a discovery failure, and this layer can fix it.
  eq("an unknown topic is not an error", miss.result?.isError, undefined);
  eq("an unknown topic names what was asked for", text.includes("No doc topic 'nope'"), true);
  eq("an unknown topic lists the fixed topics",
     topicNames(fixture).every((t) => text.includes(t)), true);
  eq("an unknown topic points at the per-utility form", text.includes('"utilities/<name>"'), true);
  eq("an unknown topic lists the utilities",
     fixture.utilityNames().every((n) => text.includes(n)), true);

  const empty = toolText(await rpc("tools/call", { name: "muninn_docs", arguments: { topic: "  " } }));
  eq("an empty topic answers with the same discovery text", empty.includes("Available topics:"), true);
}

// ---------------------------------------------------- the always-in-context pointer
// §8 caveat 3: deferred documentation nobody loads is dead weight. Every thinned
// description has to carry its pointer, so every thinned description is checked.

{
  const tools = (await rpc("tools/list")).result?.tools as Array<{ name: string; description: string }>;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  eq("the read tools plus the docs door are registered",
     tools.map((t) => t.name).sort(), ["memory_get", "muninn_config", "muninn_docs", "recall"]);
  // Pointer PRESENCE is registry-dependent and therefore asserted against the
  // real registry further down, not here: this block runs on a fixture whose
  // topics are alpha/beta, so no real tool's candidates resolve and — correctly
  // — no pointer is emitted. That is the whole point of the change that made
  // `pointerTo` return undefined instead of inventing a URI.
  for (const name of ["recall", "memory_get", "muninn_config"]) {
    eq(`${name} emits no pointer when the registry serves none of its topics`,
       /muninn:\/\//.test(byName[name]), false);
  }
  // The topic list in muninn_docs' own description is derived, not written down.
  eq("muninn_docs lists the registry's topics",
     topicNames(fixture).every((t) => byName.muninn_docs.includes(t)), true);
  eq("muninn_docs advertises the per-utility form",
     byName.muninn_docs.includes("utilities/<name>"), true);
  // The hot path keeps its arguments: PD on `recall` would be a regression
  // wearing PD's clothes (§8 caveat 1).
  const recallSchema = (tools.find((t) => t.name === "recall") as unknown as { inputSchema: { properties: Record<string, { description?: string }> } }).inputSchema;
  eq("recall keeps four first-class arguments",
     Object.keys(recallSchema.properties).sort(), ["n", "query", "tags", "type"]);
  eq("and each one is still described",
     Object.values(recallSchema.properties).every((p) => (p.description ?? "").length > 0), true);
}

// -------------------------------------------------------------- unit coverage

eq("resolveTopic finds a fixed topic", resolveTopic(fixture, "alpha")?.uri, "muninn://reference/alpha");
eq("resolveTopic is case- and space-insensitive", resolveTopic(fixture, " ALPHA ")?.topic, "alpha");
eq("resolveTopic handles the utilities/<name> form",
   resolveTopic(fixture, "utilities/remind")?.uri, "muninn://utilities/remind");
eq("resolveTopic returns undefined for a miss", resolveTopic(fixture, "utilities/nope"), undefined);
eq("docContents is addressed by the registry URI",
   docContents(FIXED[0]).contents[0].uri, "muninn://reference/alpha");
eq("muninnDocs returns the doc text unwrapped", muninnDocs("alpha", fixture), FIXED[0].text);

// The pointer resolves against the registry that is loaded, so a name the
// generator has not emitted yet cannot produce a pointer at a dead URI.
eq("pointerFor prefers the first candidate that exists",
   pointerFor(fixture, ["alpha", "utilities"]).includes('topic="alpha"'), true);
eq("pointerFor falls through to one that does",
   pointerFor(fixture, ["not_generated", "utilities"]).includes('topic="utilities"'), true);
// No pointer beats a dead pointer: `muninn_docs` turns an unknown topic into a
// list of real ones, but `resources/read` on an invented URI is just -32602.
eq("pointerFor emits nothing when no candidate exists",
   pointerFor(fixture, ["not_generated", "also_missing"]), "");

// ------------------------------------------- against the real (generated) registry
// Content-independent claims only: these must hold for the placeholder, for the
// generator's first output, and for every output after it.

{
  const list = await rpc("resources/list", {}, { registry: defaultRegistry });
  const listed = uris(list);
  eq("every real fixed topic registers a resource",
     allDocs().every((d) => listed.includes(d.uri)), true);
  eq("every real utility is listed",
     utilityNames().every((n) => listed.includes(`muninn://utilities/${n}`)), true);

  for (const doc of allDocs()) {
    const r = await rpc("resources/read", { uri: doc.uri }, { registry: defaultRegistry });
    eq(`real topic ${doc.topic} reads back its own bytes`, firstContent(r).text, doc.text);
    const viaTool = await rpc(
      "tools/call",
      { name: "muninn_docs", arguments: { topic: doc.topic } },
      { registry: defaultRegistry },
    );
    eq(`real topic ${doc.topic} is identical through both doors`, toolText(viaTool), doc.text);
  }

  /**
   * NO DEAD POINTERS. A pointer at a URI nobody serves is §8 caveat 3's failure
   * with extra steps, and it is the failure this layer is most likely to ship:
   * the tool descriptions are written here, the topics are emitted by a separate
   * build step. So every `muninn://` URI that appears in a tool description is
   * read back through the protocol.
   */
  const shipped = (await rpc("tools/list", {}, { registry: defaultRegistry }))
    .result?.tools as Array<{ name: string; description: string }>;
  const shippedByName = Object.fromEntries(shipped.map((t) => [t.name, t.description]));
  // The other half of caveat 3, and the half a dead-pointer check cannot cover:
  // a description with NO pointer passes "every URI resolves" vacuously. Against
  // the real registry every thinned tool must actually carry one.
  for (const name of ["recall", "memory_get", "muninn_config"]) {
    eq(`${name} carries a resource pointer`, /muninn:\/\/\S+/.test(shippedByName[name]), true);
    eq(`${name} carries the tool-door fallback`,
       shippedByName[name].includes('muninn_docs topic="'), true);
  }
  for (const tool of shipped) {
    for (const uri of tool.description.match(/muninn:\/\/[^\s)"]+/g) ?? []) {
      const r = await rpc("resources/read", { uri }, { registry: defaultRegistry });
      eq(`${tool.name}'s pointer at ${uri} resolves`, r.error, undefined);
    }
    for (const topic of tool.description.match(/muninn_docs topic="([^"]+)"/g) ?? []) {
      const name = topic.slice('muninn_docs topic="'.length, -1);
      eq(`${tool.name}'s pointer topic ${name} exists`,
         resolveTopic(defaultRegistry, name) !== undefined, true);
    }
  }

  const miss = await rpc(
    "resources/read",
    { uri: "muninn://utilities/definitely_not_a_utility" },
    { registry: defaultRegistry },
  );
  eq("an unknown utility errors under the real registry too", miss.error?.code, -32602);
  eq("and returns no contents", miss.result, undefined);

  const init = await rpc(
    "initialize",
    { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    { registry: defaultRegistry },
  );
  eq("the real server declares resources",
     (init.result?.capabilities as Record<string, unknown>).resources !== undefined, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
