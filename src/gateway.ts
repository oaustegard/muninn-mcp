/**
 * `gateway` — one tool, two ops, wrapping Cloudflare AI Gateway calls to Google
 * Gemini so CF_ACCOUNT_ID / CF_GATEWAY_ID / CF_API_TOKEN never enter a container.
 *
 * Today the skills that need Gemini (semantic-grep, invoking-gemini) read
 * `proxy.env` from the project and call the gateway themselves — which means the
 * gateway token is on disk in every container that runs them. Moving the call
 * behind the Worker keeps the secret in `wrangler secret` and lets a container
 * ask for embeddings or a completion the same way it asks for a memory.
 *
 * The request shapes are transcribed, not designed. Every URL, header and body
 * key below is quoted from the Python that already works against this gateway:
 *
 *   semantic-grep/scripts/semantic_grep.py:37     _CF_GATEWAY_BASE
 *   semantic-grep/scripts/semantic_grep.py:83-96  _embed_url (URL + cf-aig header)
 *   semantic-grep/scripts/semantic_grep.py:163-220 embed_batch (batch body, group_size)
 *   invoking-gemini/scripts/gemini_client.py:243-332 _cf_request (generateContent)
 *   invoking-gemini/scripts/gemini_client.py:617-630 generationConfig keys
 *   invoking-gemini/scripts/gemini_client.py:862-878 structured output keys
 *
 * Same "one implementation, two doors" shape as tools.ts: `gateway()` is the
 * transport-agnostic body, `server.ts` registers it, and `fetch`/`sleep` are
 * injected so the whole thing is testable with no network.
 */

import * as z from "zod/v4";

// ---------------------------------------------------------------- config & deps

export interface GatewayConfig {
  CF_ACCOUNT_ID: string;
  CF_GATEWAY_ID: string;
  CF_API_TOKEN: string;
}

/** Injectable I/O so both ops are testable without a live gateway. */
export interface GatewayDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export const defaultGatewayDeps: GatewayDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// ---------------------------------------------------------------- constants

/** semantic_grep.py:37 — `_CF_GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1"` */
const CF_GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1";

/**
 * semantic_grep.py:39 — `_DEFAULT_MODEL = "gemini-embedding-2"`. GA 2026-04-22,
 * general-purpose and multimodal, MRL truncation supported; supersedes the
 * text-only gemini-embedding-001 (retired 2026-07-21, semantic_grep.py:41-47).
 */
export const DEFAULT_EMBED_MODEL = "gemini-embedding-2";

/**
 * gemini_client.py:112 — `DEFAULT_MODEL = "gemini-3.8-flash"`. Current frontier
 * Flash (GA 2026-09-02); the `pro` alias was repointed here 2026-09-03 because
 * the Pro tier is off routing (gemini_client.py:100-103).
 */
export const DEFAULT_GENERATE_MODEL = "gemini-3.8-flash";

/**
 * gemini_client.py:94-110 — `MODEL_ALIASES`. Transcribed so a caller who learned
 * `model: "lite"` from the skill gets the same resolution here. Image aliases
 * are omitted: this tool returns text, not bytes.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  flash: "gemini-3.8-flash",
  "flash-3.7": "gemini-3.7-flash",
  "flash-3.6": "gemini-3.6-flash",
  "flash-3.5": "gemini-3.5-flash",
  "flash-3": "gemini-3-flash-preview",
  pro: "gemini-3.8-flash",
  lite: "gemini-3.5-flash-lite",
  "stable-flash": "gemini-2.5-flash",
  "stable-pro": "gemini-2.5-pro",
};

/**
 * gemini_client.py:117 — Flash 3.7 and 3.8 reject `thinking_level='minimal'`
 * with HTTP 400; the client downgrades to `low` (gemini_client.py:606-611).
 */
const MINIMAL_THINKING_UNSUPPORTED = new Set(["gemini-3.7-flash", "gemini-3.8-flash"]);

/** semantic_grep.py:166 — `group_size: int = 100`; one HTTP call per group. */
export const EMBED_GROUP_SIZE = 100;
/** Hard cap on `texts` per call. One group, one request, bounded response size. */
export const EMBED_MAX_TEXTS = 100;

/** gemini_client.py:292-293 — `max_retries = 3`, `base_delay = 0.5` (seconds). */
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
/** Cap a Retry-After we honour, so a hostile header cannot pin a Worker. */
const MAX_RETRY_AFTER_MS = 30_000;

// ---------------------------------------------------------------- schema

