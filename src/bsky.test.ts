/** `bsky` tool: credential selection, request shapes, facets, thread extraction, redaction. Fetch is faked; no network. */
import {
  bsky, bskyInputSchema, BSKY_TOOL_DESCRIPTION,
  computeFacets, parseMarkdownLinks, finalTextForPost, composePostText,
  graphemeLength, parseAtUri, extractRepliers, jwtExpiry, getSession, _resetSessionCache,
  APPVIEW_PUBLIC, APPVIEW_FALLBACK, LIST_BATCH,
  type BskyConfig, type BskyDeps,
} from "./bsky.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

const OSKAR_PW = "oskar-app-password-xxxx";
const MUNINN_PW = "muninn-app-password-yyyy";
const CFG: BskyConfig = {
  BSKY_HANDLE: "oskar.test",
  BSKY_APP_PASSWORD: OSKAR_PW,
  MUNINN_BSKY_HANDLE: "muninn.test",
  MUNINN_BSKY_APP_PASSWORD: MUNINN_PW,
};
const NOW = Date.parse("2026-09-19T14:00:00Z");

/** A JWT whose payload carries `exp` (seconds) — header/signature are junk on purpose. */
const jwtWithExp = (expSeconds: number, tag = "x") =>
  `hdr.${Buffer.from(JSON.stringify({ exp: expSeconds, sub: tag })).toString("base64url")}.sig-${tag}`;
const JWT_MUNINN = jwtWithExp(Math.floor(NOW / 1000) + 7200, "muninn");
const JWT_OSKAR = jwtWithExp(Math.floor(NOW / 1000) + 7200, "oskar");

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

/**
 * A fake fetch that records every request and routes on the URL path.
 * The handler returns a body (JSON-encoded) or a Response for status cases.
 */
function fake(handler: (call: Call) => unknown | Response = () => ({})) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    let body: unknown = null;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    else if (init?.body) body = "<binary>";
    const call: Call = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const deps: BskyDeps = { fetch: f, now: () => NOW, sleep: async () => {} };
  return { calls, deps };
}

/** Default route table: session for either account, resolveHandle, createRecord echoing an at-uri. */
function routes(over: (c: Call) => unknown | Response | undefined = () => undefined) {
  return (c: Call): unknown | Response => {
    const o = over(c);
    if (o !== undefined) return o;
    if (c.url.includes("createSession")) {
      const id = (c.body as { identifier: string }).identifier;
      return id === "oskar.test"
        ? { accessJwt: JWT_OSKAR, did: "did:plc:oskar", handle: "oskar.test" }
        : { accessJwt: JWT_MUNINN, did: "did:plc:muninn", handle: "muninn.test" };
    }
    if (c.url.includes("resolveHandle")) {
      const h = new URL(c.url).searchParams.get("handle")!;
      return { did: `did:plc:${h.split(".")[0]}` };
    }
    if (c.url.includes("createRecord")) {
      const b = c.body as { repo: string; collection: string };
      return { uri: `at://${b.repo}/${b.collection}/rkey1`, cid: "bafycid" };
    }
    return {};
  };
}

const byPath = (calls: Call[], frag: string) => calls.filter((c) => c.url.includes(frag));

// ---------------------------------------------------------------- schema

eq("schema defaults account to muninn", bskyInputSchema.parse({ op: "whoami" }).account, "muninn");
eq("schema rejects an unknown account", bskyInputSchema.safeParse({ op: "whoami", account: "root" }).success, false);
eq("schema rejects an unknown op", bskyInputSchema.safeParse({ op: "nuke" }).success, false);
eq("description states the account rule", BSKY_TOOL_DESCRIPTION.includes("defaults to 'muninn'"), true);

// ---------------------------------------------------------------- pure helpers

eq("graphemes: emoji ZWJ family is one", graphemeLength("👨‍👩‍👧"), 1);
eq("graphemes: combining acute is one", graphemeLength("é"), 1);
eq("graphemes: ascii counts", graphemeLength("hello"), 5);

