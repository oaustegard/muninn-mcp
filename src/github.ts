/**
 * `github` tool — a port of muninn_utils/gh_proxy.py to the worker.
 *
 * Blue's gh_proxy exists to survive the session egress proxy: it tries
 * api.github.com directly, detects Anthropic's 403 interception and falls back
 * to gh-api-proxy (a Cloudflare Worker that forwards `Authorization` verbatim).
 * This worker IS that far side — a Workers egress has no interception, the
 * token is a bound secret rather than a container placeholder — so the proxy
 * fallback, the placeholder-token dance and the three-way 403 disambiguation
 * all collapse. What remains is the semantics of the four functions callers
 * actually use: `rest`, `graphql`, `commit_files`, `open_pr`.
 *
 * One tool with an `op` discriminator, not four: the server's tool budget
 * (docs/mcp-migration.md §2) is spent in every conversation on the connector,
 * and these four share a token, a host, a header set and an error vocabulary.
 *
 * Only `fetch` is injected. Tests drive every op through a recording fake and
 * never touch the network.
 */

import * as z from "zod/v4";
import { sanitizeError } from "./tools.ts";
import { withRetry } from "./turso.ts";

export interface GithubConfig {
  GITHUB_TOKEN: string;
}

export interface GithubDeps {
  fetch: typeof fetch;
  /** Injectable so tests can exercise the retry path without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

export const defaultGithubDeps: GithubDeps = { fetch: globalThis.fetch };

export const GITHUB_API = "https://api.github.com";
/** GitHub 401s without a User-Agent — see ops github-procedures §2. */
export const GITHUB_USER_AGENT = "muninn-mcp";
export const GITHUB_API_VERSION = "2022-11-28";
export const DEFAULT_ACCEPT = "application/vnd.github+json";

/**
 * Response bodies are model context. A raw file read or a paginated listing
 * can run to megabytes; nothing a caller does with the tail of that is worth
 * what it costs every subsequent turn. Cap and say so.
 */
export const MAX_BODY_CHARS = 60_000;

export const GITHUB_TOOL_DESCRIPTION =
  "GitHub API access with Muninn's token. op 'rest' calls any REST path " +
  "(GET by default; pass method/body for writes, accept for raw content); " +
  "'graphql' runs a query with optional variables; 'commit_files' commits a " +
  "set of files atomically via the Git Data API (blob/tree/commit/ref), " +
  "preserving existing file modes and creating the branch from base when " +
  "new_branch is true; 'open_pr' opens a pull request from head into base. " +
  "Errors carry the HTTP status and GitHub's message. Bodies are capped at " +
  "60k characters.";

export const githubInputSchema = z.object({
  op: z
    .enum(["rest", "graphql", "commit_files", "open_pr"])
    .describe("Which operation to run."),
  // rest
  path: z.string().optional().describe("rest: API path starting with '/', e.g. '/repos/o/r/contents/README.md'."),
  method: z
    .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
    .optional()
    .describe("rest: HTTP method (default GET)."),
  body: z.unknown().optional().describe("rest/open_pr: JSON request body (rest) or PR description (open_pr)."),
  accept: z
    .string()
    .optional()
    .describe("rest: Accept header (default application/vnd.github+json; use application/vnd.github.raw for file contents)."),
  // graphql
  query: z.string().optional().describe("graphql: the query document."),
  variables: z.record(z.string(), z.unknown()).optional().describe("graphql: query variables."),
  // commit_files / open_pr
  repo: z.string().optional().describe("commit_files/open_pr: 'owner/name'."),
  branch: z.string().optional().describe("commit_files: branch to commit to."),
  files: z
    .record(z.string(), z.string())
    .optional()
    .describe("commit_files: {path: content} — every file goes in one commit."),
  message: z.string().optional().describe("commit_files: commit message."),
  base: z.string().optional().describe("commit_files/open_pr: base branch (default 'main')."),
  new_branch: z
    .boolean()
    .optional()
    .describe("commit_files: create `branch` from `base` (default false — commit onto the existing branch)."),
  modes: z
    .record(z.string(), z.string())
    .optional()
    .describe("commit_files: {path: '100755'} to force a file mode; unlisted paths keep their current mode, new files get 100644."),
  head: z.string().optional().describe("open_pr: head branch."),
  title: z.string().optional().describe("open_pr: PR title."),
});

export type GithubArgs = z.infer<typeof githubInputSchema>;

/** Carries the status so callers that branch on it (the 422 ref race) can. */
export class GithubError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

interface RawResponse {
  status: number;
  text: string;
  /** Parsed body when it was JSON, else undefined. */
  json: unknown;
}

interface CallOpts {
  method?: string;
  body?: unknown;
  accept?: string;
}

/**
 * One request to api.github.com. Port of gh_proxy.call minus the transport
 * rule: no direct/proxy split, no latch, no X-Proxy-Key.
 *
 * Retries ride on `withRetry` and its needle list: a 429 or 5xx is thrown with
 * a message the retriable check recognises, everything else is returned to the
 * caller as data. A 404 is an answer, not a transient.
 */
async function call(
  config: GithubConfig,
  deps: GithubDeps,
  path: string,
  opts: CallOpts = {},
): Promise<RawResponse> {
  if (!path.startsWith("/")) throw new GithubError(`path must start with '/': ${path}`);
  const method = (opts.method ?? "GET").toUpperCase();
  const accept = opts.accept ?? DEFAULT_ACCEPT;
  const headers: Record<string, string> = {
    "User-Agent": GITHUB_USER_AGENT,
    Authorization: `Bearer ${config.GITHUB_TOKEN}`,
    Accept: accept,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload !== undefined) headers["Content-Type"] = "application/json";

  return withRetry(async () => {
    const res = await deps.fetch(GITHUB_API + path, { method, headers, body: payload });
    const text = await res.text();
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      // "Service Unavailable" is on turso.ts's RETRIABLE_ERRORS list; the
      // status is included so a caller reading the final failure sees it.
      throw new GithubError(
        `GitHub HTTP ${res.status} Service Unavailable on ${method} ${path}: ${text.slice(0, 200)}`,
        res.status,
      );
    }
    let json: unknown;
    const isJson = accept.includes("json") ||
      (res.headers.get("content-type") ?? "").includes("json");
    if (isJson && text) {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    return { status: res.status, text, json };
  }, { sleep: deps.sleep });
}

/** GitHub's error bodies are `{message, documentation_url, errors?}`. */
function apiMessage(r: RawResponse): string {
  const j = r.json;
  if (j && typeof j === "object" && !Array.isArray(j)) {
    const doc = j as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof doc.message === "string") parts.push(doc.message);
    if (doc.errors !== undefined) parts.push(JSON.stringify(doc.errors));
    if (parts.length) return parts.join(" ").slice(0, 400);
  }
  return r.text.slice(0, 400);
}

