/**
 * `strava` — one tool, three ops, no OAuth hand-rolling.
 *
 * Port of `muninn_utils/strava.py`. The friction that module killed (Oskar,
 * 2026-06-14: "My GOD you struggled") was every session re-deriving the
 * refresh→fetch dance; here the dance is one tool call and the token never
 * touches the container at all — it lives in the Turso `config` table and is
 * refreshed by this Worker.
 *
 * Auth contract, transcribed:
 *  - STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are Worker secrets.
 *  - The token triple {access_token, refresh_token, expires_at} is JSON in the
 *    `config` row keyed `strava-oauth-token` (category ops).
 *  - If `expires_at - now < 300s`, POST the refresh grant and write the rotated
 *    triple back to the SAME row (value + updated_at; every other column —
 *    boot_load, read_only, source — is preserved, which is the one place this
 *    deliberately differs from blue's INSERT OR REPLACE via config_set).
 *  - Blue's first-run fallback (FTS-recall a legacy memory and migrate it) is
 *    NOT ported: the key has existed since the migration ran, and an FTS probe
 *    from a tool whose contract is "the token is at a stable key" reintroduces
 *    the category-guessing the module exists to end.
 *
 * Three verbs behind an `op` discriminator, not three tools: the connector's
 * 8-12 tool budget is spent in every conversation whether or not Strava is
 * mentioned.
 */

import * as z from "zod/v4";
import { db, withRetry, type Config } from "./turso.ts";
import { sanitizeError } from "./tools.ts";
import { configGet } from "./queries.ts";

export const TOKEN_KEY = "strava-oauth-token";
export const API = "https://www.strava.com/api/v3";
export const OAUTH = "https://www.strava.com/oauth/token";
/** Refresh if within 5 min of expiry — blue's `_REFRESH_SKEW`. */
export const REFRESH_SKEW_S = 300;

export type StravaConfig = Config & {
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
};

/** Injectable I/O. `now` is epoch MILLISECONDS (Date.now-shaped); Strava's `expires_at` is seconds. */
export interface StravaDeps {
  fetch: typeof fetch;
  db: typeof db;
  now: () => number;
}

export const defaultStravaDeps: StravaDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  db,
  now: () => Date.now(),
};

export const STRAVA_TOOL_DESCRIPTION =
  "Read Oskar's Strava data with the OAuth token managed server-side (stored in " +
  "config, auto-refreshed when within 5 minutes of expiry). op 'recent' lists the " +
  "last n activities as a compact table; 'activity' fetches one by id, optionally " +
  "with heart-rate/power streams and the derived analysis (thirds, Pw:HR " +
  "decoupling, HR-zone split); 'latest' is the newest activity, optionally " +
  "filtered by kind such as Ride or Run, fetched the same way as 'activity'.";

export const stravaInputSchema = z.object({
  op: z.enum(["recent", "activity", "latest"]).describe(
    "'recent': list summaries. 'activity': one activity by id. 'latest': newest activity, optionally of one kind.",
  ),
  n: z.number().int().min(1).max(50).optional().describe("op='recent' only. How many to list; default 5."),
  id: z.union([z.string(), z.number()]).optional().describe("op='activity' only. The Strava activity id."),
  kind: z.string().optional().describe(
    "op='latest' only. Match against sport_type or type, e.g. 'Ride', 'Run', 'VirtualRide'. Omit for any.",
  ),
  with_streams: z.boolean().optional().describe(
    "'activity'/'latest': also fetch heartrate/watts/velocity/time/distance streams and append the analysis. Default false.",
  ),
});

export type StravaArgs = z.infer<typeof stravaInputSchema>;

// ------------------------------------------------------------------ token

export interface StravaToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

const TOKEN_UPDATE_SQL = "UPDATE config SET value = ?, updated_at = ? WHERE key = ?";

