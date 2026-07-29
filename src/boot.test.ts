/**
 * Coverage for the boot payload formatter.
 *
 * The formatter is the one thing §5's Stage 1 gate asks to be BYTE-EQUAL between
 * blue and green, so these tests assert whole strings rather than substrings
 * wherever the whole string is short enough to read. Anything asserted with
 * `.includes()` is asserting a presence/absence question, not a shape.
 *
 * The live blue-vs-green byte comparison lives outside this file — it needs the
 * Python and a Turso connection. This is the part that must stay runnable with
 * neither.
 */
import {
  DEFAULT_OPS_TOPICS,
  GREEN_OMISSIONS,
  LAST_SESSION_SQL,
  OPS_SQL,
  PROFILE_SQL,
  bootLoadIn,
  buildKeyToTopicMap,
  classifyOpsKey,
  cleanReminderSummary,
  composeBoot,
  formatBootOutput,
  formatEntry,
  formatRelativeAge,
  formatTimeAnchor,
  groupOpsByTopic,
  loadIncompleteTasks,
  loadOpsTopics,
  parseReminderMeta,
  pyFormatF0,
  pyInt,
  pyRound,
  remindDue,
  spokesSummary,
  type BootConfigEntry,
  type BootDeps,
  type BootPayload,
} from "./boot.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

const NOW = new Date("2026-07-29T16:00:00Z");
const CFG = { TURSO_URL: "x", TURSO_TOKEN: "y" };

/** A payload with every section empty — the floor every test builds up from. */
const bare = (over: Partial<BootPayload> = {}): BootPayload => ({
  timeAnchor: "⏰ ANCHOR",
  lastSessionGap: null,
  profile: [],
  opsByTopic: {},
  topicOrder: Object.keys(DEFAULT_OPS_TOPICS),
  uncategorized: [],
  referenceOps: [],
  taskRouting: null,
  utilitiesBlock: null,
  githubAccess: null,
  constellation: null,
  pendingTasks: [],
  recentFlights: [],
  dueReminders: [],
  omissions: [],
  ...over,
});

const entry = (key: string, value: string, over: Partial<BootConfigEntry> = {}): BootConfigEntry =>
  ({ key, value, ...over });

// ------------------------------------------------------------------ py-isms
// Python's rounding is half-to-EVEN. A natural Math.round() port is wrong on
// every exact half, and day_diff/30 lands on one at day_diff = 75.

eq("pyRound rounds half to even, down", pyRound(2.5), 2);
eq("pyRound rounds half to even, up", pyRound(3.5), 4);
eq("pyRound is ordinary away from halves", pyRound(2.6), 3);
eq("pyRound handles negative halves", pyRound(-2.5), -2);
eq("pyFormatF0 keeps Python's -0", pyFormatF0(-0.4), "-0");
eq("pyFormatF0 rounds half to even", pyFormatF0(2.5), "2");
eq("pyInt parses a signed integer string", pyInt(" -12 "), -12);
eq("pyInt yields 0 on a float string, as int() raises", pyInt("5.0"), 0);
eq("pyInt yields 0 on junk", pyInt("high"), 0);

// Blue's `boot_load in (1, '1')` / `in (0, '0')`. A row that is neither lands in
// NEITHER bucket and vanishes from boot — transcribed, not repaired.
eq("boot_load 1 is core", bootLoadIn(1, 1), true);
eq("boot_load '1' is core (Turso stringifies)", bootLoadIn("1", 1), true);
eq("boot_load 0 is reference", bootLoadIn(0, 0), true);
eq("boot_load 2 is neither", [bootLoadIn(2, 1), bootLoadIn(2, 0)], [false, false]);
eq("boot_load null is neither", [bootLoadIn(null, 1), bootLoadIn(null, 0)], [false, false]);
eq("boot_load False is reference (Python's False == 0)", bootLoadIn(false, 0), true);