const TASK_TYPES = [
  // semantic_grep.py:108-112 — `TaskType` literal.
  "RETRIEVAL_QUERY", "RETRIEVAL_DOCUMENT", "SEMANTIC_SIMILARITY",
  "CLASSIFICATION", "CLUSTERING", "QUESTION_ANSWERING", "FACT_VERIFICATION",
  "CODE_RETRIEVAL_QUERY",
] as const;

export const gatewayInputSchema = z.object({
  op: z.enum(["embed", "generate"]).describe("'embed' for vectors, 'generate' for a completion."),
  // --- embed ---
  texts: z.array(z.string()).optional()
    .describe("embed: strings to embed, max 100 per call."),
  task_type: z.enum(TASK_TYPES).optional()
    .describe("embed: Gemini task type (default RETRIEVAL_DOCUMENT; use RETRIEVAL_QUERY for the query side)."),
  dim: z.number().int().positive().optional()
    .describe("embed: output dimensionality, MRL-truncated (default 256, max 3072)."),
  // --- generate ---
  prompt: z.string().optional().describe("generate: the user turn."),
  system: z.string().optional().describe("generate: optional system instruction."),
  json_schema: z.record(z.string(), z.unknown()).optional()
    .describe("generate: Gemini responseSchema (no $ref/$defs); the reply is parsed JSON."),
  temperature: z.number().min(0).max(2).optional().describe("generate: sampling temperature (default 0.7)."),
  max_tokens: z.number().int().positive().optional()
    .describe("generate: maxOutputTokens. Thinking tokens count against it — size generously."),
  thinking_budget: z.number().int().min(0).optional()
    .describe("generate: reasoning budget. 0 = minimal, <=1024 low, <=8192 medium, else high on Gemini 3.x; raw thinkingBudget on 2.5."),
  // --- both ---
  model: z.string().optional()
    .describe("Model id or alias (embed default gemini-embedding-2; generate default gemini-3.8-flash, aliases flash/lite/pro)."),
});

export type GatewayArgs = z.infer<typeof gatewayInputSchema>;

export const GATEWAY_TOOL_DESCRIPTION =
  "Call Google Gemini through Muninn's Cloudflare AI Gateway without holding the gateway credentials: " +
  "op 'embed' turns up to 100 texts into vectors (gemini-embedding-2, default 256 dims, task_type " +
  "RETRIEVAL_DOCUMENT or RETRIEVAL_QUERY) and returns compact JSON {model, dim, vectors}; op 'generate' " +
  "sends a prompt (plus optional system instruction, json_schema for structured output, temperature, " +
  "max_tokens, thinking_budget) to gemini-3.8-flash or a named model and returns the text, or parsed " +
  "JSON when a schema was given, followed by a one-line token usage note.";

// ---------------------------------------------------------------- errors

/**
 * A 4xx (other than 429) from Gemini. Deterministic — retrying only hides the
 * body, which is the one useful diagnostic (gemini_client.py:303-310, 366-368).
 */
class NonRetriableError extends Error {}

/** Retriable failure; `retryAfterMs` is set when the gateway said how long to wait. */
class RetriableError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a Retry-After header: delta-seconds or an HTTP date. Undefined if absent/junk. */
function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

// ---------------------------------------------------------------- transport

/**
 * Retry loop local to this file, extending turso.ts `withRetry` (turso.ts:111-146)
 * in one respect: a 429 carries `Retry-After`, and honouring it beats blind
 * exponential backoff — the gateway is telling us when the bucket refills.
 * Otherwise the budget matches gemini_client.py:292-332: 3 attempts, 500 ms base,
 * doubling, and the last attempt re-throws before the retriable check.
 *
 * No jitter: the caller here is one Worker isolate per tool call, not a fleet
 * cold-starting together, and a recorded delay sequence is what the tests pin.
 */
async function withGatewayRetry<T>(fn: () => Promise<T>, sleep: GatewayDeps["sleep"]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS - 1) throw err;
      if (err instanceof NonRetriableError) throw err;
      const backoff = BASE_DELAY_MS * 2 ** attempt;
      const hinted = err instanceof RetriableError ? err.retryAfterMs : undefined;
      const delay = hinted === undefined ? backoff : Math.min(Math.max(hinted, backoff), MAX_RETRY_AFTER_MS);
      await sleep(delay);
    }
  }
}

/**
 * semantic_grep.py:91-94 / gemini_client.py:268-271:
 *   `{_CF_GATEWAY_BASE}/{account_id}/{gateway_id}/google-ai-studio/v1beta/models/{model}:{endpoint}`
 *
 * No `?key=` query param (gemini_client.py:273-276): that is the non-BYOK
 * fallback, and this gateway is BYOK — the Google key lives in Cloudflare.
 */
