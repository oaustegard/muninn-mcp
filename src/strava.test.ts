/** `strava` tool: token lifecycle, request shapes, analysis math — fetch and Turso faked. */
import {
  strava, analyzeStreams, formatAnalysis, pyRound, formatRecent, accessToken,
  stravaInputSchema, STRAVA_TOOL_DESCRIPTION, TOKEN_KEY,
  type StravaDeps, type StravaConfig,
} from "./strava.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

const ACCESS = "acc-SECRET-0001";
const REFRESH = "ref-SECRET-0002";
const NEW_ACCESS = "acc-SECRET-0003";
const NEW_REFRESH = "ref-SECRET-0004";
const CFG: StravaConfig = {
  TURSO_URL: "x", TURSO_TOKEN: "y",
  STRAVA_CLIENT_ID: "cid-123", STRAVA_CLIENT_SECRET: "csec-SECRET-0005",
};
const NOW_MS = Date.parse("2026-09-19T14:00:00Z");
const NOW_S = NOW_MS / 1000;

interface Call { sql: string; args: unknown[] }
interface Req { url: string; method: string; auth: string | undefined; body: string | undefined }

const ACT = (over: Record<string, unknown> = {}) => ({
  id: 111, name: "Morning Ride", type: "Ride", sport_type: "Ride",
  start_date_local: "2026-09-18T07:15:00Z", distance: 42195, moving_time: 5400,
  elapsed_time: 5700, total_elevation_gain: 320, average_speed: 7.8,
  average_watts: 180.4, weighted_average_watts: 195, average_heartrate: 142.7, max_heartrate: 171,
  ...over,
});

/**
 * Fakes. `fetch` routes on the URL and records every request; `db` returns the
 * stored token row for the config read and records the rewrite.
 */
function fake(opts: { expiresAt?: number; routes?: Record<string, unknown>; tokenRow?: string | null } = {}) {
  const reqs: Req[] = [];
  const calls: Call[] = [];
  const tokenRow = opts.tokenRow === undefined
    ? JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, expires_at: opts.expiresAt ?? NOW_S + 3600 })
    : opts.tokenRow;
  const routes: Record<string, unknown> = {
    "https://www.strava.com/oauth/token": { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_at: NOW_S + 21600, token_type: "Bearer" },
    ...opts.routes,
  };
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const h = init?.headers as Record<string, string> | undefined;
    reqs.push({ url, method: init?.method ?? "GET", auth: h?.Authorization, body: init?.body as string | undefined });
    const hit = Object.entries(routes).find(([k]) => url === k || url.startsWith(k));
    if (!hit) return new Response("not found", { status: 404 });
    if (hit[1] instanceof Response) return hit[1];
    if (typeof hit[1] === "function") return (hit[1] as () => Response)();
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = {
    execute: async ({ sql, args }: Call) => {
      calls.push({ sql, args: args ?? [] });
      if (sql.startsWith("SELECT value FROM config")) return { rows: tokenRow === null ? [] : [{ value: tokenRow }] };
      return { rows: [], rowsAffected: 1 };
    },
  };
  const deps: StravaDeps = { fetch: fetchFake, db: () => client as never, now: () => NOW_MS };
  return { reqs, calls, deps };
}

// ------------------------------------------------------------- token: fresh

{
  const { reqs, calls, deps } = fake({ routes: { "https://www.strava.com/api/v3/athlete/activities": [ACT()] } });
  const out = await strava(CFG, { op: "recent" }, deps);
  eq("fresh token: no refresh POST", reqs.filter((r) => r.url.includes("oauth")).length, 0);
  eq("fresh token: config is read once, never rewritten",
     calls.map((c) => c.sql.split(" ")[0]), ["SELECT"]);
  eq("fresh token: read hits the strava key", calls[0].args, [TOKEN_KEY]);
  eq("recent: default per_page=5", reqs[0].url, "https://www.strava.com/api/v3/athlete/activities?per_page=5");
  eq("recent: bearer header present", reqs[0].auth?.startsWith("Bearer "), true);
  eq("recent: bearer carries the stored access token", reqs[0].auth === `Bearer ${ACCESS}`, true);
  eq("recent: table header + one row", out.split("\n").length, 2);
  eq("recent: row shape", out.split("\n")[1],
     "111 | 2026-09-18 07:15:00 | Morning Ride | Ride | 42.2km | 1:30:00 | 180W | 143bpm");
}

// ----------------------------------------------------------- token: expired