// ------------------------------------------------------------- ops topics

eq("a missing ops-topics config falls back to the defaults",
   Object.keys(loadOpsTopics(null))[0], "Core Boot & Behavior");
eq("a topic whose value is not a list invalidates the whole map",
   loadOpsTopics('{"A": ["x"], "B": "not-a-list"}'), DEFAULT_OPS_TOPICS);
eq("a valid map replaces the defaults entirely",
   loadOpsTopics('{"Only": ["a","b"]}'), { Only: ["a", "b"] });
eq("map key order survives the parse (it is the heading order)",
   Object.keys(loadOpsTopics('{"Z":["z"],"A":["a"]}')), ["Z", "A"]);

{
  // Later topics win on a duplicate key, because blue assigns unconditionally.
  const map = buildKeyToTopicMap({ First: ["shared"], Second: ["shared"] });
  eq("a duplicated key belongs to the last topic that claims it", map.shared, "Second");
  eq("an unclaimed key is uncategorized", classifyOpsKey("nope", map), null);
}

// ------------------------------------------------- topic grouping + priority

{
  const keyToTopic = buildKeyToTopicMap({
    Alpha: ["a-high", "a-low", "a-mid"],
    Beta: ["b-one"],
  });
  const { opsByTopic, uncategorized } = groupOpsByTopic([
    entry("a-low", "L", { priority: 0 }),
    entry("stray-2", "S2"),
    entry("a-high", "H", { priority: "5" }),   // string priority, from Turso
    entry("b-one", "B"),
    entry("a-mid", "M", { priority: 2 }),
    entry("stray-1", "S1", { priority: 9 }),
  ], keyToTopic);

  eq("entries land in their declared topic",
     Object.keys(opsByTopic).sort(), ["Alpha", "Beta"]);
  eq("within a topic, priority sorts DESCENDING (string priorities coerced)",
     opsByTopic.Alpha.map((o) => o.key), ["a-high", "a-mid", "a-low"]);
  eq("uncategorized entries sort by the same key",
     uncategorized.map((o) => o.key), ["stray-1", "stray-2"]);

  // Equal priority falls back to key ASCENDING — the tiebreak is why the sort
  // is deterministic across processes at all.
  const tied = groupOpsByTopic([
    entry("a-mid", "M", { priority: 3 }),
    entry("a-high", "H", { priority: 3 }),
    entry("a-low", "L", { priority: 3 }),
  ], keyToTopic);
  eq("equal priorities break ties alphabetically",
     tied.opsByTopic.Alpha.map((o) => o.key), ["a-high", "a-low", "a-mid"]);

  // None -> 0 and unparseable -> 0, so both sink below any positive priority.
  const coerced = groupOpsByTopic([
    entry("a-low", "L", { priority: null }),
    entry("a-mid", "M", { priority: "junk" }),
    entry("a-high", "H", { priority: 1 }),
  ], keyToTopic);
  eq("null and unparseable priorities both coerce to 0",
     coerced.opsByTopic.Alpha.map((o) => o.key), ["a-high", "a-low", "a-mid"]);
}

eq("an entry renders as a markdown heading plus its raw value",
   formatEntry(entry("identity", "Muninn is a memory")), "### identity\nMuninn is a memory");
eq("a NULL value renders as Python's None, not JS null",
   formatEntry({ key: "k", value: null }), "### k\nNone");

// ----------------------------------------------------------- relative age
// A different function from tools.ts::relativeAge, with a different vocabulary
// and calendar-day (America/New_York) boundaries rather than elapsed hours.

