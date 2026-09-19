/** Coverage for the `econ` tool, with fetch and sleep injected. No network. */
import {
  econ, econInputSchema, renderCensusTable, MAX_OUTPUT_CHARS,
  type EconConfig, type EconDeps,
} from "./econ.ts";
import { errorText } from "./tools.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

// Keys that would be unmistakable if they leaked. They are asserted PRESENT
// only in the request URL (that is the API's auth mechanism) and asserted
// ABSENT from every output and error string.
const FRED_KEY = "fredkey-SECRET-do-not-leak-0123456789ab";
const CENSUS_KEY = "censuskey-SECRET-do-not-leak-fedcba98765";
const config: EconConfig = { FRED_API_KEY: FRED_KEY, CENSUS_API_KEY: CENSUS_KEY };

interface Captured { url: string; method: string }

/** Build deps whose fetch replays a scripted list of responses and records requests. */
function fakeDeps(script: Array<() => Response | Error>) {
  const calls: Captured[] = [];
  const delays: number[] = [];
  let i = 0;
  const deps: EconDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      const next = script[Math.min(i++, script.length - 1)]();
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    sleep: async (ms) => { delays.push(ms); },
  };
  return { deps, calls, delays };
}

const json = (obj: unknown, status = 200) => () =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const textRes = (body: string, status: number) => () => new Response(body, { status });

async function thrown(p: Promise<unknown>): Promise<string> {
  try { await p; return "<no error>"; } catch (e) { return errorText(e); }
}

// ---------------------------------------------------------------- schema

eq("schema accepts a minimal fred call",
   econInputSchema.safeParse({ op: "fred", path: "series/observations", params: { series_id: "GDP" } }).success, true);
eq("schema accepts numeric params",
   econInputSchema.safeParse({ op: "fred", path: "series/observations", params: { limit: 5 } }).success, true);
eq("schema rejects an unknown op",
   econInputSchema.safeParse({ op: "bls", path: "x" }).success, false);
eq("schema rejects a non-scalar param value",
   econInputSchema.safeParse({ op: "census", path: "2023/acs/acs5", params: { get: ["NAME"] } }).success, false);

// ---------------------------------------------------------------- fred

{
  const body = { observations: [{ date: "2024-01-01", value: "27000.5" }, { date: "2024-04-01", value: "." }] };
  const { deps, calls } = fakeDeps([json(body)]);
  const out = await econ(config, {
    op: "fred", path: "series/observations",
    params: { series_id: "GDP", observation_start: "2024-01-01", limit: 2, realtime_start: "2024-06-01" },
  }, deps);
  const u = new URL(calls[0].url);
  eq("fred: GET against api.stlouisfed.org/fred/<path>",
     [calls[0].method, u.origin + u.pathname], ["GET", "https://api.stlouisfed.org/fred/series/observations"]);
  eq("fred: params pass through, numbers stringified, ALFRED realtime_start untouched",
     [u.searchParams.get("series_id"), u.searchParams.get("observation_start"), u.searchParams.get("limit"), u.searchParams.get("realtime_start")],
     ["GDP", "2024-01-01", "2", "2024-06-01"]);
  eq("fred: file_type=json is forced", u.searchParams.get("file_type"), "json");
  eq("fred: the configured key is sent as api_key", u.searchParams.get("api_key"), FRED_KEY);
  eq("fred: output is pretty JSON", out, JSON.stringify(body, null, 2));
  eq("fred: key never appears in the output", out.includes(FRED_KEY), false);
}

{
  const { deps, calls } = fakeDeps([json({ seriess: [] })]);
  await econ(config, { op: "fred", path: "series/search", params: { search_text: "unemployment", file_type: "xml", api_key: "caller-supplied" } }, deps);
  const u = new URL(calls[0].url);
  eq("fred: a caller's file_type is overridden to json", u.searchParams.getAll("file_type"), ["json"]);
  eq("fred: a caller's api_key is dropped in favour of the Worker's", u.searchParams.getAll("api_key"), [FRED_KEY]);
  eq("fred: no params beyond file_type and api_key when only those are forced",
     [...u.searchParams.keys()].sort(), ["api_key", "file_type", "search_text"]);
}

{
  const { deps, calls } = fakeDeps([json({})]);
  const e1 = await thrown(econ(config, { op: "fred", path: "../secret" }, deps));
  const e2 = await thrown(econ(config, { op: "fred", path: "/series" }, deps));
  const e3 = await thrown(econ(config, { op: "census", path: "2023/../x" }, deps));
  eq("path: '..' is refused before any request", [e1.includes("'..'"), calls.length], [true, 0]);
  eq("path: leading '/' is refused before any request", [e2.includes("start with '/'"), calls.length], [true, 0]);
  eq("path: census applies the same rule", e3.includes("'..'"), true);
}

