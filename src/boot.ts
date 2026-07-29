/**
 * The boot payload — green's port of `remembering/scripts/boot.py`.
 *
 * docs/mcp-migration.md §3 item 4 calls `_format_boot_output()` "~170 lines of
 * section ordering, topic grouping and priority sorting … the single largest
 * chunk of real porting work, and the one most likely to drift silently", and
 * §5's Stage 1 gate demands the boot payload be **byte-equal** between blue and
 * green. So the same rule that governs `turso.ts` and `queries.ts` governs this
 * file, harder: **TRANSCRIBE, DO NOT IMPROVE.** Where blue's formatting is ugly,
 * the ugliness is ported. Every deliberate difference is marked DIVERGENCE with
 * a reason.
 *
 * ------------------------------------------------------------------ THE SEAM
 *
 * §2 splits boot by *what the code needs*. Blue's `boot()` is two things wearing
 * one name: an **environment prelude** (`.pth` setup, `muninn_utils`
 * materialization, env-fallback persistence, GitHub access detection, and the
 * `_ensure_*` schema migrations — which are WRITES) and a **payload
 * composition** that turns Turso rows into text. Only the second half is here.
 * The prelude stays skill-shaped, by design, not by omission.
 *
 * ------------------------------------------------------- WHAT GREEN OMITS, AND
 * ------------------------------------------------------- WHY IT SAYS SO ALOUD
 *
 * Three of blue's sections are computed from things a read-only Worker cannot
 * observe: the skills mount, the locally materialized `~/muninn_utils/`, and the
 * process environment. Faking them from a build-time roster would produce a
 * plausible section describing a machine that does not exist — precisely the
 * silent drift §3 warns about. So green omits them, and every omission is
 * recorded in `BootPayload.omissions` and rendered as a trailing block. A boot
 * payload that quietly drops a section is a bug; one that names its gaps is a
 * partial answer, which is a different and honest thing.
 *
 * The formatter itself still implements every branch, so a caller that CAN
 * supply those inputs gets blue's exact bytes. `omissions: []` is the blue case
 * and produces no trailing block at all — which is what makes the byte-compare
 * meaningful.
 *
 * SCOPE DECISIONS for the three sections whose reachability is not obvious:
 *
 *  - `pending_tasks`  — PORTED. `_load_incomplete_tasks()` is one SELECT against
 *    `config WHERE category = 'task-state'`. Pure Turso.
 *  - `recent_flights` — OMITTED. `_load_recent_flights()` is a GitHub GraphQL
 *    call authenticated by `GH_TOKEN`. Not Turso, and §7 (the credential-proxy
 *    track) is explicitly decoupled from this migration.
 *  - `due_reminders`  — PORTED, read half only. `remind_due()`'s three SELECTs
 *    are pure Turso, but it also fires an UPDATE that un-snoozes expired snoozed
 *    reminders. That write is NOT ported (green is read-only) and it does not
 *    change this payload: the snoozed rows are unioned into the result set
 *    whether or not the UPDATE lands. What green cannot do is *persist* the
 *    state transition, so a snoozed-and-expired reminder stays snoozed in the DB
 *    until a blue boot un-snoozes it. Recorded as an omission for that reason,
 *    not because the section is missing.
 *
 * READ-ONLY BY CONSTRUCTION (§5, stage 1). Nothing here writes. If you find
 * yourself adding an UPDATE, the stage gate has not been met.
 */

import { db, withRetry, type Config } from "./turso.ts";
import type { Client } from "@libsql/client/web";

// ------------------------------------------------------------------ py-isms
//
// Four Python behaviours that a natural TypeScript rewrite gets wrong. They are
// here rather than inline because each one is load-bearing for byte-equality.

/**
 * Python's `round()` — round-half-to-EVEN, not half-away-from-zero.
 *
 * `round(2.5) == 2` in Python; `Math.round(2.5) === 3` in JS. Blue reaches for
 * `round()` twice in `_format_relative_age` (`round(day_diff / 30)` and
 * `round(years)`), and `day_diff = 75` lands exactly on 2.5 — so this is a real
 * corpus value, not a theoretical edge.
 */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Python's `f"{x:.0f}"` — same half-even rule, plus `-0` for small negatives.
 *
 * Used for the incomplete-task ages. `f"{-0.4:.0f}"` is `"-0"` in Python and the
 * sign survives; `String(pyRound(-0.4))` would be `"0"`.
 */
export function pyFormatF0(x: number): string {
  const r = pyRound(x);
  if (r === 0 && (x < 0 || Object.is(x, -0))) return "-0";
  return String(r);
}

/**
 * Python's `int(str)` for the priority column, narrowed to what SQLite can hold.
 *
 * DIVERGENCE (narrowing): Python's `int()` also accepts underscore separators
 * (`"1_000"`) and non-ASCII decimal digits. Neither can appear in a `priority`
 * column written by `config_set`, and supporting them would be inventing
 * behaviour the corpus cannot exercise. Anything unparseable yields 0, exactly
 * as blue's `except ValueError` does.
 */
export function pyInt(s: string): number {
  const t = s.trim();
  return /^[+-]?\d+$/.test(t) ? Number(t) : 0;
}

/**
 * Python renders `None` as the four characters `None` inside an f-string.
 *
 * `_format_entry` interpolates `entry['value']` unguarded, so a NULL config
 * value produces `### key\nNone` in blue and would produce `null` here. No such
 * row exists today — `config_set` always writes a string — but the two spellings
 * are exactly the kind of one-word delta a byte-compare is for.
 */
function pyStr(v: unknown): string {
  return v === null || v === undefined ? "None" : String(v);
}

// ------------------------------------------------------------- ops topics