eq("under a minute is 'just now'", formatRelativeAge("2026-07-29T15:59:30Z", NOW), "just now");
eq("minutes are pluralized", formatRelativeAge("2026-07-29T15:30:00Z", NOW), "30 minutes ago");
eq("one minute is singular", formatRelativeAge("2026-07-29T15:58:30Z", NOW), "1 minute ago");
eq("same calendar day reports hours", formatRelativeAge("2026-07-29T06:00:00Z", NOW), "10 hours ago");
eq("the previous calendar day is 'yesterday'", formatRelativeAge("2026-07-28T20:00:00Z", NOW), "yesterday");
eq("under a week counts days", formatRelativeAge("2026-07-26T16:00:00Z", NOW), "3 days ago");
eq("7-13 days collapses to 'last week'", formatRelativeAge("2026-07-20T16:00:00Z", NOW), "last week");
eq("14-29 days counts whole weeks", formatRelativeAge("2026-07-08T16:00:00Z", NOW), "3 weeks ago");
eq("30-59 days is 'last month'", formatRelativeAge("2026-06-20T16:00:00Z", NOW), "last month");
eq("months are floored at 2 by max(2, round(...))",
   formatRelativeAge("2026-05-20T16:00:00Z", NOW), "2 months ago");
eq("a year and change is 'about a year ago'",
   formatRelativeAge("2025-06-01T16:00:00Z", NOW), "about a year ago");
eq("beyond two years counts years", formatRelativeAge("2023-01-01T16:00:00Z", NOW), "4 years ago");
eq("a future timestamp says so", formatRelativeAge("2027-01-01T00:00:00Z", NOW), "in the future");
eq("unparseable input yields null so the caller omits the line",
   formatRelativeAge("not-a-date", NOW), null);
eq("a non-string yields null", formatRelativeAge(12345, NOW), null);
// Naive timestamps are UTC to Python (blue replaces tzinfo); Date.parse would
// call them local time, which is a silent 4-hour error off-Cloudflare.
eq("a naive timestamp is read as UTC, not as local time",
   formatRelativeAge("2026-07-29T15:30:00", NOW), "30 minutes ago");

// ------------------------------------------------------------- time anchor

eq("the anchor renders local time, abbreviation, offset and DST",
   formatTimeAnchor("America/New_York", NOW),
   "⏰ 2026-07-29 12:00 EDT (UTC-04:00) | DST: active");
eq("winter reports standard time and DST inactive",
   formatTimeAnchor("America/New_York", new Date("2026-01-15T17:00:00Z")),
   "⏰ 2026-01-15 12:00 EST (UTC-05:00) | DST: inactive");
eq("a missing timezone entry falls back to UTC",
   formatTimeAnchor(null, NOW), "⏰ 2026-07-29 16:00 UTC (UTC+00:00) | DST: inactive");
eq("an unparseable zone falls back to UTC and drops its own name",
   formatTimeAnchor("Mars/Olympus_Mons", NOW),
   "⏰ 2026-07-29 16:00 UTC (UTC+00:00) | DST: inactive");
// The live `timezone` entry carries instructional prose after the IANA name.
eq("only the first non-empty line of the timezone entry is the zone",
   formatTimeAnchor("\n  America/New_York  \n\nDATE GROUNDING: always cat /tmp/LOCAL_DATE", NOW),
   "⏰ 2026-07-29 12:00 EDT (UTC-04:00) | DST: active");
eq("midnight renders as 00, not 24", formatTimeAnchor("UTC", new Date("2026-07-29T00:00:00Z")),
   "⏰ 2026-07-29 00:00 UTC (UTC+00:00) | DST: inactive");

// The one measured blue/green delta, pinned so it cannot widen unnoticed and
// cannot be "fixed" by switching locale. Intl's short zone name is locale data:
// en-US is the ONLY locale that renders EST/EDT, and the live `timezone` entry
// is America/New_York, so a zone whose abbreviation en-US does not carry renders
// numerically where blue's strftime('%Z') reads the tz database.
eq("the offset and DST stay exact for a zone en-US has no abbreviation for",
   formatTimeAnchor("Europe/Oslo", NOW).endsWith("(UTC+02:00) | DST: active"), true);
