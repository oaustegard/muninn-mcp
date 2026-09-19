/**
 * `bsky` — one tool, an `op` discriminator, two accounts.
 *
 * Port of the network primitives in muninn-utilities' `bsky_card.py`
 * (session, resolveHandle, uploadBlob, createRecord, the link-card embed and
 * facet logic), `bsky_list.py` (listRecords, list + listitem CRUD) and
 * `bsky_moderation.py` (getPostThread reply extraction, muteActor, block).
 *
 * IDENTITY. `bsky_list.py` records why the credential pair is chosen by an
 * explicit parameter and never by which variable happens to be set: the
 * unprefixed BSKY_* pair is Oskar's account, and a read-only skill once ended
 * up holding a write-scoped app password on it by picking that pair up
 * silently. Here `account` selects the pair, defaults to Muninn, and nothing
 * else in this file touches `config.BSKY_*` directly — `credentialsFor` is the
 * one place the two pairs are named, so they cannot be mixed.
 *
 * SECRETS. Every throw leaves through `bsky()`'s single catch, which redacts the
 * app passwords and any cached JWT out of the message before `errorText` in
 * server.ts sees it. Header patterns are handled by `sanitizeError` (tools.ts);
 * this adds the literal secret values, because a PDS error body or a fetch
 * failure could in principle quote the request.
 */

import * as z from "zod/v4";
import { sanitizeError } from "./tools.ts";

// ------------------------------------------------------------------ config

export interface BskyConfig {
  /** Oskar's account — the unprefixed pair. Selected only by `account: "oskar"`. */
  BSKY_HANDLE: string;
  BSKY_APP_PASSWORD: string;
  /** Muninn's account — the default. */
  MUNINN_BSKY_HANDLE: string;
  MUNINN_BSKY_APP_PASSWORD: string;
  /** PDS base for authed calls. Default https://bsky.social. */
  BSKY_PDS?: string;
}

export interface BskyDeps {
  fetch: typeof fetch;
  /** Epoch milliseconds — stamps `createdAt` and gates the session cache. */
  now: () => number;
  /** Injectable backoff so tests can drive the retry loop without timers. */
  sleep?: (ms: number) => Promise<void>;
}

export const defaultBskyDeps: BskyDeps = {
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
};

export const PDS_DEFAULT = "https://bsky.social";
/** App-view for public reads. `public.api.*` 403s from some egress paths (see
 *  bsky_moderation.py:27), so `api.bsky.app` is the fallback on 403. */
export const APPVIEW_PUBLIC = "https://public.api.bsky.app";
export const APPVIEW_FALLBACK = "https://api.bsky.app";
export const BSKY_GRAPHEME_LIMIT = 300;
/** applyWrites caps a batch at 200; chunking at 100 leaves headroom (bsky_list.py). */
export const LIST_BATCH = 100;

export const LIST_PURPOSES = {
  curatelist: "app.bsky.graph.defs#curatelist",
  modlist: "app.bsky.graph.defs#modlist",
  referencelist: "app.bsky.graph.defs#referencelist",
} as const;

export type BskyAccount = "muninn" | "oskar";

// ------------------------------------------------------------------ schema