/**
 * `boot.py::_DEFAULT_OPS_TOPICS`, transcribed including order.
 *
 * The ORDER of the keys is output, not decoration: `_format_boot_output`
 * iterates `OPS_TOPICS.keys()` to decide which topic heading prints first. Do
 * not alphabetize this.
 */
export const DEFAULT_OPS_TOPICS: Record<string, string[]> = {
  "Core Boot & Behavior": [
    "boot-behavior", "boot-output-hygiene", "dev-workflow",
    "grounding-safeguards", "token-discipline",
    "training-knowledge-dated",
  ],
  "Memory Discipline": [
    "remembering-api", "memory-types", "storage-discipline",
    "recall-discipline", "recall-before-solutions", "recall-fields",
    "recall-triggers", "priority-usage",
    "knowledge-vs-experience-storage", "interaction-memories",
    "large-memory-preamble", "resource-before-storage",
    "remembering-no-init", "decision-alternatives",
  ],
  "Analysis & Delivery": [
    "analysis-workflow", "file-first-analysis",
    "task-deliver-workflow", "insight-to-implementation",
    "exp-command", "repo-review-workflow",
  ],
  "Communication & Voice": [
    "communication-patterns", "question-style",
    "language-precision",
  ],
  "Commands & Shortcuts": [
    "fly-command", "rem-command", "zeitgeist-command",
  ],
  "Therapy & Self-Improvement": [
    "therapy", "therapy-experience-layer-audit",
    "memory-consolidation", "serendipity-usage",
    "memory-backup",
  ],
  "External Platforms": [
    "blog-post-platform", "bsky-feed-shortcuts",
    "bsky-api-endpoints", "github-issues",
    "url-retrieval-assistance",
  ],
  "Development & Technical": [
    "error-handling", "skill-workflow",
    "dynamic-code-vs-handoff", "skill-file-changes",
    "batch-processing-drift", "cache-testing-lesson",
    "use-review-skill",
  ],
  "Environment & Infrastructure": [
    "env-file-handling", "python-remembering-setup",
    "muninn-env-loading", "muninn-utils-workflow",
    "utility-code-storage", "jq-install",
    "austegard-com-hosting", "python-path-setup",
    "heredoc-for-multiline", "container-limits",
    "network-tools", "github-container-access",
    "github-pat-permissions", "mapping-codebases-usage",
  ],
};

/**
 * Port of `_load_ops_topics()`. Takes the raw `ops-topics` config value.
 *
 * Blue validates that every value is a list and falls back to the defaults on
 * ANY exception — a bad map must never break boot. Note that the fallback is a
 * `.copy()` of the defaults, so the caller may mutate; we return a fresh object
 * for the same reason.
 *
 * Key order survives `JSON.parse` in JS as it does in Python's `json.loads`,
 * with one caveat that does not apply here: integer-like keys would be hoisted
 * and sorted by the JS object model. Topic names are prose.
 */
export function loadOpsTopics(raw: string | null | undefined): Record<string, string[]> {
  try {
    if (raw) {
      const topics = JSON.parse(raw);
      if (topics !== null && typeof topics === "object" && !Array.isArray(topics)) {
        for (const value of Object.values(topics as Record<string, unknown>)) {
          if (!Array.isArray(value)) throw new Error("topic value must be a list");
        }
        return topics as Record<string, string[]>;
      }
    }
  } catch {
    // Fall back to defaults on any error — blue's bare `except Exception: pass`.
  }
  return { ...DEFAULT_OPS_TOPICS };
}

/**
 * Port of `_build_key_to_topic_map()`. Later topics win on a duplicate key,
 * because blue assigns unconditionally while iterating in insertion order.
 */
export function buildKeyToTopicMap(opsTopics: Record<string, string[]>): Record<string, string> {
  const keyToTopic: Record<string, string> = {};
  for (const [topic, keys] of Object.entries(opsTopics)) {
    for (const key of keys) keyToTopic[key] = topic;
  }
  return keyToTopic;
}

/** Port of `classify_ops_key()`. Null means "uncategorized" — blue's `None`. */
export function classifyOpsKey(
  key: string,
  keyToTopic: Record<string, string>,
): string | null {
  return Object.prototype.hasOwnProperty.call(keyToTopic, key) ? keyToTopic[key] : null;
}

/**
 * A config row, as loose as Turso actually hands them back.
 *
 * Deliberately not `queries.ts::ConfigRow`: that interface requires every
 * column, which makes a formatter fixture eight fields long when the formatter
 * reads two of them. A real `ConfigRow` satisfies this.
 */
export interface BootConfigEntry {
  key: string;
  value?: unknown;
  priority?: unknown;
  boot_load?: unknown;
}

/**
 * Port of `group_ops_by_topic()`.
 *
 * The sort is `(-priority, key)`: priority DESCENDING so critical entries lead,
 * then key ascending as the tiebreak. Priority arrives from Turso as int, string
 * or NULL and blue coerces all three — `None -> 0`, unparseable string `-> 0`.
 *
 * Both languages' sorts are stable (ES2019 onward), and the explicit key
 * tiebreak makes stability unobservable anyway. String comparison differs in
 * principle — Python compares code points, JS compares UTF-16 code units — but
 * they agree on everything below U+E000, and ops keys are ASCII kebab-case.
 */
