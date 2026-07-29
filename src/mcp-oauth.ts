/**
 * Muninn remote MCP — OAuth-protected entry for claude.ai custom connectors.
 *
 * claude.ai connectors authenticate over OAuth 2.1 (metadata discovery + client
 * registration + auth-code/PKCE), NOT a static bearer token — §9 decision 2. This
 * entry wraps the shared MCP handler (`mcpHandler` from `index.ts`, the same
 * read-only tools and resources registered in `server.ts`) with Cloudflare's
 * `@cloudflare/workers-oauth-provider`, which makes the Worker a spec-compliant
 * OAuth provider. Sign-in is a self-contained password page gated by a Worker
 * secret — no upstream identity provider.
 *
 *   /mcp                                the MCP endpoint (OAuth-validated -> apiHandler)
 *   /authorize                          password login -> issues the auth code
 *   /token, /register, /.well-known/*   handled by the provider library
 *   /                                   plain-text banner
 *
 * Ported from sage-mcp's `mcp-oauth.ts`, which is verified working against the
 * 2026-07-28 spec. Muninn differs from Sage in two ways worth stating: there is no
 * service binding (Muninn talks to Turso directly, so Sage's `SAGE_SVC` /
 * `SAGE_API_URL` are gone), and this deployment is READ-ONLY — Stage 1 of
 * docs/mcp-migration.md. The consent screen says so, because a consent screen that
 * overstates what it grants is worse than none.
 *
 * DCR DEPRECATION (2026-07-28). The spec revision this server targets deprecates
 * Dynamic Client Registration; the provider library still serves `/register`
 * through the deprecation window (at least twelve months), so the connector flow
 * keeps working today. Nothing below depends on DCR beyond that endpoint existing,
 * so when the window closes the change is confined to how a client obtains its
 * `client_id` — pre-registration or client-ID metadata documents — not to tool
 * dispatch, not to this file's auth logic. Re-plan it before the window closes;
 * revisit `clientRegistrationEndpoint` below and nothing else here. The MCP SDK is
 * only ever an OAuth *resource server*: it verifies nothing itself, the provider
 * gates the route before `apiHandler` runs.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT
 *
 * §7 "The new risk: credential concentration" is blunt about it: one Worker behind
 * one password on a public `workers.dev` login page is *strictly worse* than
 * today's per-surface credentials on blast radius. This Worker holds `TURSO_TOKEN`
 * for one person's entire memory.
 *
 * Covered here:
 *   - A missing, empty, or whitespace-only `MCP_LOGIN_PASSWORD` authorizes NOBODY.
 *     Misconfiguration fails closed, never open (see `passwordMatches`).
 *   - The password comparison is constant-time over SHA-256 digests, so neither
 *     the secret's length nor its matching prefix leaks through response timing.
 *   - The OAuth query string is HTML-escaped before it is reflected into the form
 *     action, so a crafted `/authorize?...` link cannot inject markup into the
 *     login page (Sage interpolates it raw; that is the one divergence from the
 *     reference implementation).
 *   - A failed login never touches `OAUTH_PROVIDER` — no grant, no code, no KV
 *     write happens on the unauthenticated path.
 *
 * NOT covered, and worth naming rather than implying:
 *   - Rate limiting or lockout. The login page accepts unlimited guesses; the only
 *     defence is a high-entropy password. Prefer a generated one.
 *   - Anything above the password. One secret is the whole boundary — no second
 *     factor, no device binding, no per-client scoping. Every issued token is
 *     equivalent to every other.
 *   - Turso credential exposure if the Worker itself is compromised. Read-only is a
 *     property of which tools are registered, not of the database token.
 *   - Exfiltration by an authorized client. Read access is read access to all of it.
 *   - Discovery. `workers.dev` hostnames are enumerable; assume this endpoint is
 *     found.
 *
 * The mitigation §7 names for exactly this shape is **Cloudflare Access** in front
 * of the Worker rather than relying on the password page alone — an identity-aware
 * proxy that terminates before any Worker code executes, and closes the rate-limit
 * and second-factor gaps above. §9 decision 11 is open on it. Until it is decided,
 * treat this password as a production credential: generated, unique, rotated on
 * every deploy that could have leaked it.
 * ---------------------------------------------------------------------------
 *
 * Bindings: OAUTH_KV (token/grant store — required by the provider).
 * Secrets: MCP_LOGIN_PASSWORD, plus the Turso pair the tools already need.
 */

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { mcpHandler, type Env as McpEnv } from "./index.ts";

