/** `github` tool: request shapes, the commit_files sequence, errors, truncation — fetch faked. */
import {
  github, githubInputSchema, truncate, base64Utf8,
  GITHUB_TOOL_DESCRIPTION, MAX_BODY_CHARS, defaultGithubDeps,
  type GithubDeps,
} from "./github.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

const TOKEN = "ghp_SECRETSECRETSECRET";
const CFG = { GITHUB_TOKEN: TOKEN };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- recorded bodies are asserted structurally
interface Call { method: string; url: string; headers: Record<string, string>; body: any }
type Route = (c: Call) => { status?: number; body?: unknown; text?: string; contentType?: string };

/**
 * A recording fake fetch. `route` maps a call to a response; `body` is
 * JSON-encoded, `text` is sent verbatim (raw content). Headers are recorded
 * as given so the token's presence AND its value can be asserted.
 */
function fake(route: Route = () => ({ body: {} })) {
  const calls: Call[] = [];
  const fetchFake = (async (input: unknown, init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string>) };
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const c: Call = { method: init?.method ?? "GET", url: String(input), headers, body };
    calls.push(c);
    const r = route(c);
    const status = r.status ?? 200;
    const text = r.text !== undefined ? r.text : JSON.stringify(r.body ?? {});
    const contentType = r.contentType ?? (r.text !== undefined ? "text/plain" : "application/json");
    // undici refuses a body on a null-body status, even an empty one.
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : text, { status, headers: { "content-type": contentType } });
  }) as unknown as typeof fetch;
  const deps: GithubDeps = { fetch: fetchFake, sleep: async () => {} };
  return { calls, deps };
}

const thrown = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "<no error>"; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
const last = (s: string) => s.split("/").pop();

// ---------------------------------------------------------------- rest

{
  const { calls, deps } = fake(() => ({ body: { full_name: "o/r", private: false } }));
  const out = await github(CFG, { op: "rest", path: "/repos/o/r" }, deps);
  const c = calls[0];
  eq("rest GET url", c.url, "https://api.github.com/repos/o/r");
  eq("rest default method", c.method, "GET");
  eq("rest header set (token value elided)",
     { ...c.headers, Authorization: c.headers.Authorization.startsWith("Bearer ") ? "Bearer <token>" : "?" },
     {
       "User-Agent": "muninn-mcp",
       Authorization: "Bearer <token>",
       Accept: "application/vnd.github+json",
       "X-GitHub-Api-Version": "2022-11-28",
     });
  eq("rest sends the configured token", c.headers.Authorization, `Bearer ${TOKEN}`);
  eq("rest GET has no body or content-type", [c.body, c.headers["Content-Type"]], [undefined, undefined]);
  eq("rest renders status + pretty JSON", out, 'HTTP 200\n{\n  "full_name": "o/r",\n  "private": false\n}');
}

{
  const { calls, deps } = fake(() => ({ status: 201, body: { id: 7 } }));
  const out = await github(CFG, {
    op: "rest", path: "/repos/o/r/issues", method: "POST", body: { title: "t", labels: ["a"] },
  }, deps);
  eq("rest POST method", calls[0].method, "POST");
  eq("rest POST body is JSON-encoded", calls[0].body, { title: "t", labels: ["a"] });
  eq("rest POST sets content-type", calls[0].headers["Content-Type"], "application/json");
  eq("rest 201 is success", out.startsWith("HTTP 201\n"), true);
}

{
  const { calls, deps } = fake(() => ({ text: "#!/bin/sh\necho hi\n" }));
  const out = await github(CFG, {
    op: "rest", path: "/repos/o/r/contents/run.sh", accept: "application/vnd.github.raw",
  }, deps);
  eq("rest accept override is sent", calls[0].headers.Accept, "application/vnd.github.raw");
  eq("rest raw body is returned verbatim", out, "HTTP 200\n#!/bin/sh\necho hi\n");
}