{
  const { reqs, calls, deps } = fake({
    expiresAt: NOW_S + 120, // inside the 300s skew
    routes: { "https://www.strava.com/api/v3/athlete/activities": [ACT()] },
  });
  await strava(CFG, { op: "recent", n: 10 }, deps);
  const refresh = reqs[0];
  eq("expired token: first request is the refresh POST", [refresh.method, refresh.url], ["POST", "https://www.strava.com/oauth/token"]);
  const form = new URLSearchParams(refresh.body ?? "");
  eq("refresh body carries the grant", Object.fromEntries(form.entries()), {
    client_id: "cid-123", client_secret: "csec-SECRET-0005", grant_type: "refresh_token", refresh_token: REFRESH,
  });
  eq("refresh POST sends no bearer", refresh.auth, undefined);
  const upd = calls.find((c) => c.sql.startsWith("UPDATE config"))!;
  eq("rotated triple is written back to the same key", upd.args[2], TOKEN_KEY);
  eq("rotated triple value", JSON.parse(String(upd.args[0])),
     { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_at: NOW_S + 21600 });
  eq("updated_at stamps now", upd.args[1], "2026-09-19T14:00:00Z");
  eq("update touches value and updated_at only", upd.sql, "UPDATE config SET value = ?, updated_at = ? WHERE key = ?");
  eq("API call after refresh uses the NEW token", reqs[1].auth === `Bearer ${NEW_ACCESS}`, true);
  eq("recent: n is honoured", reqs[1].url.endsWith("per_page=10"), true);
}

{
  const { deps } = fake({ expiresAt: NOW_S + 300 });
  eq("exactly at the skew boundary does not refresh", await accessToken(CFG, deps), ACCESS);
}

// ---------------------------------------------------------------- activity

{
  const { reqs, deps } = fake({ routes: { "https://www.strava.com/api/v3/activities/111": ACT() } });
  const out = await strava(CFG, { op: "activity", id: 111 }, deps);
  eq("activity: detail URL", reqs[0].url, "https://www.strava.com/api/v3/activities/111?include_all_efforts=false");
  eq("activity: no streams call by default", reqs.length, 1);
  eq("activity: bearer present", reqs[0].auth?.startsWith("Bearer "), true);
  eq("activity: head line", out.split("\n")[0], "Morning Ride — Ride · 2026-09-18 07:15:00 · id 111");
  eq("activity: facts line", out.split("\n")[1],
     "  42.2 km · moving 1:30:00 · elapsed 1:35:00 · elev 320 m · avg 28.1 km/h · avg 180W / NP 195W · HR 143/171 bpm");
  eq("activity: no analysis without streams", out.includes("Analysis"), false);
}

const STREAMS = {
  heartrate: { data: [100, 130, 150, 160, 170, 180] },
  watts: { data: [100, 120, 150, 150, 140, 130] },
};

{
  const { reqs, deps } = fake({ routes: {
    "https://www.strava.com/api/v3/activities/111/streams": STREAMS,
    "https://www.strava.com/api/v3/activities/111?": ACT(),
  } });
  const out = await strava(CFG, { op: "activity", id: "111", with_streams: true }, deps);
  eq("activity+streams: streams URL", reqs[1].url,
     "https://www.strava.com/api/v3/activities/111/streams?keys=heartrate,watts,velocity_smooth,time,distance&key_by_type=true");
  eq("activity+streams: analysis appended", out.includes("Analysis (6 samples):"), true);
  eq("activity+streams: decoupling rendered", out.includes("Pw:HR decoupling: 15.4%"), true);
}

{
  const { deps } = fake();
  eq("activity without id is stated", await strava(CFG, { op: "activity" }, deps),
     'strava: `id` is required when op is "activity".');
}

// ------------------------------------------------------------------ latest

{
  const { reqs, deps } = fake({ routes: {
    "https://www.strava.com/api/v3/athlete/activities": [
      ACT({ id: 1, type: "Run", sport_type: "TrailRun" }),
      ACT({ id: 2, type: "Ride", sport_type: "VirtualRide" }),
      ACT({ id: 3, type: "Ride", sport_type: "Ride" }),
    ],
    "https://www.strava.com/api/v3/activities/2": ACT({ id: 2, sport_type: "VirtualRide" }),
    "https://www.strava.com/api/v3/activities/1": ACT({ id: 1, sport_type: "TrailRun" }),
  } });
  const out = await strava(CFG, { op: "latest", kind: "Ride" }, deps);
  eq("latest: scans 15 recent", reqs[0].url.endsWith("per_page=15"), true);
  eq("latest: kind matches on `type` when sport_type differs", reqs[1].url.startsWith("https://www.strava.com/api/v3/activities/2?"), true);
  eq("latest: renders the chosen activity", out.includes("id 2"), true);

  const t = await strava(CFG, { op: "latest", kind: "TrailRun" }, deps);
  eq("latest: kind matches on sport_type", t.includes("id 1"), true);
  eq("latest: unknown kind is stated", await strava(CFG, { op: "latest", kind: "Swim" }, deps),
     "No recent activity of kind 'Swim' found (last 15 checked).");
}

// ---------------------------------------------------------------- analysis

eq("pyRound halves to even, like Python", [pyRound(2.5), pyRound(3.5), pyRound(0.125, 2)], [2, 4, 0.12]);