export const bskyInputSchema = z.object({
  op: z
    .enum([
      "whoami", "post", "delete_post", "like", "unlike", "resolve_handle",
      "thread_repliers", "mute", "block", "list_records", "list_build",
    ])
    .describe("Which operation to run."),
  account: z
    .enum(["muninn", "oskar"])
    .default("muninn")
    .describe("Whose credentials to act with. Default 'muninn'; 'oskar' must be explicit."),
  text: z.string().optional().describe("post: the post text. `[label](url)` markdown becomes a link facet at zero grapheme cost."),
  link: z.string().optional().describe("post: URL to attach as an external link card; appended to the text unless already linked."),
  title: z.string().optional().describe("post: link-card title (recommended when `link` is set)."),
  description: z.string().optional().describe("post: link-card description. list_build: the list description."),
  image_url: z.string().optional().describe("post: image URL to fetch and upload as the card thumbnail."),
  uri: z.string().optional().describe("delete_post, like: the at:// URI of the post."),
  cid: z.string().optional().describe("like: the CID of the post being liked."),
  like_uri: z.string().optional().describe("unlike: the at:// URI of the like record (as returned by like)."),
  handle: z.string().optional().describe("resolve_handle: the handle to resolve to a DID."),
  post_url: z.string().optional().describe("thread_repliers: a bsky.app post URL or an at:// post URI."),
  depth: z.number().optional().describe("thread_repliers: reply depth to walk (default 6, max 1000)."),
  actors: z.array(z.string()).optional().describe("mute, block: handles or DIDs to act on."),
  dry_run: z.boolean().optional().describe("mute, block: when true, report what would happen and write nothing (default false)."),
  collection: z.string().optional().describe("list_records: the NSID to list, e.g. app.bsky.graph.list."),
  repo: z.string().optional().describe("list_records: DID or handle of the repo (default: the selected account)."),
  limit: z.number().optional().describe("list_records: max records (default 50, max 100)."),
  name: z.string().optional().describe("list_build: the list name."),
  purpose: z.enum(["curatelist", "modlist", "referencelist"]).optional().describe("list_build: curatelist feeds a custom feed, modlist drives mutes/blocks, referencelist backs a starter pack. Default curatelist."),
  members: z.array(z.string()).optional().describe("list_build: handles or DIDs to add to the new list."),
});

export type BskyArgs = z.input<typeof bskyInputSchema>;

export const BSKY_TOOL_DESCRIPTION =
  "Act on Bluesky as Muninn or as Oskar. `account` selects the credential pair and " +
  "defaults to 'muninn'; pass account:'oskar' explicitly to post, like, mute, block or " +
  "build lists as Oskar — nothing lands in his repo by default. Ops: whoami; post " +
  "(text, optional link card with title/description/image_url; 300-grapheme limit " +
  "enforced before posting; `[label](url)` markdown becomes a facet); delete_post; " +
  "like/unlike; resolve_handle; thread_repliers (public read of a thread's repliers: " +
  "DID, handle, text); mute and block (lists of actors, dry_run to preview); " +
  "list_records (any collection in a repo); list_build (create a curate/mod/reference " +
  "list and add members). Returns at:// URIs and bsky.app URLs for anything created.";

// ---------------------------------------------------------------- transport

export class BskyHttpError extends Error {
  status: number;
  constructor(status: number, label: string, detail: string) {
    super(`${label} failed (HTTP ${status}): ${detail}`);
    this.name = "BskyHttpError";
    this.status = status;
  }
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);

function isTransient(err: unknown): boolean {
  if (err instanceof BskyHttpError) return TRANSIENT.has(err.status);
  // A fetch that never got a response (reset, DNS) is a TypeError in every
  // runtime; treat it as transient the way bsky_list.py treats URLError.
  return err instanceof TypeError;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Same shape as turso.ts `withRetry`, with the transient set bsky_list.py and
 * bsky_moderation.py agree on (429 and 5xx; 4xx is final). 3 attempts at
 * 500/1000 ms — the two Python modules use 3 and 4; the smaller budget suits a
 * Worker that is itself inside a client's tool-call timeout.
 */
async function withBskyRetry<T>(fn: () => Promise<T>, deps: BskyDeps, maxRetries = 3): Promise<T> {
  const sleep = deps.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries - 1) throw err;
      if (!isTransient(err)) throw err;
      await sleep(500 * 2 ** attempt * (1 + Math.random() * 0.5));
    }
  }
}

