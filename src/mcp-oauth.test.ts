/**
 * Coverage for the OAuth entry's login path — the part that decides who gets to
 * read the memory.
 *
 * TWO THINGS SHAPE THIS FILE.
 *
 * WHAT CAN BE TESTED HERE, AND WHAT CANNOT. `mcp-oauth.ts` default-exports a live
 * `OAuthProvider`, whose real behaviour — `/token`, `/register`, `/.well-known/*`,
 * access-token validation, grant storage, PKCE — runs against a KV namespace that
 * no local test has. None of that is exercised below, and the tests do not pretend
 * to: the provider is a third-party library verified upstream, and the interesting
 * risk is not in it. What IS tested is everything Muninn wrote: the consent screen,
 * the password gate, and the routing around them, driven through `defaultHandler`
 * with a stubbed `OAUTH_PROVIDER`. That seam is why `defaultHandler` is exported.
 * Importing the module at all does smoke-test one thing about the provider — that
 * it accepts this option set without throwing at construction.
 *
 * Explicitly NOT covered, so nobody reads a green run as more than it is:
 *   - the OAuth protocol itself (needs KV + a real client);
 *   - `apiHandler` / `/mcp` dispatch (needs KV for the token check and Turso for
 *     the tools — `tools.test.ts` and `resources.test.ts` cover the dispatch);
 *   - rate limiting, because there is none (see the security block in mcp-oauth.ts);
 *   - whether the password is actually strong, which no test can assert.
 *
 * A LOADER STUB, BECAUSE OF `cloudflare:workers`. The provider library imports
 * `cloudflare:workers`, which the plain Node ESM loader cannot resolve, so the
 * module is unimportable under `node --experimental-strip-types` without help. A
 * three-line resolve hook maps that one specifier to a stub; everything else
 * resolves normally. The alternative was a fourth source file to hold the testable
 * half, which would have split the security logic away from the file a reader audits.
 */

import { register } from "node:module";
import type { Env } from "./mcp-oauth.ts"; // type-only: erased, no runtime import

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

// `cloudflare:workers` -> an empty stub. Must run before the module is imported,
// which is why the import below is dynamic.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec === "cloudflare:workers")
          return { url: "data:text/javascript,export%20class%20WorkerEntrypoint%20%7B%7D", shortCircuit: true };
        return next(spec, ctx);
      }
    `),
);

const { defaultHandler, escapeAttr, loginPage, passwordMatches, OWNER_USER_ID, default: provider } =
  await import("./mcp-oauth.ts");

// --------------------------------------------------------------------- harness

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** A fake OAUTH_PROVIDER that records whether the unauthenticated path touched it. */
function stubEnv(password?: string) {
  const calls: { parse: number; complete: number; userId: string | null; scope: string[] | null } = {
    parse: 0,
    complete: 0,
    userId: null,
    scope: null,
  };
  const env = {
    MCP_LOGIN_PASSWORD: password,
    OAUTH_PROVIDER: {
      async parseAuthRequest() {
        calls.parse++;
        return {
          responseType: "code",
          clientId: "client-1",
          redirectUri: REDIRECT,
          scope: ["claudeai"],
          state: "st8",
          codeChallengeMethod: "S256",
        };
      },
      async completeAuthorization(opts: { userId: string; scope: string[] }) {
        calls.complete++;
        calls.userId = opts.userId;
        calls.scope = opts.scope;
        return { redirectTo: `${REDIRECT}?code=abc&state=st8` };
      },
    },
  } as unknown as Env;
  return { env, calls };
}

const AUTHZ_QS = `?response_type=code&client_id=client-1&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st8`;

const get = (path: string) => new Request(`https://muninn-mcp.workers.dev${path}`);
const postPassword = (path: string, pw: string) => {
  const body = new FormData();
  body.set("password", pw);
  return new Request(`https://muninn-mcp.workers.dev${path}`, { method: "POST", body });
};

// -------------------------------------------------------- the module loads at all

eq("the provider constructs with this option set", typeof (provider as { fetch?: unknown }).fetch, "function");

// ------------------------------------------------------- passwordMatches (unit)

{
  eq("a correct password matches", await passwordMatches("hunter2", "hunter2"), true);
  eq("a wrong password does not", await passwordMatches("hunter3", "hunter2"), false);
  eq("a prefix of the password does not", await passwordMatches("hunter", "hunter2"), false);
  eq("a longer string starting with the password does not",
     await passwordMatches("hunter2extra", "hunter2"), false);

  // The dangerous cases: misconfiguration must never authorize.
  eq("an unset expected password denies everything", await passwordMatches("hunter2", undefined), false);
  eq("an unset expected password denies an empty submission", await passwordMatches("", undefined), false);
  eq("an empty expected password denies an empty submission", await passwordMatches("", ""), false);
  eq("a whitespace-only expected password denies the same whitespace",
     await passwordMatches("   ", "   "), false);
  eq("a newline-only expected password denies an empty submission",
     await passwordMatches("", "\n"), false);
}

// ------------------------------------------------------------------ login page