{
  const { deps } = fakeDeps([textRes("<html>weird</html>", 200)]);
  const out = await econ(config, { op: "fred", path: "series" }, deps);
  eq("fred: a non-JSON 2xx body is returned raw", out, "<html>weird</html>");
}

// ---------------------------------------------------------------- census

{
  const body = [["NAME", "B01001_001E", "state"], ["Alabama", "5024279", "01"], ["Alaska", "733391", "02"]];
  const { deps, calls } = fakeDeps([json(body)]);
  const out = await econ(config, {
    op: "census", path: "2023/acs/acs5", params: { get: "NAME,B01001_001E", for: "state:*" },
  }, deps);
  const u = new URL(calls[0].url);
  eq("census: GET against api.census.gov/data/<path>",
     [calls[0].method, u.origin + u.pathname], ["GET", "https://api.census.gov/data/2023/acs/acs5"]);
  eq("census: get and for pass through", [u.searchParams.get("get"), u.searchParams.get("for")], ["NAME,B01001_001E", "state:*"]);
  eq("census: the configured key is sent as key", u.searchParams.get("key"), CENSUS_KEY);
  eq("census: no file_type param (that is FRED's)", u.searchParams.has("file_type"), false);
  eq("census: array-of-arrays renders as a tab-separated table with header row first, then a row count",
     out, "NAME\tB01001_001E\tstate\nAlabama\t5024279\t01\nAlaska\t733391\t02\n[2 rows]");
  eq("census: key never appears in the output", out.includes(CENSUS_KEY), false);
}

{
  const { deps, calls } = fakeDeps([json([["cell_value", "time"], [null, "2024-01"]])]);
  const out = await econ(config, { op: "census", path: "timeseries/eits/ressales", params: { get: "cell_value", time: "2024-01" } }, deps);
  eq("census: timeseries path composes", new URL(calls[0].url).pathname, "/data/timeseries/eits/ressales");
  eq("census: null cells render empty", out.split("\n")[1], "\t2024-01");
}

{
  const { deps } = fakeDeps([textRes("error: unknown variable 'B99999_001E'", 200)]);
  const out = await econ(config, { op: "census", path: "2023/acs/acs5", params: { get: "B99999_001E", for: "us:1" } }, deps);
  eq("census: a plain-text (non-array) body is returned raw", out, "error: unknown variable 'B99999_001E'");
}

{
  const { deps } = fakeDeps([json({ message: "not an array" })]);
  const out = await econ(config, { op: "census", path: "2023/acs/acs5", params: { get: "NAME" } }, deps);
  eq("census: a JSON object body is returned as its raw text", out, '{"message":"not an array"}');
}

eq("renderCensusTable: rows join by tab, lines by newline",
   renderCensusTable([["a", "b"], [1, 2]]), "a\tb\n1\t2");

// ---------------------------------------------------------------- truncation

{
  const big = { observations: Array.from({ length: 4000 }, (_, i) => ({ date: `d${i}`, value: "1.0" })) };
  const { deps } = fakeDeps([json(big)]);
  const out = await econ(config, { op: "fred", path: "series/observations", params: { series_id: "X" } }, deps);
  const full = JSON.stringify(big, null, 2);
  eq("truncation: oversize output is cut at the cap with a note naming the total",
     [full.length > MAX_OUTPUT_CHARS, out.startsWith(full.slice(0, MAX_OUTPUT_CHARS)), out.includes(`[truncated: ${full.length} chars total`)],
     [true, true, true]);
  eq("truncation: output length is the cap plus the note", out.length < MAX_OUTPUT_CHARS + 200, true);
}

{
  const rows = [["h1", "h2"], ...Array.from({ length: 5000 }, (_, i) => [`${i}`, "x".repeat(20)])];
  const { deps } = fakeDeps([json(rows)]);
  const out = await econ(config, { op: "census", path: "2023/acs/acs5", params: { get: "h1" } }, deps);
  eq("truncation: census tables are capped too", out.includes("[truncated:"), true);
}

// ---------------------------------------------------------------- retry

{
  const { deps, calls, delays } = fakeDeps([textRes("upstream busy", 503), json({ ok: 1 })]);
  const out = await econ(config, { op: "fred", path: "series", params: { series_id: "GDP" } }, deps);
  eq("retry: 503 then 200 succeeds on the second attempt", [JSON.parse(out), calls.length], [{ ok: 1 }, 2]);
  eq("retry: one backoff sleep of 500ms (no jitter)", delays, [500]);
}