{
  const { calls, deps } = fake(() => ({ status: 204, text: "" }));
  const out = await github(CFG, { op: "rest", path: "/repos/o/r/issues/1/labels/x", method: "DELETE" }, deps);
  eq("rest DELETE method", calls[0].method, "DELETE");
  eq("rest 204 renders an empty body", out, "HTTP 204\n");
}

{
  const { deps } = fake(() => ({ status: 404, body: { message: "Not Found", documentation_url: "https://docs.github.com/x" } }));
  const msg = await thrown(github(CFG, { op: "rest", path: "/repos/o/missing" }, deps));
  eq("rest non-2xx throws with status and API message", msg, "GET /repos/o/missing -> HTTP 404: Not Found");
}

{
  // A hostile body that echoes the request headers back must not leak the token.
  const { deps } = fake((c) => ({
    status: 401,
    body: { message: `Bad credentials for Authorization: ${c.headers.Authorization}` },
  }));
  const msg = await thrown(github(CFG, { op: "rest", path: "/user" }, deps));
  eq("rest error never carries the token", msg.includes(TOKEN), false);
  eq("rest error still names the status", msg.includes("HTTP 401"), true);
}

{
  const { deps } = fake();
  eq("rest requires path", await thrown(github(CFG, { op: "rest" }, deps)), "rest: `path` is required.");
  eq("rest rejects a relative path",
     await thrown(github(CFG, { op: "rest", path: "repos/o/r" }, deps)), "path must start with '/': repos/o/r");
}

{
  eq("missing token is refused before any call",
     await thrown(github({ GITHUB_TOKEN: "" }, { op: "rest", path: "/user" }, fake().deps)),
     "GITHUB_TOKEN is not configured.");
}

// ---------------------------------------------------------------- retry

{
  let n = 0;
  const { calls, deps } = fake(() => (++n < 3 ? { status: 503, text: "upstream" } : { body: { ok: true } }));
  const out = await github(CFG, { op: "rest", path: "/user" }, deps);
  eq("503 is retried until it succeeds", [calls.length, out], [3, 'HTTP 200\n{\n  "ok": true\n}']);
}

{
  const { calls, deps } = fake(() => ({ status: 503, text: "down" }));
  const msg = await thrown(github(CFG, { op: "rest", path: "/user" }, deps));
  eq("persistent 503 exhausts the 5-attempt budget", calls.length, 5);
  eq("final 503 error names the status", msg.includes("HTTP 503"), true);
}

{
  const { calls, deps } = fake(() => ({ status: 404, body: { message: "Not Found" } }));
  await thrown(github(CFG, { op: "rest", path: "/nope" }, deps));
  eq("404 is not retried", calls.length, 1);
}

// ---------------------------------------------------------------- truncation

{
  const big = "x".repeat(MAX_BODY_CHARS + 500);
  const { deps } = fake(() => ({ text: big }));
  const out = await github(CFG, { op: "rest", path: "/big", accept: "application/vnd.github.raw" }, deps);
  eq("oversized body is capped", out.length < big.length, true);
  eq("truncation note names the sizes",
     out.endsWith(`\n\n[truncated: ${MAX_BODY_CHARS + 509} chars total, showing first ${MAX_BODY_CHARS}]`), true);
  eq("truncate leaves short text alone", truncate("short", 10), "short");
}

// ---------------------------------------------------------------- graphql

{
  const { calls, deps } = fake(() => ({ body: { data: { viewer: { login: "oaustegard" } } } }));
  const out = await github(CFG, {
    op: "graphql", query: "query($n:Int){ viewer { login } }", variables: { n: 1 },
  }, deps);
  eq("graphql posts to /graphql", [calls[0].method, calls[0].url], ["POST", "https://api.github.com/graphql"]);
  eq("graphql body carries query and variables",
     calls[0].body, { query: "query($n:Int){ viewer { login } }", variables: { n: 1 } });
  eq("graphql returns data only", out, '{\n  "viewer": {\n    "login": "oaustegard"\n  }\n}');
}

{
  const { calls, deps } = fake(() => ({ body: { data: {} } }));
  await github(CFG, { op: "graphql", query: "{ viewer { login } }" }, deps);
  eq("graphql omits empty variables", calls[0].body, { query: "{ viewer { login } }" });
}