const isoNow = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Read the triple from config. A missing row is the one actionable error here. */
async function loadToken(config: StravaConfig, deps: StravaDeps): Promise<StravaToken> {
  const raw = await withRetry(() => configGet(deps.db(config), TOKEN_KEY));
  if (!raw) {
    throw new Error(`No Strava token at config key '${TOKEN_KEY}'. Re-run the OAuth grant to seed it.`);
  }
  let tok: Partial<StravaToken>;
  try {
    tok = JSON.parse(raw);
  } catch {
    throw new Error(`Config key '${TOKEN_KEY}' is not valid JSON.`);
  }
  if (!tok || typeof tok.access_token !== "string" || typeof tok.refresh_token !== "string") {
    throw new Error(`Config key '${TOKEN_KEY}' lacks access_token/refresh_token.`);
  }
  return { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Number(tok.expires_at) || 0 };
}

/**
 * POST the refresh grant and persist the rotated triple.
 *
 * The response body is never quoted in an error: a failed refresh reports the
 * HTTP status only. The request body carries client_secret and refresh_token,
 * so a fetch-layer error is passed through `sanitizeError` and the body is not
 * part of the message we build.
 */
async function refreshToken(config: StravaConfig, tok: StravaToken, deps: StravaDeps): Promise<StravaToken> {
  const body = new URLSearchParams({
    client_id: config.STRAVA_CLIENT_ID,
    client_secret: config.STRAVA_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: tok.refresh_token,
  });
  const resp = await httpJson(deps, OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, "POST oauth/token");
  const next: StravaToken = {
    access_token: String(resp.access_token ?? ""),
    refresh_token: String(resp.refresh_token ?? ""),
    expires_at: Number(resp.expires_at) || 0,
  };
  if (!next.access_token || !next.refresh_token) {
    throw new Error("Strava token refresh returned no access_token/refresh_token.");
  }
  await withRetry(() => deps.db(config).execute({
    sql: TOKEN_UPDATE_SQL,
    args: [JSON.stringify(next), isoNow(deps.now()), TOKEN_KEY],
  }));
  return next;
}

/** Return a valid bearer token, refreshing + persisting if needed. Port of `access_token()`. */
export async function accessToken(config: StravaConfig, deps: StravaDeps = defaultStravaDeps): Promise<string> {
  let tok = await loadToken(config, deps);
  if (tok.expires_at - deps.now() / 1000 < REFRESH_SKEW_S) tok = await refreshToken(config, tok, deps);
  return tok.access_token;
}

// ------------------------------------------------------------------- http

type Json = Record<string, any>;

/**
 * One JSON request. Non-2xx is an error naming the status and a label for the
 * request, never the URL's query string, headers or body — the label is the
 * only request-derived text that can reach a client. Retried through the
 * shared withRetry (its 503/429 needles match the status we embed), with the
 * 3-attempt budget blue's `_http` uses.
 */
async function httpJson(deps: StravaDeps, url: string, init: RequestInit, label: string): Promise<Json> {
  return withRetry(async () => {
    let res: Response;
    try {
      res = await deps.fetch(url, init);
    } catch (err) {
      throw new Error(`Strava ${label}: ${sanitizeError(err)}`);
    }
    if (!res.ok) throw new Error(`Strava ${label}: HTTP ${res.status}`);
    try {
      return (await res.json()) as Json;
    } catch {
      throw new Error(`Strava ${label}: non-JSON response (HTTP ${res.status})`);
    }
  }, { maxRetries: 3 });
}