eq("US zones — the ones the live config uses — keep blue's abbreviation",
   formatTimeAnchor("America/Los_Angeles", NOW),
   "⏰ 2026-07-29 09:00 PDT (UTC-07:00) | DST: active");

// ------------------------------------------------------- section presence

eq("an empty payload is the anchor and the (unconditional) capabilities heading",
   formatBootOutput(bare(), NOW),
   "⏰ ANCHOR\n\n# CAPABILITIES — reach for these before hand-rolling");

// Every optional section is absent-by-default, so each of these adds exactly
// one block. The bare case above is what "an empty/absent section" looks like.
eq("no profile means no PROFILE heading",
   formatBootOutput(bare(), NOW).includes("# PROFILE"), false);
eq("no ops means no OPS heading",
   formatBootOutput(bare(), NOW).includes("# OPS"), false);
eq("an empty constellation string is omitted, not rendered blank",
   formatBootOutput(bare({ constellation: "" }), NOW).includes("# CONSTELLATION"), false);
eq("reference entries only appear alongside a rendered OPS block",
   formatBootOutput(bare({ referenceOps: [entry("container-limits", "…")] }), NOW)
     .includes("Reference Entries"), false);

// utilitiesBlock is null-vs-empty, and the distinction is the omission mechanism:
// blue ALWAYS appends something here, so `null` is green saying "I did not look".
eq("a supplied utilities block is appended verbatim (blue's empty-dict text)",
   formatBootOutput(bare({
     utilitiesBlock: "\n## Utilities\n  None installed (tag memories with 'utility-code' to add)",
   }), NOW),
   "⏰ ANCHOR\n\n# CAPABILITIES — reach for these before hand-rolling" +
   "\n\n## Utilities\n  None installed (tag memories with 'utility-code' to add)");
eq("a null utilities block omits the section entirely",
   formatBootOutput(bare({ utilitiesBlock: null }), NOW).includes("## Utilities"), false);

// ------------------------------------------------------------ section order
// The whole point of the port. Every section populated, asserted as one string.