/** Port of gh_proxy._ok: 200/201 pass, anything else is a GithubError. */
function ok(r: RawResponse, what: string): Record<string, unknown> {
  if (r.status !== 200 && r.status !== 201) {
    throw new GithubError(`${what} -> HTTP ${r.status}: ${apiMessage(r)}`, r.status);
  }
  return (r.json ?? {}) as Record<string, unknown>;
}

export function truncate(text: string, max = MAX_BODY_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) +
    `\n\n[truncated: ${text.length} chars total, showing first ${max}]`;
}

function render(r: RawResponse): string {
  const body = r.json === undefined ? r.text : JSON.stringify(r.json, null, 2);
  return truncate(`HTTP ${r.status}\n${body}`);
}

/** UTF-8 → base64, the way the Git Data blob endpoint wants it. */
export function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ------------------------------------------------------------------- ops

async function opRest(config: GithubConfig, args: GithubArgs, deps: GithubDeps): Promise<string> {
  const path = String(args.path ?? "").trim();
  if (!path) throw new GithubError("rest: `path` is required.");
  const method = args.method ?? "GET";
  const r = await call(config, deps, path, { method, body: args.body, accept: args.accept });
  if (r.status < 200 || r.status >= 300) {
    throw new GithubError(`${method} ${path} -> HTTP ${r.status}: ${apiMessage(r)}`, r.status);
  }
  return render(r);
}