async function readJson(res: Response, label: string): Promise<Record<string, unknown>> {
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch { /* body unreadable */ }
    throw new BskyHttpError(res.status, label, detail);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function pdsBase(config: BskyConfig): string {
  return (config.BSKY_PDS || PDS_DEFAULT).replace(/\/+$/, "");
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
}

/** Unauthenticated GET against the app-view, falling back to api.bsky.app on 403. */
async function appviewGet(
  path: string,
  params: Record<string, string | number | undefined>,
  deps: BskyDeps,
): Promise<Record<string, unknown>> {
  const call = (base: string) =>
    withBskyRetry(async () => {
      const res = await deps.fetch(`${base}/xrpc/${path}?${query(params)}`, {
        headers: { "User-Agent": "muninn-mcp" },
      });
      return readJson(res, path);
    }, deps);
  try {
    return await call(APPVIEW_PUBLIC);
  } catch (err) {
    if (err instanceof BskyHttpError && err.status === 403) return call(APPVIEW_FALLBACK);
    throw err;
  }
}

/** Authenticated POST against the session's PDS. */
async function pdsPost(
  session: Session,
  path: string,
  body: unknown,
  deps: BskyDeps,
): Promise<Record<string, unknown>> {
  return withBskyRetry(async () => {
    const res = await deps.fetch(`${session.pds}/xrpc/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        "Content-Type": "application/json",
        "User-Agent": "muninn-mcp",
      },
      body: JSON.stringify(body),
    });
    return readJson(res, path);
  }, deps);
}

// ------------------------------------------------------------------ session

export interface Session {
  accessJwt: string;
  did: string;
  handle: string;
  pds: string;
}

interface CachedSession extends Session { exp: number }

/** Keyed by handle. Only populated when the JWT's `exp` decodes. */
const sessionCache = new Map<string, CachedSession>();

/** Test hook: the cache is module state and tests run in one process. */
export function _resetSessionCache(): void {
  sessionCache.clear();
}

/** The one place the two credential pairs are named. Values never leave here except into createSession. */
function credentialsFor(config: BskyConfig, account: BskyAccount): { handle: string; password: string; envNames: string } {
  const handle = (account === "oskar" ? config.BSKY_HANDLE : config.MUNINN_BSKY_HANDLE) ?? "";
  const password = (account === "oskar" ? config.BSKY_APP_PASSWORD : config.MUNINN_BSKY_APP_PASSWORD) ?? "";
  const envNames = account === "oskar"
    ? "BSKY_HANDLE / BSKY_APP_PASSWORD"
    : "MUNINN_BSKY_HANDLE / MUNINN_BSKY_APP_PASSWORD";
  return { handle: handle.trim(), password: password.trim(), envNames };
}

/** `exp` (epoch ms) from a JWT payload, or null when it is not trivially decodable. */
export function jwtExpiry(jwt: string): number | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64)) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** com.atproto.server.createSession, cached per handle until 60s before the JWT expires. */
export async function getSession(config: BskyConfig, account: BskyAccount, deps: BskyDeps): Promise<Session> {
  const { handle, password, envNames } = credentialsFor(config, account);
  if (!handle || !password) throw new Error(`bsky: ${envNames} are not configured for account '${account}'.`);
  const cached = sessionCache.get(handle);
  if (cached && cached.exp - 60_000 > deps.now()) return cached;

  const pds = pdsBase(config);
  const s = await withBskyRetry(async () => {
    const res = await deps.fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "muninn-mcp" },
      body: JSON.stringify({ identifier: handle, password }),
    });
    return readJson(res, "com.atproto.server.createSession");
  }, deps);
  const session: Session = {
    accessJwt: String(s.accessJwt ?? ""),
    did: String(s.did ?? ""),
    handle: String(s.handle ?? handle),
    pds,
  };
  if (!session.accessJwt || !session.did) throw new Error("bsky: createSession returned no session.");
  const exp = jwtExpiry(session.accessJwt);
  if (exp !== null) sessionCache.set(handle, { ...session, exp });
  return session;
}

// ---------------------------------------------------------- pure helpers

const utf8 = new TextEncoder();
const byteLen = (s: string): number => utf8.encode(s).length;

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; tag?: string }>;
}

/** Grapheme count per AT Proto (Bluesky counts graphemes, not code units). */
export function graphemeLength(text: string): number {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let n = 0;
  for (const _ of seg.segment(text)) n++;
  return n;
}

/**
 * URLs and #hashtags in `text` as facets with UTF-8 byte offsets.
 * Port of `compute_facets` (bsky_card.py:128). Python's `\w` is Unicode-aware,
 * so the hashtag pattern is written with property escapes rather than JS's
 * ASCII-only `\w`.
 */
export function computeFacets(text: string): Facet[] {
  const facets: Facet[] = [];
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    let url = m[0];
    while (url && ".,;:!?)\"'".includes(url[url.length - 1])) url = url.slice(0, -1);
    const start = byteLen(text.slice(0, m.index));
    facets.push({
      index: { byteStart: start, byteEnd: start + byteLen(url) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    });
  }
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu)) {
    const start = byteLen(text.slice(0, m.index));
    facets.push({
      index: { byteStart: start, byteEnd: start + byteLen(m[0]) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: m[1] }],
    });
  }
  return facets;
}

/**
 * Strip `[displayed](url)` markdown; the URL becomes a facet#link over the
 * displayed text and costs zero graphemes. Byte offsets reference the stripped
 * text. Port of `parse_markdown_links` (bsky_card.py:169).
 */
export function parseMarkdownLinks(text: string): { text: string; facets: Facet[] } {
  const facets: Facet[] = [];
  const parts: string[] = [];
  let pos = 0;
  let offset = 0;
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const before = text.slice(pos, m.index);
    parts.push(before);
    offset += byteLen(before);
    const label = m[1];
    facets.push({
      index: { byteStart: offset, byteEnd: offset + byteLen(label) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[2] }],
    });
    parts.push(label);
    offset += byteLen(label);
    pos = m.index + m[0].length;
  }
  parts.push(text.slice(pos));
  return { text: parts.join(""), facets };
}

function markdownTargets(facets: Facet[]): Set<string> {
  const out = new Set<string>();
  for (const f of facets) for (const feat of f.features) {
    if (feat.$type === "app.bsky.richtext.facet#link" && feat.uri !== undefined) out.add(feat.uri);
  }
  return out;
}

/**
 * The `record.text` a link post will carry: markdown stripped, and the target
 * URL appended on its own line unless it is already linked or literally
 * present. Port of `final_text_for_post` (bsky_card.py:220).
 */
export function finalTextForPost(text: string, url?: string): string {
  const { text: stripped, facets } = parseMarkdownLinks(text);
  if (url && !markdownTargets(facets).has(url) && !stripped.includes(url)) return `${stripped}\n${url}`;
  return stripped;
}

/** Everything `post` derives from its text before touching the network. */
export function composePostText(text: string, url?: string): { text: string; facets: Facet[] } {
  const { facets: md } = parseMarkdownLinks(text);
  const final = finalTextForPost(text, url);
  return { text: final, facets: [...md, ...computeFacets(final)] };
}

/** at://did/collection/rkey → its parts. */
export function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/.exec(uri.trim());
  if (!m) throw new Error(`bsky: not an at:// record URI: '${uri}'.`);
  return { repo: m[1], collection: m[2], rkey: m[3] };
}

const isoNow = (deps: BskyDeps): string => new Date(deps.now()).toISOString();

function postUrl(handle: string, uri: string): string {
  return `https://bsky.app/profile/${handle}/post/${uri.split("/").pop()}`;
}

// ------------------------------------------------------------- resolution

/** handle | DID → DID; a DID passes through without a round trip. */
async function resolveActor(actor: string, deps: BskyDeps): Promise<string> {
  const a = actor.trim().replace(/^@/, "");
  if (a.startsWith("did:")) return a;
  const r = await appviewGet("com.atproto.identity.resolveHandle", { handle: a }, deps);
  const did = String(r.did ?? "");
  if (!did) throw new Error(`bsky: could not resolve handle '${a}'.`);
  return did;
}

/** A bsky.app/profile/<actor>/post/<rkey> URL or an at:// URI → at:// URI. */
async function ensurePostUri(postUrl: string, deps: BskyDeps): Promise<string> {
  const s = postUrl.trim();
  if (s.startsWith("at://")) return s;
  const parts = s.replace(/\/+$/, "").split("/").filter(Boolean);
  const i = parts.indexOf("profile");
  const rkey = parts[parts.length - 1];
  const actor = i >= 0 ? parts[i + 1] : parts[parts.length - 3];
  if (!actor || !rkey || parts[parts.length - 2] !== "post") {
    throw new Error(`bsky: not a bsky.app post URL or at:// URI: '${s}'.`);
  }
  return `at://${await resolveActor(actor, deps)}/app.bsky.feed.post/${rkey}`;
}

// ------------------------------------------------------------------- ops

async function opWhoami(config: BskyConfig, account: BskyAccount, deps: BskyDeps): Promise<string> {
  const s = await getSession(config, account, deps);
  return `${account}: @${s.handle}\ndid: ${s.did}\npds: ${s.pds}`;
}

async function opResolveHandle(args: BskyArgs, deps: BskyDeps): Promise<string> {
  const handle = String(args.handle ?? "").trim().replace(/^@/, "");
  if (!handle) throw new Error("bsky: `handle` is required for resolve_handle.");
  return `${handle} → ${await resolveActor(handle, deps)}`;
}

/** Download an image and upload it as a blob (bsky_card.py:101). */
async function uploadBlob(session: Session, imageUrl: string, deps: BskyDeps): Promise<Record<string, unknown>> {
  const img = await deps.fetch(imageUrl, { headers: { "User-Agent": "muninn-mcp" } });
  if (!img.ok) throw new BskyHttpError(img.status, `fetch ${imageUrl}`, "");
  const data = await img.arrayBuffer();
  const contentType = img.headers.get("Content-Type") || "image/png";
  const r = await withBskyRetry(async () => {
    const res = await deps.fetch(`${session.pds}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": contentType },
      body: data,
    });
    return readJson(res, "com.atproto.repo.uploadBlob");
  }, deps);
  const blob = r.blob;
  if (!blob || typeof blob !== "object") throw new Error("bsky: uploadBlob returned no blob.");
  return blob as Record<string, unknown>;
}

async function opPost(config: BskyConfig, account: BskyAccount, args: BskyArgs, deps: BskyDeps): Promise<string> {
  const raw = String(args.text ?? "");
  if (!raw.trim()) throw new Error("bsky: `text` is required for post.");
  const link = args.link?.trim() || undefined;
  const { text, facets } = composePostText(raw, link);
  const n = graphemeLength(text);
  if (n > BSKY_GRAPHEME_LIMIT) {
    throw new Error(
      `bsky: post is ${n} graphemes; the limit is ${BSKY_GRAPHEME_LIMIT}` +
      (link ? " (measured after markdown strip and link append)" : "") + ". Nothing was posted.",
    );
  }

  const session = await getSession(config, account, deps);
  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: isoNow(deps),
    langs: ["en"],
  };
  if (facets.length) record.facets = facets;
  if (link) {
    const external: Record<string, unknown> = {
      uri: link,
      title: args.title ?? "",
      description: args.description ?? "",
    };
    if (args.image_url) external.thumb = await uploadBlob(session, args.image_url, deps);
    record.embed = { $type: "app.bsky.embed.external", external };
  }
  const r = await pdsPost(session, "com.atproto.repo.createRecord", {
    repo: session.did, collection: "app.bsky.feed.post", record,
  }, deps);
  const uri = String(r.uri ?? "");
  return `Posted as @${session.handle}: ${postUrl(session.handle, uri)}\nuri: ${uri}\ncid: ${String(r.cid ?? "")}`;
}

async function opDeletePost(config: BskyConfig, account: BskyAccount, args: BskyArgs, deps: BskyDeps): Promise<string> {
  const { collection, rkey } = parseAtUri(String(args.uri ?? ""));
  const session = await getSession(config, account, deps);
  await pdsPost(session, "com.atproto.repo.deleteRecord", { repo: session.did, collection, rkey }, deps);
  return `Deleted ${args.uri} from @${session.handle}.`;
}

async function opLike(config: BskyConfig, account: BskyAccount, args: BskyArgs, deps: BskyDeps): Promise<string> {
  const uri = String(args.uri ?? "").trim();
  const cid = String(args.cid ?? "").trim();
  if (!uri || !cid) throw new Error("bsky: like requires both `uri` and `cid`.");
  const session = await getSession(config, account, deps);
  const r = await pdsPost(session, "com.atproto.repo.createRecord", {
    repo: session.did,
    collection: "app.bsky.feed.like",
    record: { $type: "app.bsky.feed.like", subject: { uri, cid }, createdAt: isoNow(deps) },
  }, deps);
  return `Liked ${uri} as @${session.handle}.\nlike_uri: ${String(r.uri ?? "")}`;
}

async function opUnlike(config: BskyConfig, account: BskyAccount, args: BskyArgs, deps: BskyDeps): Promise<string> {
  const { collection, rkey } = parseAtUri(String(args.like_uri ?? ""));
  if (collection !== "app.bsky.feed.like") throw new Error(`bsky: '${args.like_uri}' is not a like record.`);
  const session = await getSession(config, account, deps);
  await pdsPost(session, "com.atproto.repo.deleteRecord", { repo: session.did, collection, rkey }, deps);
  return `Unliked: removed ${args.like_uri}.`;
}

interface Replier { did: string; handle: string; name: string; texts: string[] }

/**
 * Flatten a thread's replies, deduped by DID; a poster's several replies join
 * with ' ⏎ '. The root author is excluded. Port of `extract_thread_repliers`
 * (bsky_moderation.py:73) minus the self-exclusion — this is a public read and
 * takes no session.
 */
export function extractRepliers(thread: Record<string, unknown>): Replier[] {
  const root = thread.post as Record<string, unknown> | undefined;
  const rootDid = (root?.author as Record<string, unknown> | undefined)?.did;
  const acc = new Map<string, Replier>();
  const walk = (node: Record<string, unknown>): void => {
    const p = node.post as Record<string, unknown> | undefined;
    if (p) {
      const a = (p.author ?? {}) as Record<string, unknown>;
      const did = typeof a.did === "string" ? a.did : "";
      const txt = String(((p.record ?? {}) as Record<string, unknown>).text ?? "").trim();
      if (did && did !== rootDid) {
        let e = acc.get(did);
        if (!e) {
          e = { did, handle: String(a.handle ?? ""), name: String(a.displayName ?? ""), texts: [] };
          acc.set(did, e);
        }
        if (txt) e.texts.push(txt);
      }
    }
    for (const rep of (node.replies as Record<string, unknown>[] | undefined) ?? []) walk(rep);
  };
  for (const rep of (thread.replies as Record<string, unknown>[] | undefined) ?? []) walk(rep);
  return [...acc.values()];
}

async function opThreadRepliers(args: BskyArgs, deps: BskyDeps): Promise<string> {
  const uri = await ensurePostUri(String(args.post_url ?? ""), deps);
  const depth = Math.min(Math.max(Math.floor(Number(args.depth) || 6), 1), 1000);
  const r = await appviewGet("app.bsky.feed.getPostThread", { uri, depth, parentHeight: 0 }, deps);
  const repliers = extractRepliers((r.thread ?? {}) as Record<string, unknown>);
  if (repliers.length === 0) return `No repliers on ${uri}.`;
  const lines = repliers.map((x) =>
    `- @${x.handle} (${x.did})${x.name ? ` "${x.name}"` : ""}: ${x.texts.join(" ⏎ ").replace(/\n/g, " ")}`);
  return [`${repliers.length} replier${repliers.length === 1 ? "" : "s"} on ${uri}:`, ...lines].join("\n");
}

async function opModerate(
  kind: "mute" | "block",
  config: BskyConfig,
  account: BskyAccount,
  args: BskyArgs,
  deps: BskyDeps,
): Promise<string> {
  const actors = (args.actors ?? []).map((a) => a.trim()).filter(Boolean);
  if (actors.length === 0) throw new Error(`bsky: \`actors\` is required for ${kind}.`);
  if (args.dry_run) {
    return [`DRY RUN — would ${kind} ${actors.length} actor${actors.length === 1 ? "" : "s"} as ${account}; nothing written:`,
      ...actors.map((a) => `- ${a}`)].join("\n");
  }
  const session = await getSession(config, account, deps);
  const lines: string[] = [];
  for (const actor of actors) {
    try {
      const did = await resolveActor(actor, deps);
      if (kind === "mute") {
        await pdsPost(session, "app.bsky.graph.muteActor", { actor: did }, deps);
        lines.push(`- ${actor}: muted`);
      } else {
        const r = await pdsPost(session, "com.atproto.repo.createRecord", {
          repo: session.did,
          collection: "app.bsky.graph.block",
          record: { $type: "app.bsky.graph.block", subject: did, createdAt: isoNow(deps) },
        }, deps);
        lines.push(`- ${actor}: blocked (${String(r.uri ?? "")})`);
      }
    } catch (err) {
      // Per-actor failures are reported inline rather than thrown, so they
      // do not pass through bsky()'s catch — redact here as well.
      lines.push(`- ${actor}: ERROR ${redactSecrets(config, sanitizeError(err)).slice(0, 200)}`);
    }
  }
  return [`${kind} as @${session.handle}:`, ...lines].join("\n");
}

async function opListRecords(config: BskyConfig, account: BskyAccount, args: BskyArgs, deps: BskyDeps): Promise<string> {
  const collection = String(args.collection ?? "").trim();
  if (!collection) throw new Error("bsky: `collection` is required for list_records.");
  // The default repo is the selected account's — resolved through the public
  // app-view so a read never has to spend the app password.
  const repoArg = args.repo?.trim() || credentialsFor(config, account).handle;
  if (!repoArg) throw new Error(`bsky: no \`repo\` given and no handle configured for '${account}'.`);
  const repo = await resolveActor(repoArg, deps);
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 50), 1), 100);
  const r = await withBskyRetry(async () => {
    const res = await deps.fetch(
      `${pdsBase(config)}/xrpc/com.atproto.repo.listRecords?${query({ repo, collection, limit })}`,
      { headers: { "User-Agent": "muninn-mcp" } },
    );
    return readJson(res, "com.atproto.repo.listRecords");
  }, deps);
  const records = (r.records as Array<Record<string, unknown>> | undefined) ?? [];
  if (records.length === 0) return `No ${collection} records in ${repo}.`;
  const lines = records.map((rec) => `- ${String(rec.uri)}\n    ${JSON.stringify(rec.value)}`);
  const more = r.cursor ? `\n(more available; cursor ${String(r.cursor)})` : "";
  return [`${records.length} ${collection} record${records.length === 1 ? "" : "s"} in ${repo}:`, ...lines].join("\n") + more;
}

async function opListBuild(config: BskyConfig, account: BskyAccount, args: BskyArgs, deps: BskyDeps): Promise<string> {
  const name = String(args.name ?? "").trim();
  if (!name) throw new Error("bsky: `name` is required for list_build.");
  const purpose = args.purpose ?? "curatelist";
  const members = (args.members ?? []).map((m) => m.trim()).filter(Boolean);
  const session = await getSession(config, account, deps);

  const created = await pdsPost(session, "com.atproto.repo.createRecord", {
    repo: session.did,
    collection: "app.bsky.graph.list",
    record: {
      $type: "app.bsky.graph.list",
      purpose: LIST_PURPOSES[purpose],
      name,
      description: args.description ?? "",
      createdAt: isoNow(deps),
    },
  }, deps);
  const listUri = String(created.uri ?? "");

  // Dedupe by DID: atproto will happily store a second listitem for the same
  // subject, and the duplicate shows as a repeated row in every client.
  const dids: string[] = [];
  const seen = new Set<string>();
  const failed: string[] = [];
  for (const m of members) {
    try {
      const did = await resolveActor(m, deps);
      if (!seen.has(did)) { seen.add(did); dids.push(did); }
    } catch {
      failed.push(m);
    }
  }
  for (let i = 0; i < dids.length; i += LIST_BATCH) {
    await pdsPost(session, "com.atproto.repo.applyWrites", {
      repo: session.did,
      writes: dids.slice(i, i + LIST_BATCH).map((did) => ({
        $type: "com.atproto.repo.applyWrites#create",
        collection: "app.bsky.graph.listitem",
        value: { $type: "app.bsky.graph.listitem", subject: did, list: listUri, createdAt: isoNow(deps) },
      })),
    }, deps);
  }
  const url = `https://bsky.app/profile/${session.handle}/lists/${listUri.split("/").pop()}`;
  const out = [
    `Created ${purpose} "${name}" as @${session.handle}: ${url}`,
    `uri: ${listUri}`,
    `members added: ${dids.length}`,
  ];
  if (failed.length) out.push(`unresolved (skipped): ${failed.join(", ")}`);
  return out.join("\n");
}

// -------------------------------------------------------------- dispatch

/** Replace every configured secret value, and any cached JWT, in a message. */
function redactSecrets(config: BskyConfig, msg: string): string {
  const secrets = [
    config.BSKY_APP_PASSWORD, config.MUNINN_BSKY_APP_PASSWORD,
    ...[...sessionCache.values()].map((s) => s.accessJwt),
  ].filter((s): s is string => typeof s === "string" && s.length >= 4);
  let out = msg;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out;
}

export async function bsky(
  config: BskyConfig,
  args: BskyArgs,
  deps: BskyDeps = defaultBskyDeps,
): Promise<string> {
  const account: BskyAccount = args.account ?? "muninn";
  try {
    switch (args.op) {
      case "whoami": return await opWhoami(config, account, deps);
      case "post": return await opPost(config, account, args, deps);
      case "delete_post": return await opDeletePost(config, account, args, deps);
      case "like": return await opLike(config, account, args, deps);
      case "unlike": return await opUnlike(config, account, args, deps);
      case "resolve_handle": return await opResolveHandle(args, deps);
      case "thread_repliers": return await opThreadRepliers(args, deps);
      case "mute": return await opModerate("mute", config, account, args, deps);
      case "block": return await opModerate("block", config, account, args, deps);
      case "list_records": return await opListRecords(config, account, args, deps);
      case "list_build": return await opListBuild(config, account, args, deps);
      default: throw new Error(`bsky: unknown op '${String((args as { op?: unknown }).op)}'.`);
    }
  } catch (err) {
    // The only exit for a failure. Header patterns first (tools.ts), then the
    // literal secret values — a PDS body or a runtime's fetch error could quote
    // the request, and the message is about to become model context.
    throw new Error(redactSecrets(config, sanitizeError(err)));
  }
}