{
  const keyToTopic = buildKeyToTopicMap({
    "Core Boot & Behavior": ["boot-behavior"],
    "Memory Discipline": ["remembering-api", "memory-types"],
  });
  const { opsByTopic, uncategorized } = groupOpsByTopic([
    entry("memory-types", "types", { priority: 1 }),
    entry("remembering-api", "api", { priority: 9 }),
    entry("boot-behavior", "behave"),
    entry("mystery-key", "?"),
  ], keyToTopic);

  const full = formatBootOutput(bare({
    timeAnchor: "⏰ 2026-07-29 12:00 EDT (UTC-04:00) | DST: active",
    lastSessionGap: "⏳ Last session activity: yesterday",
    profile: [entry("identity", "corvid"), entry("timezone", "America/New_York")],
    opsByTopic,
    topicOrder: ["Core Boot & Behavior", "Memory Discipline", "Absent Topic"],
    uncategorized,
    referenceOps: [entry("zzz-late", "z"), entry("container-limits", "c")],
    taskRouting: "\n## Task Routing (task shape → reach for)\n  - x → y",
    utilitiesBlock: "\n## Utilities (1 · `from muninn_utils import <name>`)\n  - a → b",
    githubAccess: { available: true, methods: ["gh CLI", "token"], recommended: "gh CLI",
                    gh_cli: { authenticated: true, user: "oaustegard" } },
    constellation: "remex, claude-skills (2 spokes)",
    pendingTasks: [{ name: "port-boot", task_type: "port", pending: ["test", "diff"],
                     created: NOW.getTime() / 1000 - 3 * 3600 }],
    recentFlights: [{ number: 42, title: "A flight", createdAt: "2026-07-28T10:00:00Z", closed: false }],
    dueReminders: [{ id: "abcdef0123456789", text: "water the plants", status: "overdue", recur_days: 7 }],
  }), NOW);

  eq("every section renders, in blue's order, with blue's spacing", full, [
    "⏰ 2026-07-29 12:00 EDT (UTC-04:00) | DST: active",
    "⏳ Last session activity: yesterday",
    "# PROFILE",
    "### identity",
    "corvid",
    "### timezone",
    "America/New_York",
    "",
    "# OPS",
    "",
    "## Core Boot & Behavior",
    "### boot-behavior",
    "behave",
    "",
    "## Memory Discipline",
    "### remembering-api",
    "api",
    "### memory-types",
    "types",
    "",
    "## Other (1 uncategorized — add to ops-topics: mystery-key)",
    "### mystery-key",
    "?",
    "",
    "## Reference Entries (load via config_get)",
    "container-limits, zzz-late",
    "",
    "# CAPABILITIES — reach for these before hand-rolling",
    "",
    "## Task Routing (task shape → reach for)",
    "  - x → y",
    "",
    "## Utilities (1 · `from muninn_utils import <name>`)",
    "  - a → b",
    "",
    "## GitHub Access",
    "  Status: Available",
    "  Methods: gh CLI, token",
    "  Recommended: gh CLI",
    "  gh user: oaustegard",
    "  Usage: gh pr view, gh issue list, gh api repos/...",
    "",
    "# CONSTELLATION",
    "  remex, claude-skills (2 spokes)",
    "  Use spokes_status() for live state, spokes_discover() to find new repos",
    "",
    "# INCOMPLETE TASKS (1)",
    "⚠️  Resume these before starting new work:",
    "  ○ port-boot [port] (3h ago)",
    "    Pending: test, diff",
    "    Resume: t = task_resume('port-boot')",
    "",
    "# RECENT FLIGHTS",
    "- #42 (2026-07-28, OPEN): A flight",
    "",
    "🔔 REMINDERS:",
    "  - ⚠️ [overdue] water the plants (every 7d) (id: abcdef01)",
  ].join("\n"));

  // A topic named in topicOrder but carrying no entries prints no heading, and
  // topicOrder — not the grouping — decides which heading comes first.
  eq("a topic with no entries prints no heading", full.includes("Absent Topic"), false);
  eq("topic headings follow topicOrder, not insertion or alphabetical order",
     full.indexOf("## Core Boot & Behavior") < full.indexOf("## Memory Discipline"), true);
}

// ---------------------------------------------------------- section details

eq("an unauthenticated GitHub section states the fallback instruction",
   formatBootOutput(bare({ githubAccess: { available: false } }), NOW).split("\n").slice(-2),
   ["  Status: Not configured", "  Note: Set GITHUB_TOKEN or authenticate gh CLI"]);
eq("an available-but-unauthenticated gh CLI drops the user and usage lines",
   formatBootOutput(bare({
     githubAccess: { available: true, methods: ["token"], recommended: "token",
                     gh_cli: { authenticated: false, user: "x" } },
   }), NOW).includes("gh user:"), false);

eq("a task older than 48h switches to days",
   formatBootOutput(bare({
     pendingTasks: [{ name: "old", pending: ["a"], created: NOW.getTime() / 1000 - 100 * 3600 }],
   }), NOW).split("\n").find((l) => l.startsWith("  ○ ")), "  ○ old (4d ago)");
eq("a task with no type omits the bracket tag",
   formatBootOutput(bare({ pendingTasks: [{ name: "n", pending: ["a"], created: NOW.getTime() / 1000 }] }), NOW)
     .includes("[undefined]"), false);

eq("a closed flight with no title uses blue's defaults",
   formatBootOutput(bare({ recentFlights: [{ closed: true }] }), NOW).split("\n").at(-1),
   "- #? (, CLOSED): Untitled");

eq("a non-overdue reminder uses the calendar icon and no recur suffix",
   formatBootOutput(bare({ dueReminders: [{ id: "0123456789", text: "t", status: "due" }] }), NOW)
     .split("\n").at(-1),
   "  - 📅 [due] t (id: 01234567)");

