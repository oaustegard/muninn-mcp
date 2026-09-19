/**
 * `econ` — one tool, two ops, wrapping two keyed public-data APIs so
 * FRED_API_KEY / CENSUS_API_KEY never enter a container:
 *
 *   op 'fred'   → https://api.stlouisfed.org/fred/{path}?{params}&api_key=…&file_type=json
 *   op 'census' → https://api.census.gov/data/{path}?{params}&key=…
 *
 * Both are plain GETs with the key as a query parameter — there is no header
 * form. That makes the URL itself the secret, so the rules here are: the URL
 * is built once, handed to `fetch`, and never interpolated into anything a
 * caller sees. Error strings are built from status + response body only, then
 * run through `sanitizeError` and a literal-value redaction of both keys (the
 * same belt-and-braces as bsky.ts `redactSecrets`), because a hostile or
 * merely chatty upstream could echo the request URL back in its body.
 *
 * Semantics per Muninn's ops entry (verified 2026-07-24):
 *   - FRED always gets `file_type=json` forced on; ALFRED vintage params
 *     (`realtime_start`, `realtime_end`) are ordinary params and pass through.
 *   - Census returns a JSON array of arrays with row 0 as headers; rendered as
 *     a tab-separated table. A non-array body (Census emits plain-text errors,
 *     sometimes with HTTP 200) is returned raw.
 *   - Output is capped at 60k chars with a truncation note.
 *   - 4xx is final; 5xx and 429 retry through turso.ts `withRetry` (3 attempts).
 *
 * Same "one implementation, two doors" shape as gateway.ts: `econ()` is the
 * transport-agnostic body, `server.ts` registers it, and `fetch`/`sleep` are
 * injected so the whole thing is testable with no network.
 */

import * as z from "zod/v4";
import { withRetry } from "./turso.ts";
import { sanitizeError } from "./tools.ts";

// ---------------------------------------------------------------- config & deps

export interface EconConfig {
  FRED_API_KEY: string;
  CENSUS_API_KEY: string;
}