async function opGraphql(config: GithubConfig, args: GithubArgs, deps: GithubDeps): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) throw new GithubError("graphql: `query` is required.");
  const payload: Record<string, unknown> = { query };
  if (args.variables && Object.keys(args.variables).length) payload.variables = args.variables;
  const r = await call(config, deps, "/graphql", { method: "POST", body: payload });
  if (r.status !== 200) {
    throw new GithubError(`graphql HTTP ${r.status}: ${apiMessage(r)}`, r.status);
  }
  const doc = (r.json ?? {}) as Record<string, unknown>;
  if (Array.isArray(doc.errors) && doc.errors.length) {
    throw new GithubError(`graphql errors: ${JSON.stringify(doc.errors).slice(0, 600)}`, 200);
  }
  return truncate(JSON.stringify(doc.data ?? {}, null, 2));
}

/**
 * Port of gh_proxy._existing_modes. The Git Data API has no "keep the current
 * mode" — every tree entry must state one — so a writer that hardcodes 100644
 * strips the executable bit off any script it touches (claude-skills PR #765).
 * One tree read per distinct directory recovers the real modes; a recursive
 * whole-tree read returns truncated=true on large repos and fails the same way
 * silently.
 */
async function existingModes(
  config: GithubConfig,
  deps: GithubDeps,
  repo: string,
  treeSha: string,
  paths: string[],
): Promise<Record<string, string>> {
  const modes: Record<string, string> = {};
  const dirs = new Map<string, string[]>();
  for (const p of paths) {
    const i = p.lastIndexOf("/");
    const head = i < 0 ? "" : p.slice(0, i);
    const name = i < 0 ? p : p.slice(i + 1);
    const list = dirs.get(head) ?? [];
    list.push(name);
    dirs.set(head, list);
  }
  for (const [head, names] of dirs) {
    const ref = head
      ? `${treeSha}:${head.split("/").map(encodeURIComponent).join("/")}`
      : treeSha;
    const r = await call(config, deps, `/repos/${repo}/git/trees/${ref}`);
    if (r.status !== 200 || !r.json || typeof r.json !== "object") continue; // new directory
    const tree = (r.json as { tree?: Array<Record<string, unknown>> }).tree ?? [];
    const entries: Record<string, string> = {};
    for (const t of tree) {
      if (t.type === "blob" && typeof t.path === "string" && typeof t.mode === "string") {
        entries[t.path] = t.mode;
      }
    }
    for (const name of names) {
      const mode = entries[name];
      if (mode) modes[head ? `${head}/${name}` : name] = mode;
    }
  }
  return modes;
}

/**
 * Port of gh_proxy.commit_files: blob/tree/commit/ref via the Git Data API.
 * Not the Contents API — one commit for N files, and it is the path that
 * respects modes.
 */