{
  const { deps, calls, delays } = fakeDeps([textRes("slow down", 429), textRes("", 502), json([["a"], ["1"]])]);
  const out = await econ(config, { op: "census", path: "2023/acs/acs5", params: { get: "a" } }, deps);
  eq("retry: 429 then 502 then 200 succeeds after three attempts", [out, calls.length, delays], ["a\n1\n[1 rows]", 3, [500, 1000]]);
}

{
  const { deps, calls, delays } = fakeDeps([textRes("still down", 503)]);
  const err = await thrown(econ(config, { op: "fred", path: "series" }, deps));
  eq("retry: persistent 503 gives up after 3 attempts with two sleeps",
     [calls.length, delays, err.includes("HTTP 503")], [3, [500, 1000], true]);
}

{
  const { deps, calls } = fakeDeps([textRes('{"error_code":400,"error_message":"Bad Request. Variable series_id is required."}', 400)]);
  const err = await thrown(econ(config, { op: "fred", path: "series/observations" }, deps));
  eq("retry: a 400 is not retried and its body is preserved",
     [calls.length, err.includes("HTTP 400"), err.includes("series_id is required")], [1, true, true]);
}

{
  const { deps, calls } = fakeDeps([textRes("Invalid Key", 404)]);
  const err = await thrown(econ(config, { op: "census", path: "2023/acs/acs5", params: { get: "NAME" } }, deps));
  eq("retry: a 404 is final", [calls.length, err.includes("HTTP 404"), err.includes("Invalid Key")], [1, true, true]);
}

{
  const { deps, calls } = fakeDeps([() => new Error("fetch failed: ECONNRESET"), json({ ok: 1 })]);
  const out = await econ(config, { op: "fred", path: "series" }, deps);
  eq("retry: a thrown network error is retried", [JSON.parse(out), calls.length], [{ ok: 1 }, 2]);
}

// ---------------------------------------------------------------- keys never leak

{
  // An upstream that echoes the request URL (key and all) into a 400 body —
  // the worst realistic case. Neither the raw thrown error nor errorText may
  // contain the key.
  const echo = `bad request for https://api.stlouisfed.org/fred/series?api_key=${FRED_KEY}&file_type=json`;
  const { deps } = fakeDeps([textRes(echo, 400)]);
  let raw = "";
  try { await econ(config, { op: "fred", path: "series" }, deps); } catch (e) { raw = e instanceof Error ? e.message : String(e); }
  eq("leak: raw error from an echoing 400 does not contain the FRED key", raw.includes(FRED_KEY), false);
  eq("leak: the redaction leaves a readable message", raw.includes("HTTP 400") && raw.includes("api_key=[REDACTED]"), true);
}

{
  const echo = `error: key=${CENSUS_KEY} is not valid`;
  const { deps } = fakeDeps([textRes(echo, 403)]);
  const err = await thrown(econ(config, { op: "census", path: "2023/acs/acs5", params: { get: "NAME" } }, deps));
  eq("leak: an echoing census 403 does not contain the Census key", err.includes(CENSUS_KEY), false);
  eq("leak: errorText still names the status", err.includes("HTTP 403"), true);
}

{
  // A hostile 200 body that echoes the key: the success path is redacted too.
  const { deps } = fakeDeps([json({ note: `your key ${FRED_KEY} works` })]);
  const out = await econ(config, { op: "fred", path: "series" }, deps);
  eq("leak: a 200 body echoing the key is redacted on the way out", [out.includes(FRED_KEY), out.includes("[REDACTED]")], [false, true]);
}

{
  const { deps } = fakeDeps([() => new Error(`connect ECONNREFUSED https://api.census.gov/data/x?key=${CENSUS_KEY}`)]);
  const err = await thrown(econ(config, { op: "census", path: "x", params: {} }, deps));
  eq("leak: network error text is redacted of the key", err.includes(CENSUS_KEY), false);
  eq("leak: network error is still identifiable", err.includes("network error"), true);
}

{
  const { deps, calls } = fakeDeps([json({})]);
  const e1 = await thrown(econ({ ...config, FRED_API_KEY: "" }, { op: "fred", path: "series" }, deps));
  const e2 = await thrown(econ({ ...config, CENSUS_API_KEY: "" }, { op: "census", path: "x", params: {} }, deps));
  eq("unconfigured key fails before any request",
     [e1.includes("FRED_API_KEY"), e2.includes("CENSUS_API_KEY"), calls.length], [true, true, 0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