/** Injectable I/O so both ops are testable without a live API. */
export interface EconDeps {
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultEconDeps: EconDeps = {
  fetch: (...args) => fetch(...args),
};

// ---------------------------------------------------------------- constants

const FRED_BASE = "https://api.stlouisfed.org/fred/";
const CENSUS_BASE = "https://api.census.gov/data/";

/** Output cap, in characters. Roughly 15k tokens — enough for years of daily observations. */
export const MAX_OUTPUT_CHARS = 60_000;

/** Total attempts for a 429/5xx. Public APIs, not a cold-start Turso — 3 is plenty. */
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------- schema

const paramsSchema = z.record(z.string(), z.union([z.string(), z.number()]));

export const econInputSchema = z.object({
  op: z.enum(["fred", "census"]).describe("'fred' for FRED/ALFRED, 'census' for the Census Bureau data API."),
  path: z.string()
    .describe("Endpoint path after the API base, no leading slash. fred: e.g. 'series/observations', 'series/search', 'releases'. census: e.g. '2023/acs/acs5', 'timeseries/eits/ressales'."),
  params: paramsSchema.optional()
    .describe("Query parameters. fred: e.g. {series_id, observation_start, units, frequency, realtime_start}. census: {get, for, in, time, ...}; 'get' and 'for' are required by the API for most datasets. The API key is added by the Worker; do not pass one."),
});

export type EconArgs = z.infer<typeof econInputSchema>;

export const ECON_TOOL_DESCRIPTION =
  "Query two keyed public-data APIs without holding their keys: op 'fred' GETs any FRED endpoint " +
  "(series/observations, series/search, series, releases, category/series, ...) and returns the JSON, " +
  "with ALFRED vintages reachable via realtime_start/realtime_end params; op 'census' GETs a Census " +
  "Bureau data API path (ACS such as '2023/acs/acs5', EITS such as 'timeseries/eits/ressales') and " +
  "returns the array-of-arrays response as a tab-separated table with the header row first. In FRED " +
  "observations `value` is a string, and '.' means missing. Output is capped at 60k characters with a " +
  "truncation note.";

// ---------------------------------------------------------------- helpers

/**
 * The path is interpolated into a URL under a fixed host and base directory.
 * `..` and a leading `/` are the two ways to walk out of that directory; both
 * are refused before any request is built.
 */
function checkPath(op: string, path: string): void {
  if (!path) throw new Error(`${op}: 'path' is required.`);
  if (path.startsWith("/")) throw new Error(`${op}: path must not start with '/': ${path}`);
  if (path.includes("..")) throw new Error(`${op}: path must not contain '..': ${path}`);
}

function buildUrl(base: string, path: string, params: Record<string, string | number> | undefined, keyParam: string, key: string, forced: Record<string, string> = {}): string {
  const url = new URL(path, base);
  const q = url.searchParams;
  for (const [k, v] of Object.entries(params ?? {})) {
    if (k === keyParam || k in forced) continue; // the Worker owns these
    q.set(k, String(v));
  }
  for (const [k, v] of Object.entries(forced)) q.set(k, v);
  q.set(keyParam, key);
  return url.toString();
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n[truncated: ${text.length} chars total, first ${MAX_OUTPUT_CHARS} shown; narrow the query (dates, limit/offset, fewer variables) for the rest]`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * One GET, classified. Error strings quote status and response body, never the
 * request — that is the property the leak tests pin. 429 and 5xx are thrown
 * with "Service Unavailable" in the message so turso.ts `withRetry` recognises
 * them (its needle list is message-based); everything else is final.
 */
async function get(url: string, deps: EconDeps, label: string): Promise<{ status: number; text: string }> {
  let res: Response;
  try {
    res = await deps.fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  } catch (err) {
    // Network-layer failure. Never interpolate `err` verbatim into anything
    // unredacted — undici quotes the request URL on some paths, and the URL
    // carries the key. The message is redacted at the dispatch boundary, but
    // keep it short regardless.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: network error (Service Unavailable): ${msg.slice(0, 200)}`);
  }
  const text = await safeText(res);
  if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
    throw new Error(`${label}: HTTP ${res.status} Service Unavailable: ${text.slice(0, 200)}`);
  }
  if (res.status >= 400) {
    throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 600)}`);
  }
  return { status: res.status, text };
}

// ---------------------------------------------------------------- fred

async function fred(config: EconConfig, args: EconArgs, deps: EconDeps): Promise<string> {
  checkPath("fred", args.path);
  const url = buildUrl(FRED_BASE, args.path, args.params, "api_key", config.FRED_API_KEY, { file_type: "json" });
  const { text } = await withRetry(
    () => get(url, deps, "fred"),
    { maxRetries: MAX_ATTEMPTS, jitter: false, sleep: deps.sleep },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // file_type=json was forced, so a non-JSON 2xx is an upstream oddity —
    // return it as-is rather than hide it.
    return truncate(text);
  }
  return truncate(JSON.stringify(parsed, null, 2));
}

// ---------------------------------------------------------------- census

/** Row 0 is the header. Cells are rendered as-is; null becomes an empty cell. */
export function renderCensusTable(rows: unknown[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) { lines.push(JSON.stringify(row)); continue; }
    lines.push(row.map((c) => (c === null || c === undefined ? "" : String(c))).join("\t"));
  }
  return lines.join("\n");
}

async function census(config: EconConfig, args: EconArgs, deps: EconDeps): Promise<string> {
  checkPath("census", args.path);
  const url = buildUrl(CENSUS_BASE, args.path, args.params, "key", config.CENSUS_API_KEY);
  const { text } = await withRetry(
    () => get(url, deps, "census"),
    { maxRetries: MAX_ATTEMPTS, jitter: false, sleep: deps.sleep },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Census returns plain-text errors ("error: unknown variable ...",
    // "No Content", ...) — sometimes with a 200. Hand them back raw.
    return truncate(text);
  }
  if (!Array.isArray(parsed)) return truncate(text);
  const table = renderCensusTable(parsed);
  const note = `[${Math.max(0, parsed.length - 1)} rows]`;
  return truncate(`${table}\n${note}`);
}

// ---------------------------------------------------------------- dispatch

/** Replace every configured key value in a message (bsky.ts `redactSecrets`). */
function redactSecrets(config: EconConfig, msg: string): string {
  const secrets = [config.FRED_API_KEY, config.CENSUS_API_KEY]
    .filter((s): s is string => typeof s === "string" && s.length >= 4);
  let out = msg;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out;
}

export async function econ(
  config: EconConfig,
  args: EconArgs,
  deps: EconDeps = defaultEconDeps,
): Promise<string> {
  try {
    switch (args.op) {
      case "fred":
        if (!config.FRED_API_KEY) throw new Error("fred is not configured on this Worker (FRED_API_KEY).");
        return redactSecrets(config, await fred(config, args, deps));
      case "census":
        if (!config.CENSUS_API_KEY) throw new Error("census is not configured on this Worker (CENSUS_API_KEY).");
        return redactSecrets(config, await census(config, args, deps));
      default:
        throw new Error(`econ: unknown op '${String((args as { op?: unknown }).op)}'.`);
    }
  } catch (err) {
    // The only exit for a failure. Header patterns first (tools.ts), then the
    // literal key values — an upstream body or a runtime's fetch error could
    // quote the request URL, and the message is about to become model context.
    throw new Error(redactSecrets(config, sanitizeError(err)));
  }
}