function gatewayUrl(config: GatewayConfig, model: string, endpoint: string): string {
  return `${CF_GATEWAY_BASE}/${config.CF_ACCOUNT_ID}/${config.CF_GATEWAY_ID}` +
    `/google-ai-studio/v1beta/models/${model}:${endpoint}`;
}

/**
 * One POST, classified. The token goes into the request and nowhere else: the
 * error strings built here quote the response body, never the request — that
 * is the property the leak tests pin.
 *
 * Headers per semantic_grep.py:95,120 and gemini_client.py:282-285:
 *   `Content-Type: application/json`, `cf-aig-authorization: Bearer <CF_API_TOKEN>`.
 */
async function post(
  config: GatewayConfig,
  url: string,
  body: unknown,
  deps: GatewayDeps,
  label: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${config.CF_API_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-layer failure. Never interpolate `err` verbatim — undici quotes
    // the request on some paths, and the request carries the token.
    const msg = err instanceof Error ? err.message : String(err);
    throw new RetriableError(`${label}: network error: ${msg.slice(0, 200)}`);
  }

  if (res.status === 429) {
    const preview = (await safeText(res)).slice(0, 200);
    throw new RetriableError(
      `${label}: HTTP 429 from CF AI Gateway (rate limited): ${preview}`,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  if (res.status >= 500) {
    // gemini_client.py:297-302 — "likely egress proxy, not Gemini".
    const preview = (await safeText(res)).slice(0, 200);
    throw new RetriableError(`${label}: HTTP ${res.status} from CF AI Gateway: ${preview}`);
  }
  if (res.status >= 400) {
    // gemini_client.py:303-310 — keep the body; it names the rejected keyword.
    const preview = (await safeText(res)).slice(0, 600);
    throw new NonRetriableError(`${label}: HTTP ${res.status} from Gemini: ${preview}`);
  }

  const text = await safeText(res);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON 2xx is the egress proxy's 'DNS cache overflow' shape
    // (gemini_client.py:287-291, 321) — transient, so retriable.
    throw new RetriableError(`${label}: non-JSON response from gateway: ${text.slice(0, 200)}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- embed

interface EmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
}

/**
 * semantic_grep.py:163-220 `embed_batch`, minus the numpy: one
 * `:batchEmbedContents` call per group of 100, body
 * `{requests: [{model: "models/<m>", content: {parts: [{text}]}, taskType, outputDimensionality}]}`.
 *
 * The Python L2-normalises rows when dim < 3072 (semantic_grep.py:204-207)
 * because MRL-truncated vectors are not unit length. Done here too, so a caller
 * can dot-product the result directly and a query embedded via this tool is
 * comparable to a document embedded by the skill.
 */
async function embed(config: GatewayConfig, args: GatewayArgs, deps: GatewayDeps): Promise<string> {
  const texts = args.texts;
  if (!texts || texts.length === 0) throw new Error("embed: 'texts' must be a non-empty array of strings.");
  if (texts.length > EMBED_MAX_TEXTS) {
    throw new Error(`embed: too many texts (${texts.length}); the cap is ${EMBED_MAX_TEXTS} per call. Split the batch.`);
  }
  const model = args.model ?? DEFAULT_EMBED_MODEL;
  const taskType = args.task_type ?? "RETRIEVAL_DOCUMENT";
  const dim = args.dim ?? 256;
  if (dim > 3072) throw new Error(`embed: dim ${dim} exceeds the model maximum of 3072.`);

  const url = gatewayUrl(config, model, "batchEmbedContents");
  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += EMBED_GROUP_SIZE) {
    const group = texts.slice(start, start + EMBED_GROUP_SIZE);
    const body = {
      requests: group.map((t) => ({
        model: `models/${model}`,
        content: { parts: [{ text: t }] },
        taskType,
        outputDimensionality: dim,
      })),
    };
    const data = await withGatewayRetry(
      () => post(config, url, body, deps, "embed"),
      deps.sleep,
    ) as EmbedResponse;
    const embs = data.embeddings ?? [];
    if (embs.length !== group.length) {
      // semantic_grep.py:198-201
      throw new Error(`embed: batch size mismatch: sent ${group.length}, got ${embs.length}`);
    }
    for (const e of embs) {
      const vals = e.values ?? [];
      if (vals.length !== dim) {
        throw new Error(`embed: gateway returned ${vals.length} dims, expected ${dim}`);
      }
      vectors.push(dim < 3072 ? normalize(vals) : vals);
    }
  }

  return JSON.stringify({ model, dim, vectors });
}

/** L2-normalise; a zero vector stays zero (semantic_grep.py:205-207 `if n > 0`). */
export function normalize(v: number[]): number[] {
  let sq = 0;
  for (const x of v) sq += x * x;
  const n = Math.sqrt(sq);
  return n > 0 ? v.map((x) => x / n) : v;
}

// ---------------------------------------------------------------- generate

interface GenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

/**
 * The skill's `thinking_level` is a string enum on Gemini 3.x; this tool's
 * public knob is an integer budget, which maps onto it in bands. On 2.5 the
 * integer goes through untouched as `thinkingBudget` (invoking-gemini
 * references/models.md:396-407 — "Old: integer thinking_budget; New: string
 * enum thinking_level").
 */
export function thinkingConfigFor(model: string, budget: number | undefined): Record<string, unknown> | undefined {
  if (budget === undefined) return undefined;
  if (!model.startsWith("gemini-3")) return { thinkingBudget: budget };
  let level: string;
  if (budget === 0) level = MINIMAL_THINKING_UNSUPPORTED.has(model) ? "low" : "minimal";
  else if (budget <= 1024) level = "low";
  else if (budget <= 8192) level = "medium";
  else level = "high";
  return { thinkingLevel: level };
}

/** gemini_client.py:540 — `MODEL_ALIASES.get(model, model)`. */
export function resolveModel(model: string | undefined): string {
  if (!model) return DEFAULT_GENERATE_MODEL;
  return MODEL_ALIASES[model] ?? model;
}

/**
 * gemini_client.py:243-332 `_cf_request` + 617-630 (config keys) + 862-878
 * (structured output). Body:
 *   `{contents: [{parts: [{text}]}], generationConfig: {...}, systemInstruction?}`
 *
 * `systemInstruction` is not in the skill (it has no system-prompt knob); the
 * key and shape are the Gemini REST API's own, `{parts: [{text}]}`.
 */
async function generate(config: GatewayConfig, args: GatewayArgs, deps: GatewayDeps): Promise<string> {
  if (!args.prompt || args.prompt.length === 0) throw new Error("generate: 'prompt' is required.");
  const model = resolveModel(args.model);

  const generationConfig: Record<string, unknown> = { temperature: args.temperature ?? 0.7 };
  if (args.max_tokens !== undefined) generationConfig.maxOutputTokens = args.max_tokens;
  const thinking = thinkingConfigFor(model, args.thinking_budget);
  if (thinking) generationConfig.thinkingConfig = thinking;
  if (args.json_schema) {
    // gemini_client.py:864-865
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = args.json_schema;
  }

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: args.prompt }] }],
    generationConfig,
  };
  if (args.system) body.systemInstruction = { parts: [{ text: args.system }] };

  const url = gatewayUrl(config, model, "generateContent");
  const data = await withGatewayRetry(
    () => post(config, url, body, deps, "generate"),
    deps.sleep,
  ) as GenerateResponse;

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const finish = candidate?.finishReason;

  if (args.json_schema && (finish === "MAX_TOKENS" || finish === "MAX_OUTPUT_TOKENS")) {
    // gemini_client.py:343-359 _check_truncation
    throw new Error(
      "generate: Gemini hit maxOutputTokens before finishing the JSON object " +
      "(finishReason=MAX_TOKENS). Raise max_tokens — thinking tokens count against the same budget.",
    );
  }
  if (!text) {
    const why = data.promptFeedback?.blockReason ?? finish ?? "no candidates";
    throw new Error(`generate: empty response from ${model} (${why})`);
  }

  let out = text;
  if (args.json_schema) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`generate: response was not valid JSON despite json_schema: ${text.slice(0, 200)}`);
    }
    out = JSON.stringify(parsed);
  }

  const u = data.usageMetadata;
  if (u) {
    const thought = u.thoughtsTokenCount ? `, thinking ${u.thoughtsTokenCount}` : "";
    out += `\n[usage: ${model} input ${u.promptTokenCount ?? 0}, output ${u.candidatesTokenCount ?? 0}${thought} tokens]`;
  }
  return out;
}

// ---------------------------------------------------------------- dispatch

export async function gateway(
  config: GatewayConfig,
  args: GatewayArgs,
  deps: GatewayDeps = defaultGatewayDeps,
): Promise<string> {
  if (!config.CF_ACCOUNT_ID || !config.CF_GATEWAY_ID || !config.CF_API_TOKEN) {
    throw new Error("gateway is not configured on this Worker (CF_ACCOUNT_ID / CF_GATEWAY_ID / CF_API_TOKEN).");
  }
  switch (args.op) {
    case "embed": return embed(config, args, deps);
    case "generate": return generate(config, args, deps);
    default: throw new Error(`Unknown op: ${String((args as { op: unknown }).op)}`);
  }
}
