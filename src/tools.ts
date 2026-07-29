/**
 * Tool bodies — transport-agnostic, mirroring Sage's `mcp/src/tools.ts`.
 *
 * Schemas and registration live in `server.ts`; this file holds the logic and
 * the formatting. Same "one implementation, two doors" shape Sage proved.
 *
 * SCOPE: read path only, and only `recall`, deliberately. This is Stage 1 of
 * docs/mcp-migration.md — green is built READ-ONLY against a Turso branch, and
 * every write tool stays unwritten until the parity harness is green. Reads are
 * idempotent, so a wrong answer is something you read rather than something you
 * store.
 */

import type { Client } from "@libsql/client/web";
import { db, search, type Config, type MemoryRow, type SearchOpts } from "./turso.ts";

export type { Config };

/** Injectable I/O so dispatch is testable without a live Turso. */
export interface Deps {
  db: (config: Config) => Client;
}

export const defaultDeps: Deps = { db };

/** Relative age, for the same reason boot renders it: narrative time drifts. */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const mins = Math.floor((now.getTime() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Format rows as the text an MCP client sees.
 *
 * The shape is frozen here on purpose. `MemoryResult`'s Python-side aliasing
 * (content->summary, conf->confidence) has no meaning over MCP, so the text
 * shape is decided once and pinned by tests — docs/mcp-migration.md §3 item 3.
 */
export function formatRecall(rows: MemoryRow[], now?: Date): string {
  if (rows.length === 0) return "No memories matched.";
  return rows
    .map((r) => {
      const tags = parseTags(r.tags);
      const head = `- [${String(r.id).slice(0, 8)}] ${r.type}` +
        (tags.length ? ` ${JSON.stringify(tags)}` : "") +
        `  (${relativeAge(r.t, now)})`;
      return `${head}\n    ${String(r.summary).replace(/\n/g, " ")}`;
    })
    .join("\n");
}

export interface RecallArgs {
  query: string;
  n?: number;
  tags?: string[];
  type?: string;
}

/** The one tool green currently serves. */
export async function recall(
  config: Config,
  args: RecallArgs,
  deps: Deps = defaultDeps,
): Promise<string> {
  const client = deps.db(config);
  const opts: SearchOpts = {
    n: Math.min(Math.max(Number(args.n) || 10, 1), 50),
    tags: args.tags,
    type: args.type,
  };
  const rows = await search(client, String(args.query ?? ""), opts);
  return formatRecall(rows);
}
