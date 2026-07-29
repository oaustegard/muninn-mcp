# Deploying muninn-mcp

From an empty Cloudflare account to a working claude.ai connector. Every command
here was run against this repo; the ones that need credentials this environment
does not have are marked.

For running the parity gate afterwards, see [`operating.md`](./operating.md).

---

## Before you start

**Point green at a branch database, not production.** This is Stage 1 of the
migration plan and the discipline is the whole reason the plan is staged:

```bash
turso db create muninn-green --from-db muninn
turso db show muninn-green --url          # -> TURSO_URL
turso db tokens create muninn-green       # -> TURSO_TOKEN
```

Reads are idempotent, so pointing at production wouldn't corrupt anything — the
risk isn't damage, it's that a branch is the only place where being wrong costs
*nothing*, and the gate hasn't yet run green against the production corpus, which
is larger and messier.

**There are no write tools.** Not disabled — absent. Nothing you deploy here can
modify memory.

---

## 1. Create the KV namespace

The OAuth provider needs somewhere to keep tokens and grants. `wrangler.toml`
ships a placeholder id that will not resolve:

```bash
wrangler kv namespace create OAUTH_KV
```

Paste the returned id into `wrangler.toml` under `[[kv_namespaces]]`. This is the
one edit to a tracked file that deployment requires.

## 2. Set the secrets

```bash
wrangler secret put TURSO_URL            # the muninn-green branch
wrangler secret put TURSO_TOKEN
wrangler secret put MCP_LOGIN_PASSWORD   # generate it — see below
```

**Generate the password; do not choose one.** There is no rate limiting in front
of the login page, so its entropy is the entire defence:

```bash
openssl rand -base64 24
```

A deploy that forgets `MCP_LOGIN_PASSWORD` fails *closed*: the endpoint comes up
and nobody can ever authorize, because an unset, empty or whitespace-only
password matches nothing. That is deliberate — the dangerous failure would be the
other one.

`MCP_AUTH_TOKEN` is **not** used by this entry. It belongs to the bearer-token
deployment in step 5.

## 3. Deploy

```bash
npm install
npm test                 # 620 assertions
npx tsc --noEmit
npx wrangler deploy --dry-run   # bundles ~990 KiB, 209 KiB gzipped
wrangler deploy
```

`--dry-run` is worth running first: it resolves bindings and bundles without
publishing, so a missing KV id or a broken import surfaces before anything is
live.

## 4. Add it to claude.ai

Settings → Connectors → Add custom connector → the Worker's `/mcp` URL.

claude.ai walks OAuth 2.1 — metadata discovery, client registration, auth code
with PKCE. You will be shown the sign-in page once and prompted for
`MCP_LOGIN_PASSWORD`. After that the connector holds a token.

Five tools should appear: `recall`, `memory_get`, `muninn_config`, `muninn_docs`,
`boot`.

> **Not verified here.** This environment has no Cloudflare account, so the
> connector handshake has not been exercised end to end. The OAuth entry is a
> port of `sage-mcp`'s, which is running against the 2026-07-28 spec; the login
> page, password gate and routing have 52 assertions against them, but the
> provider's own endpoints (`/token`, `/register`, `/.well-known/*`, PKCE, grant
> storage) need KV and are untested. **Expect to debug the first handshake.**

## 5. Optional: the bearer-token deployment

The parity harness, `curl` and any programmatic client cannot walk an auth-code
flow. `src/index.ts` is a second, bearer-authenticated front door onto the same
server:

```bash
wrangler secret put MCP_AUTH_TOKEN --name muninn-mcp-bearer
wrangler deploy --name muninn-mcp-bearer src/index.ts
```

Give it its own `--name` so both can be live. They are **alternative front doors,
never layered** — the OAuth entry calls the shared handler directly, because
double-gating would reject a valid OAuth token as a non-matching bearer.

Leaving `MCP_AUTH_TOKEN` unset on that deployment leaves it **open**. That is
acceptable only against a branch database, and only briefly.

---

## What you have just concentrated

This is worth reading before you leave it running, because it is the real cost of
the design and the migration plan says so explicitly (§7, "The new risk:
credential concentration").

One Worker now holds a Turso token for one person's entire memory, behind **one
password on a publicly reachable `workers.dev` hostname**. Compared to
credentials spread across per-surface environments, that is strictly worse on
blast radius. What protects it:

- The password, which has no rate limit and no lockout.
- Read-only-ness — which is a property of *which tools are registered*, not of
  the database token. A compromise of the Worker is a compromise of the token,
  and the token can write.

What the plan recommends, and what is still open (§9 decision 11):

- **Cloudflare Access in front of the Worker.** An identity-aware proxy that
  terminates before any Worker code runs, closing the rate-limit and
  second-factor gaps at once. This is the single highest-value hardening.
- **Rotate on migration.** Any credential that has ever sat in a
  project-knowledge file should be considered spent.
- `workers.dev` hostnames are enumerable. Assume the endpoint is found.

---

## Troubleshooting

**`KV namespace 'REPLACE_ME_...' is not valid`** — step 1 wasn't done, or the id
wasn't pasted back into `wrangler.toml`.

**The connector adds but no tools appear.** Check the route: the OAuth provider
serves MCP at `/mcp`, not `/`. `GET /` returns a plain banner by design.

**Sign-in always says "Incorrect password."** Including when you are sure it is
right: check that `MCP_LOGIN_PASSWORD` is actually set
(`wrangler secret list`). An unset secret and a wrong password return the
*identical* page, deliberately — an unauthenticated visitor should not be able to
tell a misconfigured deployment from a wrong guess. The distinction is in the
Worker logs as a `console.warn`.

**First call after an idle period fails with 503.** Expected — Turso cold start,
made likelier by Workers' cold isolates. `withRetry` absorbs it with blue's own
budget. If it reaches the caller, the retry budget was exhausted.

**`CIMD is disabled` in the logs.** Client ID Metadata Documents are the
successor to the Dynamic Client Registration that 2026-07-28 deprecates. Enabling
them needs `compatibility_flags = ["global_fetch_strictly_public"]`, which changes
fetch semantics worker-wide — a deliberate decision for whoever re-plans the DCR
path, not a default. The current flow keeps working for the deprecation window.

---

## Promoting to Stage 2

Only after the parity gate is green on the **production** corpus, and after two
weeks of real use with no ranking complaints:

```bash
wrangler secret put TURSO_URL      # now production
```

That is the entire cutover. Reads are idempotent, which is what makes this the
one genuinely free step in the plan — worst case green returns something wrong
and you read it, rather than something wrong and you store it.

Rollback is to stop calling the tool. Blue is still installed and still works;
that is the point of the whole blue-green shape.