export function groupOpsByTopic(
  opsEntries: BootConfigEntry[],
  keyToTopic: Record<string, string>,
): { opsByTopic: Record<string, BootConfigEntry[]>; uncategorized: BootConfigEntry[] } {
  const opsByTopic: Record<string, BootConfigEntry[]> = {};
  const uncategorized: BootConfigEntry[] = [];

  for (const o of opsEntries) {
    const topic = classifyOpsKey(o.key, keyToTopic);
    if (topic) {
      if (!Object.prototype.hasOwnProperty.call(opsByTopic, topic)) opsByTopic[topic] = [];
      opsByTopic[topic].push(o);
    } else {
      uncategorized.push(o);
    }
  }

  const priorityOf = (entry: BootConfigEntry): number => {
    const p = entry.priority;
    if (p === null || p === undefined) return 0;
    if (typeof p === "string") return pyInt(p);
    // bigint is what libsql hands back for large INTEGER columns; boolean is
    // what Python's `-True == -1` would give, and Number() agrees.
    return Number(p);
  };
  const cmp = (a: BootConfigEntry, b: BootConfigEntry): number => {
    const pa = -priorityOf(a), pb = -priorityOf(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    if (a.key === b.key) return 0;
    return a.key < b.key ? -1 : 1;
  };

  for (const topic of Object.keys(opsByTopic)) opsByTopic[topic].sort(cmp);
  uncategorized.sort(cmp);

  return { opsByTopic, uncategorized };
}

/**
 * Port of `ops()`'s boot_load filter, which blue open-codes twice in `boot()`:
 * `core_ops` is `boot_load in (1, '1')`, `reference_ops` is `in (0, '0')`.
 *
 * Note what that means and is not tidied: a row whose `boot_load` is 2, or NULL,
 * or the string `"true"`, lands in NEITHER list and vanishes from boot output.
 * Python's `in` uses `==`, so `False == 0` puts a boolean False in the reference
 * bucket and True in the core bucket; the same coercion is reproduced here.
 */
export function bootLoadIn(value: unknown, wanted: 0 | 1): boolean {
  if (typeof value === "boolean") return (value ? 1 : 0) === wanted;
  if (typeof value === "bigint") return Number(value) === wanted;
  if (typeof value === "number") return value === wanted;
  if (typeof value === "string") return value === String(wanted);
  return false;
}

/** `boot()`'s `o.get('boot_load', 1)` — a missing column defaults to 1. */
function bootLoadOf(entry: BootConfigEntry): unknown {
  return entry.boot_load === undefined ? 1 : entry.boot_load;
}

/** Port of `_format_entry()`. Two lines, no trailing newline. */
export function formatEntry(entry: BootConfigEntry): string {
  return `### ${entry.key}\n${pyStr(entry.value)}`;
}

// ----------------------------------------------------------- relative time

/**
 * `result.py::_LOCAL_TZ` — hardcoded, per issue #461 ("single-user system").
 * Transcribed as a constant rather than made configurable.
 */
export const LOCAL_TZ = "America/New_York";

/**
 * Parse the ISO shapes `datetime.fromisoformat` accepts from this corpus.
 *
 * Written by hand rather than handed to `Date.parse` because of one specific
 * mismatch: a naive `2026-07-28T12:00:00` is UTC to Python (blue's explicit
 * `dt.replace(tzinfo=utc)`) and LOCAL TIME to `Date.parse`. On a Worker that is
 * the same thing; on a developer's laptop running the tests it is a four-hour
 * error that only appears off-Cloudflare.
 */
function parseIsoUtc(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:?\d{2})?$/
    .exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, off] = m;
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0), ms);
  if (off && off !== "Z") {
    const sign = off[0] === "-" ? -1 : 1;
    const body = off.slice(1).replace(":", "");
    t -= sign * (Number(body.slice(0, 2)) * 60 + Number(body.slice(2))) * 60000;
  }
  return Number.isNaN(t) ? null : t;
}

/** The Y/M/D a UTC instant falls on, in a named zone, as a day number. */
function localDayNumber(tz: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day")) / 86400000;
}

/**
 * Port of `result.py::_format_relative_age`.
 *
 * NOT the same function as `tools.ts::relativeAge`, and the two must not be
 * merged. `relativeAge` renders `30m ago` / `12h ago` / `9d ago` / `5mo ago` —
 * a compact per-row annotation for recall listings, whose text shape §3 item 3
 * froze independently. This one renders the vocabulary humans reach for:
 * `just now`, `yesterday`, `last week`, `about a year ago`. It also does its
 * day math on CALENDAR DAYS in `America/New_York` rather than on elapsed
 * seconds, so a write at 23:00 and a read at 01:00 is "yesterday", not "2h ago".
 * Different buckets, different boundaries, different units. Reusing either for
 * the other would change output on the very first row.
 *
 * Returns null on parse failure so callers omit the line cleanly — blue's
 * `_last_session_gap` relies on that.
 */
export function formatRelativeAge(createdAt: unknown, now: Date = new Date()): string | null {
  if (!createdAt || typeof createdAt !== "string") return null;
  const t = parseIsoUtc(createdAt);
  if (t === null) return null;

  const seconds = (now.getTime() - t) / 1000;
  if (seconds < 0) return "in the future";
  if (seconds < 60) return "just now";
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  }

  const dayDiff = localDayNumber(LOCAL_TZ, now.getTime()) - localDayNumber(LOCAL_TZ, t);

  if (dayDiff <= 0) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  }
  if (dayDiff === 1) return "yesterday";
  if (dayDiff < 7) return `${dayDiff} days ago`;
  if (dayDiff < 14) return "last week";
  if (dayDiff < 30) return `${Math.floor(dayDiff / 7)} weeks ago`;
  if (dayDiff < 60) return "last month";
  if (dayDiff < 365) return `${Math.max(2, pyRound(dayDiff / 30))} months ago`;
  const years = dayDiff / 365.25;
  if (years < 2) return "about a year ago";
  return `${pyRound(years)} years ago`;
}