{
  const { deps } = fake(() => ({ body: { data: null, errors: [{ message: "Field 'nope' doesn't exist" }] } }));
  const msg = await thrown(github(CFG, { op: "graphql", query: "{ nope }" }, deps));
  eq("graphql errors surface as an error",
     msg, `graphql errors: ${JSON.stringify([{ message: "Field 'nope' doesn't exist" }])}`);
}

{
  const { deps } = fake(() => ({ status: 401, body: { message: "Bad credentials" } }));
  eq("graphql non-200 throws with status",
     await thrown(github(CFG, { op: "graphql", query: "{ viewer { login } }" }, deps)),
     "graphql HTTP 401: Bad credentials");
  eq("graphql requires query", await thrown(github(CFG, { op: "graphql" }, deps)), "graphql: `query` is required.");
}

// ---------------------------------------------------------------- commit_files

/** A fake repo: main at BASE_SHA, tree with scripts/run.sh executable and README.md plain. */
const BASE_SHA = "aaaa1111";
const BASE_TREE = "tree0000";
function repoRoute(over: Partial<Record<string, Route>> = {}): { route: Route; refCreates: number } {
  const state = { refCreates: 0 };
  const route: Route = (c) => {
    const p = c.url.replace("https://api.github.com", "");
    if (over[p]) return over[p]!(c);
    if (p === "/repos/o/r/git/ref/heads/main") return { body: { object: { sha: BASE_SHA } } };
    if (p === `/repos/o/r/git/commits/${BASE_SHA}`) return { body: { tree: { sha: BASE_TREE } } };
    if (p === `/repos/o/r/git/trees/${BASE_TREE}`) {
      return { body: { tree: [{ path: "README.md", type: "blob", mode: "100644" }, { path: "scripts", type: "tree", mode: "040000" }] } };
    }
    if (p === `/repos/o/r/git/trees/${BASE_TREE}:scripts`) {
      return { body: { tree: [{ path: "run.sh", type: "blob", mode: "100755" }] } };
    }
    if (p.startsWith(`/repos/o/r/git/trees/${BASE_TREE}:`)) return { status: 404, body: { message: "Not Found" } };
    if (p === "/repos/o/r/git/blobs") return { status: 201, body: { sha: "blob-" + last(String(c.body.content)) } };
    if (p === "/repos/o/r/git/trees" && c.method === "POST") return { status: 201, body: { sha: "newtree" } };
    if (p === "/repos/o/r/git/commits" && c.method === "POST") return { status: 201, body: { sha: "newcommit" } };
    if (p === "/repos/o/r/git/refs" && c.method === "POST") { state.refCreates++; return { status: 201, body: { ref: "refs/heads/x" } }; }
    if (p.startsWith("/repos/o/r/git/refs/heads/") && c.method === "PATCH") return { body: { ref: p } };
    return { status: 500, text: `unrouted ${c.method} ${p}` };
  };
  return { route, get refCreates() { return state.refCreates; } };
}