async function apiGet(deps: StravaDeps, path: string, token: string): Promise<Json> {
  const label = `GET ${path.split("?")[0]}`;
  return httpJson(deps, `${API}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }, label);
}

// --------------------------------------------------------------- analysis

/**
 * Python's `round()`: half-to-even, which differs from Math.round on exact
 * .5 ties (Python round(2.5) == 2, Math.round(2.5) == 3). analyze_streams is a
 * port whose numbers are compared against blue's, so the tie rule is kept.
 */
export function pyRound(x: number, ndigits = 0): number {
  const f = 10 ** ndigits;
  const y = x * f;
  const fl = Math.floor(y);
  const diff = y - fl;
  let r: number;
  if (diff > 0.5) r = fl + 1;
  else if (diff < 0.5) r = fl;
  else r = fl % 2 === 0 ? fl : fl + 1;
  return ndigits ? r / f : r;
}

function mean(xs: Array<number | null | undefined>): number {
  const ys = xs.filter((x): x is number => x !== null && x !== undefined);
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0.0;
}

export interface StreamThird { hr: number; watts: number; w_per_hr: number | null }

export interface StreamAnalysis {
  samples: number;
  thirds?: StreamThird[];
  decoupling_pct?: number;
  hr_zone_pct?: Record<string, number>;
}

/**
 * HR zone bands. These are the constants strava.py hardcodes (Oskar's own
 * zones, not fetched from the athlete profile); change them there first.
 */
export const HR_BANDS: Array<[string, number, number]> = [
  ["Z1_<120", 0, 120],
  ["Z2_120-140", 120, 140],
  ["Z3_140-155", 140, 155],
  ["Z4_155-167", 155, 167],
  ["Z5_167+", 167, 10 ** 9],
];

/**
 * Cardiac drift, Pw:HR decoupling, HR-zone split, thirds. Faithful port of
 * `analyze_streams`; input is the key_by_type=true stream dict.
 */
export function analyzeStreams(streams: Json): StreamAnalysis {
  const hr: Array<number | null> = streams?.heartrate?.data ?? [];
  const w: Array<number | null> = streams?.watts?.data ?? [];
  const n = hr.length;
  const out: StreamAnalysis = { samples: n };
  if (n === 0) return out;

  const seg = (lst: Array<number | null>, a: number, b: number) => (lst.length ? mean(lst.slice(a, b)) : 0.0);

  const thirds: StreamThird[] = [];
  for (let i = 0; i < 3; i++) {
    const a = Math.floor((i * n) / 3);
    const b = Math.floor(((i + 1) * n) / 3);
    const h = seg(hr, a, b);
    const p = seg(w, a, b);
    thirds.push({ hr: pyRound(h), watts: pyRound(p), w_per_hr: h ? pyRound(p / h, 2) : null });
  }
  out.thirds = thirds;

  const half = Math.floor(n / 2);
  if (w.length) {
    const h1 = seg(hr, 0, half), h2 = seg(hr, half, n);
    const p1 = seg(w, 0, half), p2 = seg(w, half, n);
    if (h1 && h2 && p1) {
      const r1 = p1 / h1, r2 = p2 / h2;
      out.decoupling_pct = pyRound(((r1 - r2) / r1) * 100, 1);
    }
  }

  const zones: Record<string, number> = {};
  let tot = 0;
  for (const [name, lo, hi] of HR_BANDS) {
    const c = hr.filter((x) => x !== null && x !== undefined && lo <= x && x < hi).length;
    zones[name] = c;
    tot += c;
  }
  out.hr_zone_pct = tot
    ? Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, pyRound((v / tot) * 100)]))
    : {};
  return out;
}

// ------------------------------------------------------------- formatting

const km = (m: unknown) => (Number(m) / 1000).toFixed(1);
const hms = (s: unknown) => {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const localDate = (a: Json) => String(a.start_date_local ?? a.start_date ?? "").replace("T", " ").replace(/Z$/, "");
const kindOf = (a: Json) => String(a.sport_type ?? a.type ?? "?");
const num = (v: unknown, digits = 0) => (v === null || v === undefined ? "—" : Number(v).toFixed(digits));

export function formatRecent(acts: Json[]): string {
  if (acts.length === 0) return "No recent activities.";
  const lines = acts.map((a) =>
    [
      String(a.id),
      localDate(a),
      String(a.name ?? "").replace(/\s+/g, " "),
      kindOf(a),
      `${km(a.distance)}km`,
      hms(a.moving_time),
      a.average_watts !== undefined && a.average_watts !== null ? `${num(a.average_watts)}W` : null,
      a.average_heartrate !== undefined && a.average_heartrate !== null ? `${num(a.average_heartrate)}bpm` : null,
    ].filter((c) => c !== null).join(" | "),
  );
  return [`${acts.length} recent activities (id | date | name | type | km | moving | watts | hr):`, ...lines].join("\n");
}

export function formatAnalysis(an: StreamAnalysis): string {
  const lines = [`Analysis (${an.samples} samples):`];
  if (an.thirds) {
    lines.push("  thirds: " + an.thirds
      .map((t, i) => `[${i + 1}] ${t.hr}bpm ${t.watts}W ${t.w_per_hr === null ? "—" : t.w_per_hr + "W/bpm"}`)
      .join("  "));
  }
  if (an.decoupling_pct !== undefined) lines.push(`  Pw:HR decoupling: ${an.decoupling_pct}%`);
  if (an.hr_zone_pct && Object.keys(an.hr_zone_pct).length) {
    lines.push("  HR zones: " + Object.entries(an.hr_zone_pct).map(([k, v]) => `${k} ${v}%`).join("  "));
  }
  return lines.join("\n");
}

export function formatActivity(a: Json, analysis?: StreamAnalysis): string {
  const head = `${a.name ?? "(untitled)"} — ${kindOf(a)} · ${localDate(a)} · id ${a.id}`;
  const facts: string[] = [
    `${km(a.distance)} km`,
    `moving ${hms(a.moving_time)}`,
    `elapsed ${hms(a.elapsed_time)}`,
    `elev ${num(a.total_elevation_gain)} m`,
  ];
  if (a.average_speed !== undefined && a.average_speed !== null) facts.push(`avg ${(Number(a.average_speed) * 3.6).toFixed(1)} km/h`);
  if (a.average_watts !== undefined && a.average_watts !== null) {
    facts.push(`avg ${num(a.average_watts)}W` + (a.weighted_average_watts ? ` / NP ${num(a.weighted_average_watts)}W` : ""));
  }
  if (a.average_heartrate !== undefined && a.average_heartrate !== null) {
    facts.push(`HR ${num(a.average_heartrate)}` + (a.max_heartrate ? `/${num(a.max_heartrate)}` : "") + " bpm");
  }
  if (a.kilojoules !== undefined && a.kilojoules !== null) facts.push(`${num(a.kilojoules)} kJ`);
  if (a.suffer_score !== undefined && a.suffer_score !== null) facts.push(`RE ${num(a.suffer_score)}`);
  if (a.gear?.name) facts.push(`gear ${a.gear.name}`);
  const out = [head, "  " + facts.join(" · ")];
  if (a.description) out.push("  " + String(a.description).replace(/\s+/g, " ").slice(0, 300));
  if (analysis) out.push(formatAnalysis(analysis));
  return out.join("\n");
}

// --------------------------------------------------------------- dispatch

async function fetchActivity(deps: StravaDeps, token: string, id: string, withStreams: boolean): Promise<string> {
  const a = await apiGet(deps, `/activities/${encodeURIComponent(id)}?include_all_efforts=false`, token);
  if (!withStreams) return formatActivity(a);
  const s = await apiGet(
    deps,
    `/activities/${encodeURIComponent(id)}/streams?keys=heartrate,watts,velocity_smooth,time,distance&key_by_type=true`,
    token,
  );
  return formatActivity(a, analyzeStreams(s));
}

export async function strava(
  config: StravaConfig,
  args: StravaArgs,
  deps: StravaDeps = defaultStravaDeps,
): Promise<string> {
  const op = args.op;
  const token = await accessToken(config, deps);

  if (op === "recent") {
    const n = Math.min(Math.max(Math.trunc(Number(args.n) || 5), 1), 50);
    const acts = (await apiGet(deps, `/athlete/activities?per_page=${n}`, token)) as unknown as Json[];
    return formatRecent(Array.isArray(acts) ? acts : []);
  }

  if (op === "activity") {
    const id = String(args.id ?? "").trim();
    if (!id) return 'strava: `id` is required when op is "activity".';
    return fetchActivity(deps, token, id, Boolean(args.with_streams));
  }

  // latest — blue scans recent(n=15) for the first matching type.
  const acts = (await apiGet(deps, "/athlete/activities?per_page=15", token)) as unknown as Json[];
  const kind = args.kind ? String(args.kind).trim() : "";
  const hit = (Array.isArray(acts) ? acts : []).find((s) =>
    !kind || String(s.sport_type ?? "") === kind || String(s.type ?? "") === kind,
  );
  if (!hit) return kind ? `No recent activity of kind '${kind}' found (last 15 checked).` : "No recent activities.";
  return fetchActivity(deps, token, String(hit.id), Boolean(args.with_streams));
}