/** Offset from UTC, in minutes, for a named zone at an instant. */
function tzOffsetMinutes(tz: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asIfUtc - (date.getTime() - date.getTime() % 1000)) / 60000);
}

/**
 * Port of `boot.py::_time_anchor`, minus its side effect.
 *
 * `tzRaw` is the raw `timezone` profile entry, which sometimes carries
 * instructional prose after the IANA name ("America/New_York\n\nDATE
 * GROUNDING…"). Blue takes the first non-empty line and falls back to UTC both
 * when the entry is missing and when `ZoneInfo` rejects it — note that the
 * second fallback also resets `tz_name` to `'UTC'`, so a typo'd zone renders as
 * UTC rather than half-rendering under its own name.
 *
 * NOT PORTED: blue writes today's local date to `/tmp/LOCAL_DATE` so shell
 * tooling can `cat` it. That is filesystem state for the session's bash, which
 * is the environment prelude §2 leaves skill-shaped, and a Worker has no `/tmp`.
 * It is invisible in the returned string, so it costs no byte-equality.
 *
 * DIVERGENCE (bounded, in `%Z`) — THE ONLY MEASURED DELTA IN THIS FILE. Blue
 * gets the zone abbreviation from `strftime('%Z')`, which reads the tz database
 * and knows every zone's abbreviation. JS has only `Intl`'s
 * `timeZoneName: "short"`, which is LOCALE data and only carries a "specific
 * non-location" name for the zones a given locale cares about; everything else
 * falls back to a numeric form. Measured against blue on 12 zone/instant pairs:
 *
 *     America/New_York  EDT   / EST   -> EDT   / EST     equal
 *     America/Los_Angeles PDT        -> PDT               equal
 *     UTC               UTC          -> UTC               equal
 *     Europe/Oslo       CEST         -> GMT+2             DIFFERS
 *     Asia/Kolkata      IST          -> GMT+5:30          DIFFERS
 *     Australia/Sydney  AEDT         -> GMT+11            DIFFERS
 *
 * `en-US` is not a lazy default and MUST NOT be swapped to "fix" the three: it
 * is the only locale that renders `EST`/`EDT` — `en-GB` yields `CEST` for Oslo
 * but `GMT-4` for New York, and `en-IN` fixes Kolkata and breaks New York.
 * There is no locale that agrees with blue everywhere, so the choice is which
 * zone to be exact for, and the live `timezone` profile entry is
 * `America/New_York`. Hardcoding an IANA-to-abbreviation table would close the
 * gap by inventing tz-database data inside green, which is precisely the kind
 * of "green's author knew better" divergence §5 records as a bug class.
 *
 * Practical consequence: the payload is byte-equal today and would grow a
 * one-token delta on this line if the `timezone` entry ever moved to a
 * non-US zone.
 *
 * DIVERGENCE (bounded, in DST): `now_local.dst()` asks the tz database for the
 * DST component of the offset. The Intl-based equivalent infers it — a zone is
 * on DST when its current offset is not its minimum offset across the year.
 * That is exact for every zone with a conventional DST rule and for zones with
 * none; it would misreport a zone that observes DST year-round.
 */
export function formatTimeAnchor(tzRaw: string | null | undefined, now: Date = new Date()): string {
  let tzName: string | null = null;
  if (tzRaw) {
    for (const line of String(tzRaw).split("\n")) {
      const trimmed = line.trim();
      if (trimmed) { tzName = trimmed; break; }
    }
  }
  if (!tzName) tzName = "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tzName });
  } catch {
    tzName = "UTC";
  }

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = dtf.formatToParts(now);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const stamp = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;

  const tzAbbrev = new Intl.DateTimeFormat("en-US", { timeZone: tzName, timeZoneName: "short" })
    .formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "UTC";

  const offsetMin = tzOffsetMinutes(tzName, now);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const offsetFmt = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;

  const year = Number(part("year"));
  const janOffset = tzOffsetMinutes(tzName, new Date(Date.UTC(year, 0, 1)));
  const julOffset = tzOffsetMinutes(tzName, new Date(Date.UTC(year, 6, 1)));
  const dstActive = offsetMin !== Math.min(janOffset, julOffset);

  return `⏰ ${stamp} ${tzAbbrev} (UTC${offsetFmt}) | DST: ${dstActive ? "active" : "inactive"}`;
}

// -------------------------------------------------------------- the payload

/** `detect_github_access()`'s return shape, as `_format_boot_output` reads it. */
export interface GithubAccess {
  available?: unknown;
  methods?: unknown[];
  recommended?: unknown;
  gh_cli?: { authenticated?: unknown; user?: unknown } | null;
  api_token?: unknown;
}

/** One entry from `_load_incomplete_tasks()`. */
export interface PendingTask {
  name?: unknown;
  task_type?: unknown;
  pending: unknown[];
  /** Unix seconds. Blue's `state.get('created', 0)`. */
  created?: unknown;
}

/** One node from `_load_recent_flights()`. Green never populates this. */
export interface Flight {
  number?: unknown;
  title?: unknown;
  createdAt?: unknown;
  closed?: unknown;
}

/** One entry from `remind_due()`. */
export interface Reminder {
  id?: unknown;
  text?: unknown;
  status?: unknown;
  recur_days?: unknown;
  valid_from?: unknown;
  kind?: unknown;
}

/** A section green declined to render, and the reason. Green's addition. */
export interface Omission {
  section: string;
  reason: string;
}