{
  const r = repoRoute();
  const { calls, deps } = fake(r.route);
  const out = await github(CFG, {
    op: "commit_files", repo: "o/r", branch: "feat", message: "touch three",
    files: { "scripts/run.sh": "#!/bin/sh\n", "README.md": "hi", "docs/new.md": "new" },
  }, deps);
  eq("commit_files returns sha and url",
     out, "Committed newcommit to o/r@feat (3 files)\nhttps://github.com/o/r/commit/newcommit");
  eq("commit_files call sequence",
     calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com", "")}`),
     [
       "GET /repos/o/r/git/ref/heads/main",
       `GET /repos/o/r/git/commits/${BASE_SHA}`,
       `GET /repos/o/r/git/trees/${BASE_TREE}:scripts`,
       `GET /repos/o/r/git/trees/${BASE_TREE}`,
       `GET /repos/o/r/git/trees/${BASE_TREE}:docs`,
       "POST /repos/o/r/git/blobs",
       "POST /repos/o/r/git/blobs",
       "POST /repos/o/r/git/blobs",
       "POST /repos/o/r/git/trees",
       "POST /repos/o/r/git/commits",
       "PATCH /repos/o/r/git/refs/heads/feat",
     ]);
  const blob = calls.find((c) => c.url.endsWith("/git/blobs"))!;
  eq("blob is base64 with encoding stated", blob.body, { content: base64Utf8("#!/bin/sh\n"), encoding: "base64" });
  eq("base64Utf8 handles non-ASCII", base64Utf8("héllo"), Buffer.from("héllo", "utf8").toString("base64"));
  const tree = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"))!;
  eq("tree builds on base_tree", tree.body.base_tree, BASE_TREE);
  eq("tree entries preserve existing modes; new files default to 100644",
     tree.body.tree.map((t: Record<string, unknown>) => [t.path, t.mode, t.type]),
     [["scripts/run.sh", "100755", "blob"], ["README.md", "100644", "blob"], ["docs/new.md", "100644", "blob"]]);
  const commit = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"))!;
  eq("commit parents the base and names the new tree",
     commit.body, { message: "touch three", tree: "newtree", parents: [BASE_SHA] });
  const patch = calls[calls.length - 1];
  eq("existing branch: ref is PATCHed without force", patch.body, { sha: "newcommit" });
  eq("existing branch: no ref is created", r.refCreates, 0);
}

{
  const r = repoRoute();
  const { calls, deps } = fake(r.route);
  await github(CFG, {
    op: "commit_files", repo: "o/r", branch: "feat", message: "m", new_branch: true,
    files: { "scripts/run.sh": "x" }, modes: { "scripts/run.sh": "100644" },
  }, deps);
  const treeReads = calls.filter((c) => c.method === "GET" && c.url.includes("/git/trees/"));
  eq("forced mode skips the tree read for that path", treeReads.length, 0);
  const tree = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"))!;
  eq("forced mode wins over the inherited one", tree.body.tree[0].mode, "100644");
  const create = calls[calls.length - 1];
  eq("new_branch: ref is POSTed from the commit",
     [create.method, create.url.endsWith("/git/refs"), create.body],
     ["POST", true, { ref: "refs/heads/feat", sha: "newcommit" }]);
}

{
  const r = repoRoute({
    "/repos/o/r/git/refs": () => ({ status: 422, body: { message: "Reference already exists" } }),
  });
  const { calls, deps } = fake(r.route);
  const out = await github(CFG, {
    op: "commit_files", repo: "o/r", branch: "feat", message: "m", new_branch: true, files: { "a": "b" },
  }, deps);
  const tail = calls.slice(-2).map((c) => [c.method, c.url.replace("https://api.github.com", ""), c.body]);
  eq("new_branch on an existing ref falls back to a forced PATCH",
     tail, [
       ["POST", "/repos/o/r/git/refs", { ref: "refs/heads/feat", sha: "newcommit" }],
       ["PATCH", "/repos/o/r/git/refs/heads/feat", { sha: "newcommit", force: true }],
     ]);
  eq("fallback still reports success", out.startsWith("Committed newcommit"), true);
}

{
  const r = repoRoute({
    "/repos/o/r/git/ref/heads/develop": () => ({ body: { object: { sha: BASE_SHA } } }),
  });
  const { calls, deps } = fake(r.route);
  await github(CFG, { op: "commit_files", repo: "o/r", branch: "feat", message: "m", base: "develop", files: { "a": "b" } }, deps);
  eq("base overrides the ref read", calls[0].url, "https://api.github.com/repos/o/r/git/ref/heads/develop");
}

{
  const r = repoRoute({
    "/repos/o/r/git/ref/heads/main": () => ({ status: 404, body: { message: "Not Found" } }),
  });
  const { calls, deps } = fake(r.route);
  const msg = await thrown(github(CFG, { op: "commit_files", repo: "o/r", branch: "feat", message: "m", files: { "a": "b" } }, deps));
  eq("missing base ref fails at the first step", [msg, calls.length], ["read ref main -> HTTP 404: Not Found", 1]);
}