// ------------------------------------------------------------- the omissions
// The whole reason green is allowed to drop sections: it says which, and why.

eq("no omissions means no trailing block — this is the blue-equal case",
   formatBootOutput(bare({ omissions: [] }), NOW).includes("OMITTED"), false);
eq("omissions render as a named, reasoned trailing block",
   formatBootOutput(bare({ omissions: [{ section: "S", reason: "R" }] }), NOW).split("\n").slice(-3),
   ["# OMITTED FROM THIS PAYLOAD (1)",
    "  Sections blue renders that a read-only Worker cannot reach:",
    "  - S — R"]);
eq("green's omission list still names all five sections it cannot serve",
   GREEN_OMISSIONS.map((o) => o.section),
   ["Task Routing", "Utilities", "GitHub Access", "Recent Flights", "Reminder un-snooze"]);

// ------------------------------------------------------------ reminder parsing

eq("META is parsed off its own line", parseReminderMeta('REMIND: x\nMETA: {"kind":"nag"}'),
   { kind: "nag" });
eq("malformed META degrades to an empty dict", parseReminderMeta("META: {not json"), {});
eq("no META line is an empty dict", parseReminderMeta("REMIND: x"), {});
eq("the summary is cleaned of prefixes and bookkeeping lines",
   cleanReminderSummary('REMIND: water the plants\nMETA: {"kind":"nag"}\nDONE: 2026-01-01'),
   "water the plants");

// --------------------------------------------------------------- gathering
// Injected Turso, dispatching on SQL — the same shape tools.test.ts uses.

const dep = (handler: (sql: string, args: unknown[]) => Record<string, unknown>[]): BootDeps => ({
  db: () => ({
    execute: async ({ sql, args }: { sql: string; args: unknown[] }) =>
      ({ rows: handler(sql, args ?? []) }),
  }) as never,
  now: () => NOW,
});

const cfg = (key: string, value: unknown, over: Record<string, unknown> = {}) =>
  ({ key, value, category: "ops", boot_load: 1, priority: 0, ...over });

{
  const client = dep((sql) => {
    if (sql === "SELECT value FROM config WHERE category = 'task-state'") {
      return [
        { value: JSON.stringify({ name: "done-task", steps: { a: true, b: true } }) },
        { value: JSON.stringify({ name: "live", task_type: "port", created: 17, steps: { a: true, b: false, c: false } }) },
        { value: "{not json" },
      ];
    }
    return [];
  }).db(CFG as never);

  const tasks = await loadIncompleteTasks(client);
  eq("a fully-completed task is dropped and a malformed row is skipped",
     tasks.map((t) => t.name), ["live"]);
  eq("only incomplete steps are reported, in declaration order",
     tasks[0].pending, ["b", "c"]);
}

{
  const registry = (value: unknown) => dep(() => [{ value }]).db(CFG as never);
  eq("the constellation is a one-line roster of spoke basenames",
     await spokesSummary(registry(JSON.stringify({ spokes: [{ repo: "o/remex" }, { repo: "o/claude-skills" }] }))),
     "remex, claude-skills (2 spokes)");
  eq("an empty registry yields blue's empty-string sentinel",
     await spokesSummary(registry(JSON.stringify({ spokes: [] }))), "");
  eq("a malformed registry yields the empty sentinel, not a crash",
     await spokesSummary(registry("{not json")), "");
  eq("a spoke with no repo removes the whole section (blue's KeyError)",
     await spokesSummary(registry(JSON.stringify({ spokes: [{ name: "x" }] }))), null);
}