/**
 * Everything `_format_boot_output` reads, as data.
 *
 * DIVERGENCE (structural, and the point of the exercise): blue's formatter calls
 * `_time_anchor()`, `_last_session_gap()`, `render_task_routing()`,
 * `render_utilities()` and `spokes_summary()` from inside itself, so it cannot
 * be run without a database, a filesystem and a clock. Those five become fields.
 * Nothing about the composition changes — the formatter emits the same sections
 * in the same order from the same values — but it becomes a pure function, which
 * is what §5's byte-equality gate needs it to be.
 *
 * `taskRouting` and `utilitiesBlock` are PRE-RENDERED BLOCKS rather than the
 * inputs blue renders them from. Both are appended verbatim by blue, and both
 * are computed from local filesystem state, so green passes `null` (omit) and
 * a caller replaying blue passes the exact string blue produced. Modelling them
 * as `installed_utils: dict` would mean porting `capabilities.py`'s
 * `_trigger_snippet` sentence-splitter for a section green can never populate.
 *
 * `null` vs empty is a real distinction here and is the mechanism by which the
 * omissions stay visible:
 *   - `utilitiesBlock: ""` or `{}`-derived text -> blue's "None installed" line.
 *   - `utilitiesBlock: null` -> section omitted, and the caller should record an
 *     `Omission`. Blue has no such state; it always appends something.
 * `githubAccess: null` needs no such convention — blue's own `if github_access:`
 * already omits the section, so green's omission there is blue's behaviour.
 */
export interface BootPayload {
  timeAnchor: string;
  lastSessionGap: string | null;
  profile: BootConfigEntry[];
  opsByTopic: Record<string, BootConfigEntry[]>;
  /** `OPS_TOPICS.keys()` — the order topic headings print in. */
  topicOrder: string[];
  uncategorized: BootConfigEntry[];
  referenceOps: BootConfigEntry[];
  taskRouting: string | null;
  utilitiesBlock: string | null;
  githubAccess: GithubAccess | null;
  constellation: string | null;
  pendingTasks: PendingTask[];
  recentFlights: Flight[];
  dueReminders: Reminder[];
  omissions: Omission[];
}

/**
 * Port of `_format_boot_output()`. Pure — same input, same bytes, always.
 *
 * Section order is the contract and is transcribed exactly:
 *   time anchor, last-session gap, PROFILE, OPS (topics in `topicOrder`, then
 *   Other, then the reference index), CAPABILITIES (task routing, utilities,
 *   GitHub access), CONSTELLATION, INCOMPLETE TASKS, RECENT FLIGHTS, REMINDERS.
 *
 * Two things that look like bugs and are transcribed anyway:
 *   - `# CAPABILITIES` is appended UNCONDITIONALLY, before anything checks
 *     whether it will have content. Under green it is therefore a bare heading;
 *     the omissions block below explains why rather than the heading being
 *     silently dropped.
 *   - The `Other` heading counts and lists the uncategorized keys inline, so a
 *     drifted `ops-topics` config announces itself in the payload. Ugly, and the
 *     ugliness is the feature.
 *
 * `now` is only read by the INCOMPLETE TASKS ages, where blue calls
 * `datetime.now(UTC).timestamp()` inline.
 */