eq("computeFacets: URL bytes, trailing punctuation stripped",
   computeFacets("see https://x.io/a). ok"),
   [{ index: { byteStart: 4, byteEnd: 18 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://x.io/a" }] }]);
eq("computeFacets: hashtag after multibyte text uses byte offsets",
   computeFacets("é #tag"),
   [{ index: { byteStart: 3, byteEnd: 7 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "tag" }] }]);
eq("computeFacets: no facet for a mid-word #", computeFacets("a#b"), []);

{
  const r = parseMarkdownLinks("read [this](https://x.io/p) now");
  eq("markdown: displayed text only", r.text, "read this now");
  eq("markdown: facet spans the label", r.facets[0].index, { byteStart: 5, byteEnd: 9 });
  eq("markdown: facet carries the URL", r.facets[0].features[0].uri, "https://x.io/p");
}
eq("finalText appends an unlinked URL on a new line", finalTextForPost("hi", "https://x.io"), "hi\nhttps://x.io");
eq("finalText skips append when markdown already targets it", finalTextForPost("[hi](https://x.io)", "https://x.io"), "hi");
eq("finalText skips append when literally present", finalTextForPost("go https://x.io", "https://x.io"), "go https://x.io");
eq("finalText with no url just strips markdown", finalTextForPost("[a](https://b.c)"), "a");
{
  const c = composePostText("[a](https://b.c) #t", "https://d.e");
  eq("compose: markdown facet first, then URL append and tag facets",
     c.facets.map((f) => f.features[0].uri ?? f.features[0].tag), ["https://b.c", "https://d.e", "t"]);
}
eq("parseAtUri splits the three parts",
   parseAtUri("at://did:plc:a/app.bsky.feed.post/3k"), { repo: "did:plc:a", collection: "app.bsky.feed.post", rkey: "3k" });
eq("jwtExpiry decodes exp in ms", jwtExpiry(jwtWithExp(1700000000)), 1700000000000);
eq("jwtExpiry is null for an opaque token", jwtExpiry("not-a-jwt"), null);

// ---------------------------------------------------------------- session / account selection

{
  _resetSessionCache();
  const { calls, deps } = fake(routes());
  const out = await bsky(CFG, { op: "whoami" }, deps);
  const cs = byPath(calls, "createSession");
  eq("default account creates a session as Muninn", cs[0].body, { identifier: "muninn.test", password: MUNINN_PW });
  eq("createSession posts JSON to the default PDS",
     [cs[0].method, cs[0].url, cs[0].headers["content-type"]],
     ["POST", "https://bsky.social/xrpc/com.atproto.server.createSession", "application/json"]);
  eq("whoami reports did and handle", out, "muninn: @muninn.test\ndid: did:plc:muninn\npds: https://bsky.social");

  await bsky(CFG, { op: "whoami", account: "oskar" }, deps);
  eq("account:'oskar' uses the unprefixed pair, never Muninn's", byPath(calls, "createSession")[1].body,
     { identifier: "oskar.test", password: OSKAR_PW });
  await bsky(CFG, { op: "whoami" }, deps);
  eq("a decodable JWT is cached per handle (no third createSession)", byPath(calls, "createSession").length, 2);
}
{
  _resetSessionCache();
  const { calls, deps } = fake(routes((c) => c.url.includes("createSession")
    ? { accessJwt: "opaque-token", did: "did:plc:m", handle: "muninn.test" } : undefined));
  await getSession(CFG, "muninn", deps);
  await getSession(CFG, "muninn", deps);
  eq("an undecodable JWT is not cached", byPath(calls, "createSession").length, 2);
}
{
  _resetSessionCache();
  const { calls, deps } = fake(routes());
  await bsky(CFG, { op: "whoami" }, { ...deps, now: () => NOW });
  await bsky(CFG, { op: "whoami" }, { ...deps, now: () => NOW + 7200_000 });
  eq("an expired cached session is re-created", byPath(calls, "createSession").length, 2);
}
{
  _resetSessionCache();
  const { deps } = fake(routes());
  const cfg = { ...CFG, BSKY_HANDLE: "", BSKY_APP_PASSWORD: "" };
  const err = await bsky(cfg, { op: "whoami", account: "oskar" }, deps).catch((e: Error) => e.message);
  eq("missing pair names the env vars, not a value", err, "bsky: BSKY_HANDLE / BSKY_APP_PASSWORD are not configured for account 'oskar'.");
}
{
  _resetSessionCache();
  const { deps } = fake(routes());
  await bsky({ ...CFG, BSKY_PDS: "https://pds.example/" }, { op: "whoami" }, deps);
  eq("BSKY_PDS overrides the session host", (await bsky({ ...CFG, BSKY_PDS: "https://pds.example/" }, { op: "whoami" }, deps)).endsWith("pds: https://pds.example"), true);
}

// ---------------------------------------------------------------- post

{
  _resetSessionCache();
  const { calls, deps } = fake(routes());
  const out = await bsky(CFG, {
    op: "post", text: "Read [the post](https://blog.example/p) #muninn", link: "https://blog.example/p",
    title: "T", description: "D",
  }, deps);
  const cr = byPath(calls, "createRecord")[0];
  const body = cr.body as { repo: string; collection: string; record: Record<string, unknown> };
  eq("post: bearer token from the session", cr.headers["authorization"], `Bearer ${JWT_MUNINN}`);
  eq("post: repo is the session DID, collection is feed.post", [body.repo, body.collection], ["did:plc:muninn", "app.bsky.feed.post"]);
  eq("post: text is markdown-stripped and the URL is not appended (already linked)", body.record.text, "Read the post #muninn");
  eq("post: facets are the markdown link + the tag",
     (body.record.facets as Array<{ features: Array<{ uri?: string; tag?: string }> }>).map((f) => f.features[0].uri ?? f.features[0].tag),
     ["https://blog.example/p", "muninn"]);
  eq("post: external embed carries uri/title/description",
     body.record.embed, { $type: "app.bsky.embed.external", external: { uri: "https://blog.example/p", title: "T", description: "D" } });
  eq("post: createdAt comes from deps.now", body.record.createdAt, "2026-09-19T14:00:00.000Z");
  eq("post: returns the bsky.app URL and at-uri", out,
     "Posted as @muninn.test: https://bsky.app/profile/muninn.test/post/rkey1\nuri: at://did:plc:muninn/app.bsky.feed.post/rkey1\ncid: bafycid");
}
{
  _resetSessionCache();
  const { calls, deps } = fake(routes((c) => {
    if (c.url === "https://img.example/a.png") return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
    if (c.url.includes("uploadBlob")) return { blob: { $type: "blob", ref: { $link: "bafyblob" }, mimeType: "image/png", size: 3 } };
    return undefined;
  }));
  await bsky(CFG, { op: "post", text: "pic", link: "https://x.io", image_url: "https://img.example/a.png" }, deps);
  const up = byPath(calls, "uploadBlob")[0];
  eq("post: image is uploaded with its content type", [up.method, up.headers["content-type"]], ["POST", "image/png"]);
  const rec = (byPath(calls, "createRecord")[0].body as { record: { embed: { external: { thumb: unknown } } } }).record;
  eq("post: uploaded blob becomes the card thumb", rec.embed.external.thumb, { $type: "blob", ref: { $link: "bafyblob" }, mimeType: "image/png", size: 3 });
}
{
  _resetSessionCache();
  const { calls, deps } = fake(routes());
  const out = await bsky(CFG, { op: "post", text: "plain" }, deps);
  const rec = (byPath(calls, "createRecord")[0].body as { record: Record<string, unknown> }).record;
  eq("post without link: no embed, no facets key", ["embed" in rec, "facets" in rec], [false, false]);
  eq("post without link still returns a URL", out.startsWith("Posted as @muninn.test: https://bsky.app/profile/muninn.test/post/"), true);
}
{
  _resetSessionCache();
  const { calls, deps } = fake(routes());
  const ok = await bsky(CFG, { op: "post", text: "👨‍👩‍👧".repeat(299) + "é" }, deps).catch((e: Error) => e.message);
  eq("300 graphemes of emoji + combining mark posts", ok.startsWith("Posted"), true);
  const err = await bsky(CFG, { op: "post", text: "👨‍👩‍👧".repeat(300) + "é" }, deps).catch((e: Error) => e.message);
  eq("301 graphemes is refused with a clear message", err, "bsky: post is 301 graphemes; the limit is 300. Nothing was posted.");
  eq("over-limit post never reaches the network", byPath(calls, "createRecord").length, 1);
  const err2 = await bsky(CFG, { op: "post", text: "x".repeat(295), link: "https://a.io" }, deps).catch((e: Error) => e.message);
  eq("the appended link counts toward the limit", err2.includes("308 graphemes") && err2.includes("link append"), true);
}

// ---------------------------------------------------------------- delete / like / unlike / resolve

{
  _resetSessionCache();
  const { calls, deps } = fake(routes());
  await bsky(CFG, { op: "delete_post", uri: "at://did:plc:muninn/app.bsky.feed.post/3k" }, deps);
  eq("delete_post: deleteRecord with collection + rkey from the uri", byPath(calls, "deleteRecord")[0].body,
     { repo: "did:plc:muninn", collection: "app.bsky.feed.post", rkey: "3k" });
  const bad = await bsky(CFG, { op: "delete_post", uri: "https://bsky.app/x" }, deps).catch((e: Error) => e.message);
  eq("delete_post rejects a non at:// uri", bad, "bsky: not an at:// record URI: 'https://bsky.app/x'.");

  const liked = await bsky(CFG, { op: "like", uri: "at://did:plc:o/app.bsky.feed.post/1", cid: "bafy1" }, deps);
  const lk = byPath(calls, "createRecord")[0].body as { collection: string; record: { subject: unknown } };
  eq("like: feed.like record with subject uri+cid", [lk.collection, lk.record.subject],
     ["app.bsky.feed.like", { uri: "at://did:plc:o/app.bsky.feed.post/1", cid: "bafy1" }]);
  eq("like: returns the like uri", liked.endsWith("like_uri: at://did:plc:muninn/app.bsky.feed.like/rkey1"), true);

  await bsky(CFG, { op: "unlike", like_uri: "at://did:plc:muninn/app.bsky.feed.like/rkey1" }, deps);
  eq("unlike: deletes the like record", byPath(calls, "deleteRecord")[1].body,
     { repo: "did:plc:muninn", collection: "app.bsky.feed.like", rkey: "rkey1" });

  const r = await bsky(CFG, { op: "resolve_handle", handle: "@alice.test" }, deps);
  eq("resolve_handle: public app-view, no session, @ stripped", r, "alice.test → did:plc:alice");
  eq("resolve_handle: hits public.api first", byPath(calls, "resolveHandle")[0].url.startsWith(APPVIEW_PUBLIC), true);
  eq("public reads sent no Authorization", byPath(calls, "resolveHandle").every((c) => !("authorization" in c.headers)), true);
}
{
  const { calls, deps } = fake(routes((c) =>
    c.url.startsWith(APPVIEW_PUBLIC) ? new Response("forbidden", { status: 403 }) : undefined));
  const r = await bsky(CFG, { op: "resolve_handle", handle: "bob.test" }, deps);
  eq("app-view 403 falls back to api.bsky.app", [r, byPath(calls, "resolveHandle").map((c) => new URL(c.url).origin)],
     ["bob.test → did:plc:bob", [APPVIEW_PUBLIC, APPVIEW_FALLBACK]]);
}

// ---------------------------------------------------------------- thread_repliers

const THREAD = {
  thread: {
    post: { author: { did: "did:plc:root", handle: "root.test" }, record: { text: "op" } },
    replies: [
      { post: { author: { did: "did:plc:a", handle: "a.test", displayName: "A" }, record: { text: "first" } },
        replies: [
          { post: { author: { did: "did:plc:root", handle: "root.test" }, record: { text: "self-reply" } },
            replies: [
              { post: { author: { did: "did:plc:a", handle: "a.test", displayName: "A" }, record: { text: "again\nmore" } } },
            ] },
          { post: { author: { did: "did:plc:b", handle: "b.test" }, record: { text: "  second  " } } },
        ] },
      { $type: "app.bsky.feed.defs#blockedPost", blocked: true },
    ],
  },
};
{
  const rs = extractRepliers(THREAD.thread as Record<string, unknown>);
  eq("extractRepliers: deduped by DID, root excluded, nested walked",
     rs.map((r) => [r.did, r.texts]), [["did:plc:a", ["first", "again\nmore"]], ["did:plc:b", ["second"]]]);
}
{
  const { calls, deps } = fake(routes((c) => c.url.includes("getPostThread") ? THREAD : undefined));
  const out = await bsky(CFG, { op: "thread_repliers", post_url: "https://bsky.app/profile/root.test/post/3abc" }, deps);
  const q = new URL(byPath(calls, "getPostThread")[0].url).searchParams;
  eq("thread_repliers: URL resolved to an at-uri, depth default 6, parentHeight 0",
     [q.get("uri"), q.get("depth"), q.get("parentHeight")], ["at://did:plc:root/app.bsky.feed.post/3abc", "6", "0"]);
  eq("thread_repliers: one line per replier with DID, handle and joined text", out,
     "2 repliers on at://did:plc:root/app.bsky.feed.post/3abc:\n" +
     "- @a.test (did:plc:a) \"A\": first ⏎ again more\n" +
     "- @b.test (did:plc:b): second");
  eq("thread_repliers made no createSession", byPath(calls, "createSession").length, 0);
}

// ---------------------------------------------------------------- mute / block

{
  _resetSessionCache();
  const { calls, deps } = fake(routes());
  const dry = await bsky(CFG, { op: "mute", actors: ["a.test", "did:plc:b"], dry_run: true }, deps);
  eq("mute dry_run reports and writes nothing", [dry.startsWith("DRY RUN — would mute 2 actors as muninn"), calls.length], [true, 0]);
  const dryB = await bsky(CFG, { op: "block", actors: ["a.test"], dry_run: true, account: "oskar" }, deps);
  eq("block dry_run names the account and makes no network call", [dryB.includes("as oskar"), calls.length], [true, 0]);

  const out = await bsky(CFG, { op: "mute", actors: ["a.test", "did:plc:b"] }, deps);
  eq("mute: muteActor per resolved DID", byPath(calls, "muteActor").map((c) => c.body), [{ actor: "did:plc:a" }, { actor: "did:plc:b" }]);
  eq("mute: a DID skips resolution", byPath(calls, "resolveHandle").length, 1);
  eq("mute: report", out, "mute as @muninn.test:\n- a.test: muted\n- did:plc:b: muted");

  const blk = await bsky(CFG, { op: "block", actors: ["c.test"], account: "oskar" }, deps);
  const b = byPath(calls, "createRecord")[0].body as { repo: string; collection: string; record: Record<string, unknown> };
  eq("block: graph.block record in Oskar's repo", [b.repo, b.collection, b.record.subject], ["did:plc:oskar", "app.bsky.graph.block", "did:plc:c"]);
  eq("block: Oskar's JWT, not Muninn's", byPath(calls, "createRecord")[0].headers["authorization"], `Bearer ${JWT_OSKAR}`);
  eq("block: report carries the record uri", blk, "block as @oskar.test:\n- c.test: blocked (at://did:plc:oskar/app.bsky.graph.block/rkey1)");
}
{
  _resetSessionCache();
  const { deps } = fake(routes((c) => c.url.includes("muteActor") ? new Response("nope", { status: 400 }) : undefined));
  const out = await bsky(CFG, { op: "mute", actors: ["a.test"] }, deps);
  eq("mute: a per-actor failure is reported inline, not thrown", out, "mute as @muninn.test:\n- a.test: ERROR app.bsky.graph.muteActor failed (HTTP 400): nope");
}

// ---------------------------------------------------------------- list_records / list_build

{
  _resetSessionCache();
  const { calls, deps } = fake(routes((c) => c.url.includes("listRecords")
    ? { records: [{ uri: "at://did:plc:muninn/app.bsky.graph.list/1", value: { name: "L" } }], cursor: "c2" } : undefined));
  const out = await bsky(CFG, { op: "list_records", collection: "app.bsky.graph.list", limit: 500 }, deps);
  const q = new URL(byPath(calls, "listRecords")[0].url).searchParams;
  eq("list_records: default repo is the account's DID via public resolve, limit capped",
     [q.get("repo"), q.get("collection"), q.get("limit"), byPath(calls, "createSession").length], ["did:plc:muninn", "app.bsky.graph.list", "100", 0]);
  eq("list_records: renders uri + value and the cursor", out,
     "1 app.bsky.graph.list record in did:plc:muninn:\n- at://did:plc:muninn/app.bsky.graph.list/1\n    {\"name\":\"L\"}\n(more available; cursor c2)");
}
{
  _resetSessionCache();
  const members = Array.from({ length: 101 }, (_, i) => (i === 100 ? "m0.test" : `m${i}.test`));
  const { calls, deps } = fake(routes());
  const out = await bsky(CFG, { op: "list_build", name: "Cyclists", purpose: "modlist", members, description: "d" }, deps);
  const cr = byPath(calls, "createRecord")[0].body as { collection: string; record: Record<string, unknown> };
  eq("list_build: graph.list record with the NSID purpose", [cr.collection, cr.record.purpose, cr.record.name, cr.record.description],
     ["app.bsky.graph.list", "app.bsky.graph.defs#modlist", "Cyclists", "d"]);
  const aw = byPath(calls, "applyWrites").map((c) => (c.body as { writes: Array<{ value: { subject: string; list: string } }> }).writes);
  eq("list_build: duplicates deduped by DID, so 100 items fit one batch", [aw.length, aw[0].length, LIST_BATCH], [1, 100, 100]);
  eq("list_build: listitems point at the new list", aw[0][0].value, { $type: "app.bsky.graph.listitem", subject: "did:plc:m0", list: "at://did:plc:muninn/app.bsky.graph.list/rkey1", createdAt: "2026-09-19T14:00:00.000Z" });
  eq("list_build: returns the list uri and url", out,
     "Created modlist \"Cyclists\" as @muninn.test: https://bsky.app/profile/muninn.test/lists/rkey1\nuri: at://did:plc:muninn/app.bsky.graph.list/rkey1\nmembers added: 100");
}

// ---------------------------------------------------------------- redaction

{
  _resetSessionCache();
  // A hostile PDS that echoes the request back in every error body.
  const { deps } = fake(routes((c) => c.url.includes("createSession")
    ? new Response(`bad login for ${JSON.stringify(c.body)} Authorization: Bearer ${JWT_MUNINN}`, { status: 401 }) : undefined));
  const err = await bsky(CFG, { op: "whoami" }, deps).catch((e: Error) => e.message);
  eq("createSession failure never carries the app password", err.includes(MUNINN_PW) || err.includes(OSKAR_PW), false);
  eq("createSession failure keeps the status", err.startsWith("com.atproto.server.createSession failed (HTTP 401)"), true);
}
{
  _resetSessionCache();
  const { deps } = fake(routes((c) => c.url.includes("createRecord")
    ? new Response(`rejected: ${c.headers["authorization"]} / ${MUNINN_PW} / ${OSKAR_PW}`, { status: 400 }) : undefined));
  const err = await bsky(CFG, { op: "post", text: "hi" }, deps).catch((e: Error) => e.message);
  eq("a post failure quoting the request leaks neither JWT nor passwords",
     [err.includes(JWT_MUNINN), err.includes(MUNINN_PW), err.includes(OSKAR_PW)], [false, false, false]);
  eq("the redaction leaves a readable message", err, "com.atproto.repo.createRecord failed (HTTP 400): rejected: Bearer [REDACTED] / [REDACTED] / [REDACTED]");
}
{
  _resetSessionCache();
  const { deps } = fake(routes((c) => c.url.includes("createRecord")
    ? new Response(`token ${JWT_MUNINN} seen`, { status: 400 }) : undefined));
  const err = await bsky(CFG, { op: "post", text: "hi" }, deps).catch((e: Error) => e.message);
  eq("a bare JWT (no Bearer prefix) is redacted from the cached session", err, "com.atproto.repo.createRecord failed (HTTP 400): token [REDACTED] seen");
}
{
  _resetSessionCache();
  let n = 0;
  const { calls, deps } = fake(routes((c) => c.url.includes("createRecord") && n++ < 2
    ? new Response("busy", { status: 503 }) : undefined));
  const out = await bsky(CFG, { op: "post", text: "retry me" }, deps);
  eq("transient 503 is retried and then succeeds", [out.startsWith("Posted"), byPath(calls, "createRecord").length], [true, 3]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