export interface Env extends McpEnv {
  /** Login password for the authorize page (`wrangler secret put`). */
  MCP_LOGIN_PASSWORD?: string;
  /** Token/grant store required by the OAuth provider. */
  OAUTH_KV: KVNamespace;
  /** Injected by the provider — OAuth helper methods. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Single-tenant server: every grant belongs to the one person whose memory this is. */
export const OWNER_USER_ID = "muninn-owner";

// -------------------------------------------------------------- password check

/**
 * Constant-time password check that fails closed on misconfiguration.
 *
 * Two properties, in order of importance:
 *
 * 1. An unset, empty, or whitespace-only `expected` returns false for EVERY
 *    submission — including an empty one. A deploy that forgets
 *    `wrangler secret put MCP_LOGIN_PASSWORD` must be unusable, not open. This is
 *    the guard inherited from Sage and it is the single most important line here.
 * 2. The comparison is constant-time. Rather than `!==` (which returns on the first
 *    differing byte, leaking the matching prefix) or a byte-wise loop over the raw
 *    strings (which still leaks length via the length check), both sides are hashed
 *    to fixed 32-byte SHA-256 digests and those are compared with a branch-free XOR
 *    accumulation. Equal-length inputs by construction, so length does not leak.
 *    WebCrypto is ambient in Workers and in Node — no dependency.
 */
export async function passwordMatches(
  submitted: string,
  expected: string | undefined,
): Promise<boolean> {
  if (typeof expected !== "string" || expected.trim() === "") return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(submitted)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

// ------------------------------------------------------------------ login page

/** Escape for an HTML attribute value. The OAuth query string is attacker-supplied. */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The consent screen. It names what is being granted, because this is one person's
 * memory rather than a shared wiki, and because at Stage 1 "read" is the honest
 * word — no tool in this deployment writes.
 */
export function loginPage(search: string, error: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muninn MCP — sign in</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:24rem;margin:12vh auto;padding:0 1rem;color:#222}
  h1{font-size:1.25rem;margin-bottom:.25rem} p{margin:.5rem 0}
  input,button{font:inherit;width:100%;box-sizing:border-box;padding:.6rem;margin:.3rem 0}
  button{background:#111;color:#fff;border:0;border-radius:.4rem;cursor:pointer}
  .err{color:#b00} .note{font-size:.85rem;color:#666}
  @media(prefers-color-scheme:dark){body{background:#111;color:#eee}.note{color:#999}
    input{background:#222;color:#eee;border:1px solid #444}button{background:#eee;color:#111}}
</style></head><body>
<h1>Muninn MCP</h1>
<p>Authorizing grants this client <strong>read access to Muninn's memory</strong> —
search, recall and the boot payload, over every memory in the connected database.</p>
<p class="note">Read-only: this deployment registers no tool that can write, edit or
delete a memory. Only authorize a client you would let read all of it.</p>
<form method="POST" action="/authorize${escapeAttr(search)}">
  <input type="password" name="password" placeholder="Password" autofocus required autocomplete="current-password">
  <button type="submit">Authorize read access</button>
  ${error ? `<p class="err">${error}</p>` : ""}
</form>
</body></html>`;
}

const html = (b: string, status = 200) =>
  new Response(b, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** Deliberately identical for a wrong password and for an unconfigured server: an
 *  unauthenticated visitor learns nothing about which of the two it hit. The
 *  operator gets the distinction from the log line instead. */
const DENIED = "Incorrect password.";

// ---- MCP API (only reached after the provider validates the access token) ----

/**
 * No bearer check here, deliberately. `index.ts`'s `checkAuth` guards the
 * standalone bearer deployment; on this path the provider has already validated an
 * OAuth access token and stripped nothing — re-checking `Authorization` would
 * reject every connector, since the header carries the OAuth token and not
 * `MCP_AUTH_TOKEN`. One gate per deployment, and this one is the provider's.
 */
export const apiHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The SDK handler answers every MCP method on both protocol eras, including the
    // GET that opens a 2026-era stream — so non-POST is not turned away here.
    return mcpHandler(env).fetch(request);
  },
};

// ---- Auth: self-contained password login ----

/**
 * Exported so the tests can drive it directly with a stubbed `OAUTH_PROVIDER`.
 * Instantiating the real `OAuthProvider` needs a KV binding, which no test has;
 * this seam is what makes the login logic — the security-critical part — testable
 * at all. See `mcp-oauth.test.ts` for what that does and does not cover.
 */
export const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      if (request.method === "POST") {
        // Password first, provider second. A wrong password must not reach
        // `parseAuthRequest`/`completeAuthorization` — nothing is parsed, no grant
        // is minted and no KV write happens on the unauthenticated path. (Sage
        // parses first; the ordering here is the safer one and is what the tests
        // assert.) The OAuth params ride in the query string, not the body, so
        // reading the form first costs nothing.
        const form = await request.formData();
        const pw = String(form.get("password") ?? "");
        if (!(await passwordMatches(pw, env.MCP_LOGIN_PASSWORD))) {
          if (!env.MCP_LOGIN_PASSWORD || env.MCP_LOGIN_PASSWORD.trim() === "") {
            console.warn(
              "MCP_LOGIN_PASSWORD is unset or empty — all logins denied. " +
                "Run: wrangler secret put MCP_LOGIN_PASSWORD",
            );
          }
          return html(loginPage(url.search, DENIED), 401);
        }
        // The form re-POSTs to the same URL, so parseAuthRequest sees the original
        // OAuth params again.
        const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: OWNER_USER_ID,
          scope: oauthReq.scope ?? [],
          metadata: {},
          props: {},
        });
        return Response.redirect(redirectTo, 302);
      }
      return html(loginPage(url.search, ""));
    }

    if (url.pathname === "/") {
      return new Response(
        "Muninn MCP (read-only, OAuth). Add as a custom connector in claude.ai.\n",
      );
    }
    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: apiHandler as never,
  defaultHandler: defaultHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  // Serves DCR while the deprecation window is open — see the header note.
  clientRegistrationEndpoint: "/register",
});