export function formatBootOutput(p: BootPayload, now: Date = new Date()): string {
  const output: string[] = [];

  // Time anchor (temporal grounding).
  output.push(p.timeAnchor);

  // Issue #19: elapsed-since-last-session line.
  if (p.lastSessionGap) output.push(p.lastSessionGap);

  // Profile section. Note: no boot_load filter — every profile row prints.
  if (p.profile.length) {
    output.push("# PROFILE");
    for (const entry of p.profile) output.push(formatEntry(entry));
  }

  // Ops section.
  const hasTopics = Object.keys(p.opsByTopic).length > 0;
  if (hasTopics || p.uncategorized.length) {
    output.push("\n# OPS");

    for (const topic of p.topicOrder) {
      if (Object.prototype.hasOwnProperty.call(p.opsByTopic, topic)) {
        output.push(`\n## ${topic}`);
        for (const o of p.opsByTopic[topic]) output.push(formatEntry(o));
      }
    }

    if (p.uncategorized.length) {
      const keys = p.uncategorized.map((o) => o.key);
      output.push(
        `\n## Other (${p.uncategorized.length} uncategorized — add to ops-topics: ${keys.join(", ")})`,
      );
      for (const o of p.uncategorized) output.push(formatEntry(o));
    }

    // Reference index: show what's available but not loaded.
    if (p.referenceOps.length) {
      output.push("\n## Reference Entries (load via config_get)");
      // Blue sorts these; the ops list arrives key-ordered already, but a
      // caller could pass any order, so the sort is transcribed not assumed.
      const refKeys = p.referenceOps.map((o) => o.key).sort();
      output.push(refKeys.join(", "));
    }
  }

  // Capabilities section (task routing, utilities, GitHub).
  output.push("\n# CAPABILITIES — reach for these before hand-rolling");

  if (p.taskRouting) output.push(p.taskRouting);
  if (p.utilitiesBlock !== null) output.push(p.utilitiesBlock);

  if (p.githubAccess) {
    output.push("\n## GitHub Access");
    if (p.githubAccess.available) {
      const methods = p.githubAccess.methods ?? [];
      output.push("  Status: Available");
      output.push(`  Methods: ${methods.map(pyStr).join(", ")}`);
      output.push(`  Recommended: ${pyStr(p.githubAccess.recommended)}`);

      const ghCli = p.githubAccess.gh_cli;
      if (ghCli && ghCli.authenticated) {
        if (ghCli.user) output.push(`  gh user: ${pyStr(ghCli.user)}`);
        output.push("  Usage: gh pr view, gh issue list, gh api repos/...");
      }
    } else {
      output.push("  Status: Not configured");
      output.push("  Note: Set GITHUB_TOKEN or authenticate gh CLI");
    }
  }

  // Constellation section (v6.0.0: hub-spoke awareness).
  if (p.constellation) {
    output.push("\n# CONSTELLATION");
    output.push(`  ${p.constellation}`);
    output.push("  Use spokes_status() for live state, spokes_discover() to find new repos");
  }

  // Incomplete tasks section (#332: cross-session task awareness).
  if (p.pendingTasks.length) {
    output.push(`\n# INCOMPLETE TASKS (${p.pendingTasks.length})`);
    output.push("⚠️  Resume these before starting new work:");
    const nowTs = now.getTime() / 1000;
    for (const t of p.pendingTasks) {
      const created = t.created === undefined ? nowTs : Number(t.created);
      const ageH = (nowTs - created) / 3600;
      const ageStr = ageH < 48 ? `${pyFormatF0(ageH)}h ago` : `${pyFormatF0(ageH / 24)}d ago`;
      const typeTag = t.task_type ? ` [${pyStr(t.task_type)}]` : "";
      output.push(`  ○ ${pyStr(t.name)}${typeTag} (${ageStr})`);
      output.push(`    Pending: ${t.pending.map(pyStr).join(", ")}`);
      output.push(`    Resume: t = task_resume('${pyStr(t.name)}')`);
    }
  }

  // Recent flight logs section (#415: perch flight awareness).
  if (p.recentFlights.length) {
    output.push("\n# RECENT FLIGHTS");
    for (const f of p.recentFlights) {
      const status = f.closed ? "CLOSED" : "OPEN";
      const date = String(f.createdAt ?? "").slice(0, 10);
      const number = f.number === undefined ? "?" : pyStr(f.number);
      const title = f.title === undefined ? "Untitled" : pyStr(f.title);
      output.push(`- #${number} (${date}, ${status}): ${title}`);
    }
  }

  // Due reminders section (#445).
  if (p.dueReminders.length) {
    output.push("\n🔔 REMINDERS:");
    for (const r of p.dueReminders) {
      const statusIcon = r.status === "overdue" ? "⚠️" : "📅";
      const recur = r.recur_days ? ` (every ${pyStr(r.recur_days)}d)` : "";
      const shortId = String(r.id ?? "").slice(0, 8);
      const status = r.status === undefined ? "?" : pyStr(r.status);
      const text = r.text === undefined ? "" : pyStr(r.text);
      output.push(`  - ${statusIcon} [${status}] ${text}${recur} (id: ${shortId})`);
    }
  }

  // ---- Green's only addition to the payload, and it only fires when green
  // actually dropped something. Blue's inputs produce `omissions: []` and this
  // block does not exist, which is what keeps the byte-compare honest.
  if (p.omissions.length) {
    output.push(`\n# OMITTED FROM THIS PAYLOAD (${p.omissions.length})`);
    output.push("  Sections blue renders that a read-only Worker cannot reach:");
    for (const o of p.omissions) output.push(`  - ${o.section} — ${o.reason}`);
  }

  return output.join("\n");
}

// ------------------------------------------------------------- data gathering
//
// Everything below reaches Turso. Nothing below formats.

/** `boot()`'s `_exec_batch` pair, transcribed verbatim including the literals. */
export const PROFILE_SQL = "SELECT * FROM config WHERE category = 'profile' ORDER BY key";
export const OPS_SQL = "SELECT * FROM config WHERE category = 'ops' ORDER BY key";
/** `_load_incomplete_tasks()`. No ORDER BY in blue; not added here. */
export const TASK_STATE_SQL = "SELECT value FROM config WHERE category = 'task-state'";
/** `config.py::config_get`, used for `timezone`, `ops-topics` and `spoke-registry`. */
export const CONFIG_GET_SQL = "SELECT value FROM config WHERE key = ?";
/**
 * `_last_session_gap()`, unconditional branch.
 *
 * Blue has two branches, chosen by `get_session_id()`: when `MUNINN_SESSION_ID`
 * names a real session it excludes that session's own writes, otherwise it takes
 * the most recent memory outright. A Worker has no session id — the request is
 * the session — so only the second branch is reachable and only it is ported.
 * Blue's own docstring records that the first branch is nearly dead in practice
 * anyway: "the live DB shows nearly every memory shares
 * `session_id = 'default-session'`".
 */
export const LAST_SESSION_SQL =
  "SELECT created_at FROM memories " +
  "WHERE deleted_at IS NULL " +
  "ORDER BY created_at DESC LIMIT 1";

/** `remind_due()`'s three SELECTs, transcribed including the LIKE patterns. */
export const REMIND_ACTIVE_SQL =
  `SELECT id, summary, valid_from, tags FROM memories
           WHERE deleted_at IS NULL AND tags LIKE '%"remind-active"%'
             AND valid_from <= ? ORDER BY valid_from ASC`;
export const REMIND_SNOOZED_SQL =
  `SELECT id, summary, valid_from, tags FROM memories
           WHERE deleted_at IS NULL AND tags LIKE '%"remind-snoozed"%'
             AND valid_from <= ? ORDER BY valid_from ASC`;
export const REMIND_FUTURE_ALERT_SQL =
  `SELECT id, summary, valid_from, tags FROM memories
           WHERE deleted_at IS NULL AND tags LIKE '%"remind-active"%'
             AND valid_from > ? AND summary LIKE '%alert_before_days%'
           ORDER BY valid_from ASC`;

/** Injectable I/O, matching `tools.ts`'s shape so one Deps can serve both. */
export interface BootDeps {
  db: (config: Config) => Client;
  /** Injectable clock. Boot reads it four times and must read one value. */
  now?: () => Date;
}

export const defaultBootDeps: BootDeps = { db };