{
  // remind_due's status ladder, driven entirely off valid_from vs now.
  const client = dep((sql) => {
    if (sql.includes('remind-active') && sql.includes("valid_from <= ?")) {
      return [
        { id: "aaaaaaaa-1", summary: 'REMIND: overdue thing\nMETA: {"kind":"nag","recur_days":3}',
          valid_from: "2026-07-01T00:00:00Z", tags: '["remind-active"]' },
        { id: "bbbbbbbb-2", summary: "REMIND: due today",
          valid_from: "2026-07-29T15:00:00Z", tags: '["remind-active"]' },
        { id: "cccccccc-3", summary: "REMIND: soon",
          valid_from: "2026-07-30T16:00:00Z", tags: '["remind-active"]' },
      ];
    }
    return [];
  }).db(CFG as never);

  const due = await remindDue(client, NOW);
  eq("statuses ladder overdue / due / upcoming(Nd)",
     due.map((r) => r.status), ["overdue", "due", "upcoming (1d)"]);
  eq("the reminder text is the cleaned summary", due[0].text, "overdue thing");
  eq("recur_days rides through from META", due[0].recur_days, 3);
  eq("a missing kind defaults to nag", due[1].kind, "nag");
}

{
  // The full composer. Everything green can reach, nothing it cannot.
  const seen: string[] = [];
  const deps = dep((sql, args) => {
    seen.push(sql);
    if (sql === PROFILE_SQL) return [cfg("identity", "corvid", { category: "profile" })];
    if (sql === OPS_SQL) {
      return [
        cfg("boot-behavior", "behave", { priority: 1 }),
        cfg("container-limits", "reference only", { boot_load: 0 }),
        cfg("remembering-api", "api", { priority: 5 }),
      ];
    }
    if (sql === LAST_SESSION_SQL) return [{ created_at: "2026-07-28T20:00:00Z" }];
    if (sql.startsWith("SELECT value FROM config WHERE key")) {
      if (args[0] === "timezone") return [{ value: "America/New_York" }];
      return [];
    }
    return [];
  });

  const text = await composeBoot(CFG, deps);
  const lines = text.split("\n");

  eq("the composer leads with the time anchor",
     lines[0], "⏰ 2026-07-29 12:00 EDT (UTC-04:00) | DST: active");
  eq("the last-session gap uses blue's relative vocabulary",
     lines[1], "⏳ Last session activity: yesterday");
  eq("profile rows render unfiltered by boot_load", text.includes("### identity\ncorvid"), true);
  eq("boot_load=0 ops are indexed, not loaded",
     text.includes("### container-limits"), false);
  eq("boot_load=0 ops appear in the reference index",
     text.includes("## Reference Entries (load via config_get)\ncontainer-limits"), true);
  eq("ops land under their default topics",
     [text.indexOf("## Core Boot & Behavior"), text.indexOf("## Memory Discipline")]
       .every((i) => i > 0), true);
  eq("the composer queries the config table with blue's exact SQL",
     seen.includes(PROFILE_SQL) && seen.includes(OPS_SQL), true);
  eq("the composer declares its omissions rather than dropping them silently",
     text.includes("# OMITTED FROM THIS PAYLOAD (5)"), true);
  eq("the three unreachable sections are named",
     ["Task Routing", "Utilities", "GitHub Access"].every((s) => text.includes(`  - ${s} — `)), true);
  eq("no faked utilities roster sneaks in", text.includes("None installed"), false);
}

{
  // Every optional read is independently fatal-proof; only profile/ops are not.
  const flaky = dep((sql) => {
    if (sql === PROFILE_SQL) return [cfg("identity", "corvid", { category: "profile" })];
    if (sql === OPS_SQL) return [];
    throw new Error("Turso is having a day");
  });
  const text = await composeBoot(CFG, flaky);
  eq("an optional-section failure degrades to omission, not to an error",
     text.includes("### identity"), true);
  eq("a failed timezone read still yields a UTC anchor",
     text.split("\n")[0], "⏰ 2026-07-29 16:00 UTC (UTC+00:00) | DST: inactive");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