{
  const r = repoRoute({
    "/repos/o/r/git/blobs": () => ({ status: 403, body: { message: "Resource not accessible by integration" } }),
  });
  const { deps } = fake(r.route);
  eq("blob failure names the path and message",
     await thrown(github(CFG, { op: "commit_files", repo: "o/r", branch: "feat", message: "m", files: { "dir/f.txt": "b" } }, deps)),
     "create blob dir/f.txt -> HTTP 403: Resource not accessible by integration");
}

{
  const { calls, deps } = fake();
  eq("commit_files requires repo and branch",
     await thrown(github(CFG, { op: "commit_files", repo: "o/r", message: "m", files: { a: "b" } }, deps)),
     "commit_files: `repo` and `branch` are required.");
  eq("commit_files requires files",
     await thrown(github(CFG, { op: "commit_files", repo: "o/r", branch: "b", message: "m", files: {} }, deps)),
     "commit_files: `files` must name at least one path.");
  eq("validation happens before any request", calls.length, 0);
}

// ---------------------------------------------------------------- open_pr

{
  const { calls, deps } = fake(() => ({ status: 201, body: { number: 42, html_url: "https://github.com/o/r/pull/42" } }));
  const out = await github(CFG, { op: "open_pr", repo: "o/r", head: "feat", title: "Add thing", body: "why" }, deps);
  eq("open_pr posts to /pulls", [calls[0].method, calls[0].url], ["POST", "https://api.github.com/repos/o/r/pulls"]);
  eq("open_pr body", calls[0].body, { head: "feat", base: "main", title: "Add thing", body: "why" });
  eq("open_pr returns number and url", out, "PR #42 opened: https://github.com/o/r/pull/42");
}

{
  const { calls, deps } = fake(() => ({ status: 201, body: { number: 1, html_url: "u" } }));
  await github(CFG, { op: "open_pr", repo: "o/r", head: "h", title: "t", base: "develop" }, deps);
  eq("open_pr base override and empty body default", [calls[0].body.base, calls[0].body.body], ["develop", ""]);
}

{
  const { deps } = fake(() => ({
    status: 422,
    body: { message: "Validation Failed", errors: [{ message: "A pull request already exists for o:feat." }] },
  }));
  eq("open_pr failure carries message and errors",
     await thrown(github(CFG, { op: "open_pr", repo: "o/r", head: "feat", title: "t" }, deps)),
     'open pr -> HTTP 422: Validation Failed [{"message":"A pull request already exists for o:feat."}]');
  eq("open_pr requires head and title",
     await thrown(github(CFG, { op: "open_pr", repo: "o/r" }, deps)),
     "open_pr: `repo`, `head` and `title` are required.");
}

// ---------------------------------------------------------------- schema

{
  eq("schema accepts a minimal rest call", githubInputSchema.safeParse({ op: "rest", path: "/user" }).success, true);
  eq("schema rejects an unknown op", githubInputSchema.safeParse({ op: "clone" }).success, false);
  eq("schema rejects a bad method", githubInputSchema.safeParse({ op: "rest", path: "/x", method: "HEAD" }).success, false);
  eq("description is a plain paragraph", GITHUB_TOOL_DESCRIPTION.includes("\n"), false);
}

// ------------------------------------------------------------ fetch binding

{
  // Node's `fetch` survives detaching; the Workers runtime's does not, and
  // throws "Illegal invocation: function called with incorrect `this`
  // reference" before a request leaves the isolate. So this asserts the SHAPE
  // that kept every github op dead on 2026-09-19 — a bare `globalThis.fetch` —
  // rather than a behaviour Node can reproduce.
  eq("defaultGithubDeps wraps fetch instead of detaching it",
     defaultGithubDeps.fetch !== globalThis.fetch, true);
  eq("the wrapper still calls through",
     typeof defaultGithubDeps.fetch === "function" && defaultGithubDeps.fetch.length === 0, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