function rowsOf(rs: { rows: unknown }): Record<string, unknown>[] {
  return (rs.rows ?? []) as Record<string, unknown>[];
}

async function selectRows(
  client: Client,
  sql: string,
  args: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return rowsOf(await client.execute({ sql, args: args as never }));
}

async function configValue(client: Client, key: string): Promise<string | null> {
  const rows = await selectRows(client, CONFIG_GET_SQL, [key]);
  return rows.length ? String(rows[0].value) : null;
}

/**
 * Port of `_load_incomplete_tasks()` (#332).
 *
 * Blue swallows per-row parse failures with `continue` and the whole thing with
 * `return []`; both layers are kept. A task with no pending steps is dropped, so
 * a completed-but-not-cleaned task-state row does not clutter boot.
 *
 * Step ORDER is the JSON object's key order in both languages, with the same
 * caveat as ops-topics: purely numeric step names would be hoisted by the JS
 * object model. Step names are prose.
 */
export async function loadIncompleteTasks(client: Client): Promise<PendingTask[]> {
  try {
    const rows = await selectRows(client, TASK_STATE_SQL);
    const result: PendingTask[] = [];
    for (const row of rows) {
      try {
        const state = JSON.parse(String(row.value ?? "{}")) as Record<string, unknown>;
        const steps = (state.steps ?? {}) as Record<string, unknown>;
        const pending = Object.keys(steps).filter((s) => !steps[s]);
        if (pending.length) {
          result.push({
            name: state.name === undefined ? "?" : state.name,
            task_type: state.task_type,
            pending,
            created: state.created === undefined ? 0 : state.created,
          });
        }
      } catch {
        continue;
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Port of `spokes.py::spokes_summary` plus `_load_registry`.
 *
 * Returns "" for an empty registry — blue's own sentinel, which
 * `_format_boot_output`'s `if constellation:` then omits on. Returns null when
 * anything throws, which is what blue's `try/except` around the whole
 * CONSTELLATION block does. A registry row missing `repo` is a KeyError in blue
 * and therefore removes the section; that is reproduced rather than defended
 * against, because a half-rendered constellation would be worse than none.
 */
export async function spokesSummary(client: Client): Promise<string | null> {
  try {
    const raw = await configValue(client, "spoke-registry");
    let registry: Record<string, unknown> = { spokes: [], owner: "oaustegard" };
    if (raw) {
      try {
        registry = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        registry = { spokes: [], owner: "oaustegard" };
      }
    }
    const spokes = (registry.spokes ?? []) as Record<string, unknown>[];
    if (!spokes.length) return "";
    const names = spokes.map((s) => {
      if (s.repo === undefined) throw new Error("spoke has no repo");
      const segments = String(s.repo).split("/");
      return segments[segments.length - 1];
    });
    return `${names.join(", ")} (${names.length} spokes)`;
  } catch {
    return null;
  }
}

/** `remind.py::_parse_meta`. First `META: ` line wins; junk yields `{}`. */
export function parseReminderMeta(summary: string): Record<string, unknown> {
  for (const line of summary.split("\n")) {
    if (line.startsWith("META: ")) {
      try {
        const parsed = JSON.parse(line.slice(6));
        return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    }
  }
  return {};
}

/** `remind.py::_clean_summary`. Strips bookkeeping lines and the REMIND prefix. */
export function cleanReminderSummary(summary: string): string {
  const lines: string[] = [];
  for (const line of summary.split("\n")) {
    if (
      line.startsWith("META: ") || line.startsWith("COMPLETED: ") ||
      line.startsWith("DONE: ") || line.startsWith("STALE: ")
    ) continue;
    if (line.startsWith("REMIND: ")) lines.push(line.slice(8));
    else if (line.startsWith("REMINDER: ")) lines.push(line.slice(10));
    else lines.push(line);
  }
  return lines.join("\n").trim();
}

/**
 * Python's `datetime.isoformat().replace("+00:00", "Z")`.
 *
 * Two details that matter because the result is compared as a STRING in SQL:
 * Python renders microseconds (six digits, JS gives three, so pad), and Python
 * OMITS the fractional part entirely when it is zero. Emitting `.000000` on a
 * whole-second boot instant would make `valid_from <= now_iso` false for a
 * reminder due at exactly that second, since `'Z' > '.'`.
 */
function isoZ(d: Date): string {
  const iso = d.toISOString();
  const m = /\.(\d{3})Z$/.exec(iso);
  if (!m) return iso;
  return m[1] === "000"
    ? iso.replace(/\.\d{3}Z$/, "Z")
    : iso.replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** Python's `timedelta.days` — floor division, not truncation. */
function timedeltaDays(ms: number): number {
  return Math.floor(ms / 86400000);
}

/**
 * Port of `muninn_utils/remind.py::remind_due`, READ HALF ONLY.
 *
 * NOT PORTED — the un-snooze UPDATE. Blue rewrites the tags of every expired
 * `remind-snoozed` row to `remind-active` before building the result. That is a
 * write, and green is read-only; the omission does not change THIS payload,
 * because the snoozed rows are unioned into the result set either way. It does
 * mean the state transition is not persisted, so the row stays snoozed until a
 * blue boot promotes it. That is the honest cost and it is recorded as an
 * `Omission` rather than absorbed.
 *
 * DIVERGENCE (sub-millisecond): blue's `now_iso` carries microseconds and
 * green's carries milliseconds zero-padded to six digits. Both are compared as
 * strings against `valid_from` in SQL. The two can differ only for a reminder
 * whose `valid_from` falls inside the same millisecond as the boot, which no
 * writer can produce — `remind()` stores dates or whole seconds.
 */
export async function remindDue(
  client: Client,
  now: Date,
  horizonDays = 2,
): Promise<Reminder[]> {
  const nowIso = isoZ(now);
  const horizonIso = isoZ(new Date(now.getTime() + horizonDays * 86400000));

  const active = await selectRows(client, REMIND_ACTIVE_SQL, [horizonIso]);
  const snoozed = await selectRows(client, REMIND_SNOOZED_SQL, [nowIso]);
  // (blue un-snoozes here — see the docstring)
  const futureAlert = await selectRows(client, REMIND_FUTURE_ALERT_SQL, [horizonIso]);

  const results: Reminder[] = [];
  const seen = new Set<string>();
  for (const row of [...active, ...snoozed, ...futureAlert]) {
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const summary = String(row.summary ?? "");
    const meta = parseReminderMeta(summary);
    const vf = row.valid_from === undefined ? "" : String(row.valid_from);

    let status: string;
    if (vf <= nowIso) {
      status = vf < nowIso.slice(0, 10) ? "overdue" : "due";
    } else {
      const alertDays = meta.alert_before_days;
      if (alertDays) {
        const dueMs = parseIsoUtc(vf);
        if (dueMs === null) continue;
        if (now.getTime() >= dueMs - Number(alertDays) * 86400000) {
          status = `upcoming (${timedeltaDays(dueMs - now.getTime())}d)`;
        } else continue;
      } else if (vf <= horizonIso) {
        const dueMs = parseIsoUtc(vf);
        if (dueMs === null) continue;
        status = `upcoming (${timedeltaDays(dueMs - now.getTime())}d)`;
      } else continue;
    }

    results.push({
      id,
      text: cleanReminderSummary(summary),
      valid_from: vf,
      kind: meta.kind === undefined ? "nag" : meta.kind,
      recur_days: meta.recur_days,
      status,
    });
  }
  return results;
}

/**
 * The sections green declines to render, with the reason each one is unreachable.
 *
 * Exported so `resources.ts`/`server.ts` can surface the same list without
 * re-deriving it, and so a test can assert the set has not silently shrunk.
 */
export const GREEN_OMISSIONS: Omission[] = [
  {
    section: "Task Routing",
    reason:
      "rendered from SKILL.md frontmatter on the skills mount (/mnt/skills/user); " +
      "a Worker has no filesystem",
  },
  {
    section: "Utilities",
    reason:
      "blue lists what fetch_muninn_utils() materialized into ~/muninn_utils/ this " +
      "session, which green cannot observe — the repo-level roster is at muninn://utilities",
  },
  {
    section: "GitHub Access",
    reason: "detect_github_access() probes the gh CLI and GITHUB_TOKEN in the session env",
  },
  {
    section: "Recent Flights",
    reason: "GitHub GraphQL discussions, authenticated by GH_TOKEN (§7's proxy track)",
  },
  {
    section: "Reminder un-snooze",
    reason:
      "remind_due()'s UPDATE promoting expired remind-snoozed rows is a write; " +
      "the reminders themselves are listed, but the transition is not persisted",
  },
];

/**
 * Gather everything the formatter needs, then format it.
 *
 * Retries wrap the config fetch only, mirroring `boot()`: profile and ops are
 * the payload, and blue treats their failure as fatal-with-fallback while every
 * optional section degrades to nothing. Green has no `defaults/*.json` to fall
 * back to — that directory is part of the skill install — so a config failure
 * propagates to the caller instead of returning blue's
 * `"ERROR: Unable to load config …"` string. A tool error is the right shape for
 * that in MCP; a payload that says ERROR in prose would be indistinguishable
 * from a successful boot to anything downstream.
 *
 * The optional sections are fetched concurrently and each swallows its own
 * failure, which is what blue's per-section `try/except` amounts to.
 */
export async function composeBoot(
  config: Config,
  deps: BootDeps = defaultBootDeps,
): Promise<string> {
  const client = deps.db(config);
  const now = (deps.now ?? (() => new Date()))();

  const [profileRows, opsRows] = await withRetry(() =>
    Promise.all([
      selectRows(client, PROFILE_SQL),
      selectRows(client, OPS_SQL),
    ])
  );

  const [topicsRaw, tzRaw, lastCreated, constellation, pendingTasks, dueReminders] =
    await Promise.all([
      configValue(client, "ops-topics").catch(() => null),
      configValue(client, "timezone").catch(() => null),
      selectRows(client, LAST_SESSION_SQL).catch(() => []),
      spokesSummary(client),
      loadIncompleteTasks(client),
      remindDue(client, now).catch(() => [] as Reminder[]),
    ]);

  const opsTopics = loadOpsTopics(topicsRaw);
  const keyToTopic = buildKeyToTopicMap(opsTopics);

  const ops = opsRows as unknown as BootConfigEntry[];
  const coreOps = ops.filter((o) => bootLoadIn(bootLoadOf(o), 1));
  const referenceOps = ops.filter((o) => bootLoadIn(bootLoadOf(o), 0));
  const { opsByTopic, uncategorized } = groupOpsByTopic(coreOps, keyToTopic);

  const gap = lastCreated.length
    ? formatRelativeAge(lastCreated[0].created_at, now)
    : null;

  return formatBootOutput({
    timeAnchor: formatTimeAnchor(tzRaw, now),
    lastSessionGap: gap ? `⏳ Last session activity: ${gap}` : null,
    profile: profileRows as unknown as BootConfigEntry[],
    opsByTopic,
    topicOrder: Object.keys(opsTopics),
    uncategorized,
    referenceOps,
    taskRouting: null,
    utilitiesBlock: null,
    githubAccess: null,
    constellation,
    pendingTasks,
    recentFlights: [],
    dueReminders,
    omissions: GREEN_OMISSIONS,
  }, now);
}