{
  // hr thirds: [100,130]=115, [150,160]=155, [170,180]=175
  // watts thirds: [100,120]=110, [150,150]=150, [140,130]=135
  // halves: h1=126.67 h2=170 p1=123.33 p2=140 → r1=.97368 r2=.82353 → 15.4%
  // zones: Z1:100 Z2:130 Z3:150 Z4:160 Z5:170,180 → 17/17/17/17/33
  eq("analyzeStreams matches the hand-computed result", analyzeStreams(STREAMS), {
    samples: 6,
    thirds: [
      { hr: 115, watts: 110, w_per_hr: 0.96 },
      { hr: 155, watts: 150, w_per_hr: 0.97 },
      { hr: 175, watts: 135, w_per_hr: 0.77 },
    ],
    decoupling_pct: 15.4,
    hr_zone_pct: { "Z1_<120": 17, "Z2_120-140": 17, "Z3_140-155": 17, "Z4_155-167": 17, "Z5_167+": 33 },
    has_watts: true,
  });
  eq("analyzeStreams: empty streams", analyzeStreams({}), { samples: 0 });
  const hrOnly = analyzeStreams({ heartrate: { data: [120, null, 140] } });
  // Blue returns 0.0 here: `mean([])` is 0.0 and `round(p / h, 2) if h else None`
  // sees a truthy h, so it yields 0, not None. Green departs on purpose — "0W"
  // rendered as a measured value on a ride that carried no power meter
  // (2026-09-19, activity 20206977704, summary avg 337W estimated). An absent
  // stream now reports absent, and has_watts says which case a caller is in.
  eq("analyzeStreams: no watts → no decoupling, watts null, w_per_hr null",
     [hrOnly.decoupling_pct, hrOnly.thirds![0].watts, hrOnly.thirds![0].w_per_hr, hrOnly.has_watts],
     [undefined, null, null, false]);
  eq("formatAnalysis: a power-less activity says so and prints no watts",
     formatAnalysis(hrOnly).includes("no power stream on this activity") &&
     !/\d+W/.test(formatAnalysis(hrOnly)),
     true);
  eq("formatAnalysis: a power activity keeps its watts and stays quiet",
     formatAnalysis(analyzeStreams(STREAMS)).includes("no power stream"), false);
  eq("analyzeStreams: w_per_hr is null only when hr segment is 0",
     analyzeStreams({ heartrate: { data: [null, null, null] }, watts: { data: [200, 200, 200] } }).thirds![0].w_per_hr, null);
  eq("analyzeStreams: nulls are skipped in zones", hrOnly.hr_zone_pct, { "Z1_<120": 0, "Z2_120-140": 50, "Z3_140-155": 50, "Z4_155-167": 0, "Z5_167+": 0 });
}

eq("formatRecent: empty is stated", formatRecent([]), "No recent activities.");

// -------------------------------------------------------------- error paths

{
  // A fetch-layer failure that quotes the request, the way undici/fetch errors do.
  const { deps } = fake({ routes: {
    "https://www.strava.com/api/v3/athlete/activities": () => {
      throw new Error(`fetch failed: {'Authorization': 'Bearer ${ACCESS}'} to https://www.strava.com`);
    },
  } });
  let msg = "";
  try { await strava(CFG, { op: "recent" }, deps); } catch (e) { msg = (e as Error).message; }
  eq("fetch error is rethrown, not swallowed", msg.startsWith("Strava GET /athlete/activities:"), true);
  eq("fetch error never carries the access token", msg.includes(ACCESS), false);
  eq("fetch error is redacted", msg.includes("[REDACTED]"), true);
}

{
  const { deps } = fake({ routes: { "https://www.strava.com/api/v3/activities/9": new Response("nope", { status: 401 }) } });
  let msg = "";
  try { await strava(CFG, { op: "activity", id: 9 }, deps); } catch (e) { msg = (e as Error).message; }
  eq("HTTP error names status and path, nothing else", msg, "Strava GET /activities/9: HTTP 401");
}

{
  const { deps } = fake({ expiresAt: 0, routes: { "https://www.strava.com/oauth/token": new Response("bad", { status: 400 }) } });
  let msg = "";
  try { await strava(CFG, { op: "recent" }, deps); } catch (e) { msg = (e as Error).message; }
  eq("failed refresh reports status only", msg, "Strava POST oauth/token: HTTP 400");
  eq("failed refresh leaks neither secret nor refresh token",
     [msg.includes(REFRESH), msg.includes(CFG.STRAVA_CLIENT_SECRET)], [false, false]);
}

{
  const { deps } = fake({ tokenRow: null });
  let msg = "";
  try { await strava(CFG, { op: "recent" }, deps); } catch (e) { msg = (e as Error).message; }
  eq("missing token row is actionable", msg.startsWith(`No Strava token at config key '${TOKEN_KEY}'`), true);
}

// ------------------------------------------------------------------ schema

eq("schema accepts each op", ["recent", "activity", "latest"].map((op) => stravaInputSchema.safeParse({ op }).success), [true, true, true]);
eq("schema rejects an unknown op", stravaInputSchema.safeParse({ op: "zones" }).success, false);
eq("description is one plain paragraph", STRAVA_TOOL_DESCRIPTION.includes("\n"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