async function opCommitFiles(config: GithubConfig, args: GithubArgs, deps: GithubDeps): Promise<string> {
  const repo = String(args.repo ?? "").trim();
  const branch = String(args.branch ?? "").trim();
  const message = String(args.message ?? "");
  const files = args.files ?? {};
  if (!repo || !branch) throw new GithubError("commit_files: `repo` and `branch` are required.");
  if (!message.trim()) throw new GithubError("commit_files: `message` is required.");
  if (!Object.keys(files).length) throw new GithubError("commit_files: `files` must name at least one path.");
  const base = args.base ?? "main";
  const forced = { ...(args.modes ?? {}) };

  const ref = ok(await call(config, deps, `/repos/${repo}/git/ref/heads/${base}`), `read ref ${base}`);
  const baseSha = String((ref.object as Record<string, unknown> | undefined)?.sha ?? "");
  if (!baseSha) throw new GithubError(`read ref ${base}: response carried no object.sha`);

  const baseCommit = ok(await call(config, deps, `/repos/${repo}/git/commits/${baseSha}`), `read commit ${baseSha}`);
  const baseTree = String((baseCommit.tree as Record<string, unknown> | undefined)?.sha ?? "");
  if (!baseTree) throw new GithubError(`read commit ${baseSha}: response carried no tree.sha`);

  const inherited = await existingModes(
    config, deps, repo, baseTree,
    Object.keys(files).filter((p) => !(p in forced)),
  );

  const entries: Array<Record<string, unknown>> = [];
  for (const [path, content] of Object.entries(files)) {
    const blob = ok(
      await call(config, deps, `/repos/${repo}/git/blobs`, {
        method: "POST",
        body: { content: base64Utf8(content), encoding: "base64" },
      }),
      `create blob ${path}`,
    );
    const mode = forced[path] || inherited[path] || "100644";
    entries.push({ path, mode, type: "blob", sha: blob.sha });
  }

  const tree = ok(
    await call(config, deps, `/repos/${repo}/git/trees`, {
      method: "POST",
      body: { base_tree: baseTree, tree: entries },
    }),
    "create tree",
  );

  const commit = ok(
    await call(config, deps, `/repos/${repo}/git/commits`, {
      method: "POST",
      body: { message, tree: tree.sha, parents: [baseSha] },
    }),
    "create commit",
  );
  const sha = String(commit.sha);

  if (args.new_branch) {
    let out = await call(config, deps, `/repos/${repo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha },
    });
    if (out.status === 422 && out.text.includes("already exists")) {
      out = await call(config, deps, `/repos/${repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: { sha, force: true },
      });
    }
    ok(out, `create ref ${branch}`);
  } else {
    ok(
      await call(config, deps, `/repos/${repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: { sha },
      }),
      `update ref ${branch}`,
    );
  }

  const n = Object.keys(files).length;
  return `Committed ${sha} to ${repo}@${branch} (${n} file${n === 1 ? "" : "s"})\n` +
    `https://github.com/${repo}/commit/${sha}`;
}

async function opOpenPr(config: GithubConfig, args: GithubArgs, deps: GithubDeps): Promise<string> {
  const repo = String(args.repo ?? "").trim();
  const head = String(args.head ?? "").trim();
  const title = String(args.title ?? "").trim();
  if (!repo || !head || !title) throw new GithubError("open_pr: `repo`, `head` and `title` are required.");
  const body = args.body === undefined || args.body === null ? "" : String(args.body);
  const pr = ok(
    await call(config, deps, `/repos/${repo}/pulls`, {
      method: "POST",
      body: { head, base: args.base ?? "main", title, body },
    }),
    "open pr",
  );
  return `PR #${pr.number} opened: ${pr.html_url}`;
}

/**
 * The tool body. Errors are re-thrown sanitized, so even a GitHub error body
 * that echoed a request header cannot carry the token out; `server.ts`'s
 * `errorText` runs on top of that, which is harmless.
 */
export async function github(
  config: GithubConfig,
  args: GithubArgs,
  deps: GithubDeps = defaultGithubDeps,
): Promise<string> {
  if (!config.GITHUB_TOKEN) throw new GithubError("GITHUB_TOKEN is not configured.");
  try {
    switch (args.op) {
      case "rest": return await opRest(config, args, deps);
      case "graphql": return await opGraphql(config, args, deps);
      case "commit_files": return await opCommitFiles(config, args, deps);
      case "open_pr": return await opOpenPr(config, args, deps);
      default: throw new GithubError(`unknown op '${String((args as { op?: unknown }).op)}'.`);
    }
  } catch (err) {
    const status = err instanceof GithubError ? err.status : 0;
    throw new GithubError(sanitizeError(err), status);
  }
}