{
  const { env, calls } = stubEnv("hunter2");
  const res = await defaultHandler.fetch(get(`/authorize${AUTHZ_QS}`), env);
  const body = await res.text();

  eq("GET /authorize renders", res.status, 200);
  eq("as HTML", res.headers.get("content-type"), "text/html; charset=utf-8");
  eq("with a form posting back to /authorize",
     body.includes(`action="/authorize${escapeAttr(AUTHZ_QS)}"`), true);
  eq("preserving the OAuth params in the action", body.includes("response_type=code"), true);
  eq("with a password field", body.includes('name="password"'), true);
  eq("naming what is granted", /read access/i.test(body), true);
  eq("and saying the deployment is read-only", /read-only/i.test(body), true);
  eq("no error shown on the first view", body.includes("class=\"err\""), false);
  eq("rendering the page authorizes nobody", [calls.parse, calls.complete], [0, 0]);
}

// The query string is attacker-supplied and gets reflected into the form action,
// so a crafted /authorize link must not be able to close that attribute and inject
// markup. Two layers, tested separately: WHATWG URL parsing percent-encodes `"`,
// `<` and `>` in a query on its own, and `escapeAttr` catches whatever reaches
// `loginPage` regardless of how it got there. The second is what the guard is for
// — `loginPage` is exported and the first layer is a property of the caller.
{
  const { env } = stubEnv("hunter2");
  const evil = `/authorize?state="><script>alert(1)</script>&x=%22%3E%3Cb%3E`;
  const body = await (await defaultHandler.fetch(get(evil), env)).text();
  eq("literal quotes in the request URL cannot break out of the action attribute",
     body.includes('"><script>'), false);
  eq("nor can a percent-encoded pair, after this file's own escaping",
     /action="\/authorize[^"]*"/.test(body), true);

  const raw = loginPage(`?state="><script>alert(1)</script>`, "");
  eq("loginPage escapes a hostile string handed to it directly",
     raw.includes('"><script>'), false);
  eq("rendering it inert instead", raw.includes("&quot;&gt;&lt;script&gt;"), true);
  eq("escapeAttr covers the five markup characters",
     escapeAttr(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  eq("without mangling an ordinary query",
     loginPage("?a=1&b=2", "").includes('action="/authorize?a=1&amp;b=2"'), true);
}

// ------------------------------------------------------------- the password gate

{
  const { env, calls } = stubEnv("hunter2");
  const res = await defaultHandler.fetch(postPassword(`/authorize${AUTHZ_QS}`, "wrong"), env);
  eq("a wrong password is rejected", res.status, 401);
  eq("with the login page again", (await res.text()).includes('name="password"'), true);
  eq("and never reaches the OAuth provider", [calls.parse, calls.complete], [0, 0]);
}

{
  const { env, calls } = stubEnv("hunter2");
  const res = await defaultHandler.fetch(postPassword(`/authorize${AUTHZ_QS}`, ""), env);
  eq("an empty submission against a real password is rejected", res.status, 401);
  eq("and authorizes nothing", calls.complete, 0);
}

// THE dangerous case: the secret was never set. An empty submitted password must
// not match an empty configured one.
for (const [label, configured] of [
  ["unset", undefined],
  ["empty", ""],
  ["whitespace-only", "   "],
] as const) {
  const { env, calls } = stubEnv(configured);
  const res = await defaultHandler.fetch(postPassword(`/authorize${AUTHZ_QS}`, ""), env);
  eq(`an empty password against a ${label} MCP_LOGIN_PASSWORD is rejected`, res.status, 401);
  eq(`  ... and authorizes nobody (${label})`, [calls.parse, calls.complete], [0, 0]);

  const any = await defaultHandler.fetch(postPassword(`/authorize${AUTHZ_QS}`, "anything"), env);
  eq(`any password against a ${label} MCP_LOGIN_PASSWORD is rejected`, any.status, 401);
  eq(`  ... and still authorizes nobody (${label})`, calls.complete, 0);
}

{
  const { env, calls } = stubEnv("hunter2");
  const res = await defaultHandler.fetch(postPassword(`/authorize${AUTHZ_QS}`, "hunter2"), env);
  eq("the correct password redirects", res.status, 302);
  eq("to the code callback", res.headers.get("location"), `${REDIRECT}?code=abc&state=st8`);
  eq("having completed exactly one authorization", calls.complete, 1);
  eq("for the single owner", calls.userId, OWNER_USER_ID);
  eq("passing the requested scope through", calls.scope, ["claudeai"]);
}

// ---------------------------------------------------------------------- routing

{
  const { env } = stubEnv("hunter2");

  const root = await defaultHandler.fetch(get("/"), env);
  const rootBody = await root.text();
  eq("/ returns the banner", root.status, 200);
  eq("naming the server", rootBody.includes("Muninn MCP"), true);
  eq("and its read-only posture", /read-only/i.test(rootBody), true);

  const miss = await defaultHandler.fetch(get("/nope"), env);
  eq("an unknown path 404s", miss.status, 404);

  // /mcp never reaches defaultHandler in production — the provider routes it to
  // apiHandler after validating the token. Reaching it here would mean the
  // apiRoute was misconfigured, so the fallthrough must not be permissive.
  const mcp = await defaultHandler.fetch(get("/mcp"), env);
  eq("/mcp is not served by the default handler", mcp.status, 404);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
