/** Coverage for the `gateway` tool, with fetch and sleep injected. No network. */
import {
  gateway, gatewayInputSchema, normalize, thinkingConfigFor, resolveModel,
  DEFAULT_EMBED_MODEL, DEFAULT_GENERATE_MODEL, EMBED_MAX_TEXTS,
  type GatewayConfig, type GatewayDeps,
} from "./gateway.ts";
import { errorText } from "./tools.ts";

let pass = 0, fail = 0;
const eq = (n: string, g: unknown, w: unknown) =>
  JSON.stringify(g) === JSON.stringify(w)
    ? (pass++, console.log("OK  " + n))
    : (fail++, console.log(`FAIL ${n}\n  got:  ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`));

// A token that would be unmistakable if it leaked. It is never asserted on
// directly — only ever asserted ABSENT from outputs and error strings.
const TOKEN = "cfaig-SECRET-TOKEN-do-not-leak-9f8e7d";
const config: GatewayConfig = {
  CF_ACCOUNT_ID: "acct123",
  CF_GATEWAY_ID: "muninn-gw",
  CF_API_TOKEN: TOKEN,
};

interface Captured { url: string; headers: Record<string, string>; body: Record<string, any> }

/** Build deps whose fetch replays a scripted list of responses and records requests. */
function fakeDeps(script: Array<() => Response | Error>) {
  const calls: Captured[] = [];
  const delays: number[] = [];
  let i = 0;
  const deps: GatewayDeps = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
      calls.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
      const next = script[Math.min(i++, script.length - 1)]();
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    sleep: async (ms) => { delays.push(ms); },
  };
  return { deps, calls, delays };
}

const json = (obj: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
const textRes = (body: string, status: number, headers: Record<string, string> = {}) => () =>
  new Response(body, { status, headers });

async function thrown(p: Promise<unknown>): Promise<string> {
  try { await p; return "<no error>"; } catch (e) { return errorText(e); }
}

// ---------------------------------------------------------------- schema

eq("schema accepts a minimal embed call",
   gatewayInputSchema.safeParse({ op: "embed", texts: ["a"] }).success, true);
eq("schema rejects an unknown op",
   gatewayInputSchema.safeParse({ op: "chat", prompt: "x" }).success, false);
eq("schema rejects an unknown task_type",
   gatewayInputSchema.safeParse({ op: "embed", texts: ["a"], task_type: "WHATEVER" }).success, false);

// ---------------------------------------------------------------- embed

{
  const vec = (n: number) => Array.from({ length: 4 }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0) * n);
  const { deps, calls } = fakeDeps([json({ embeddings: [{ values: vec(1) }, { values: vec(2) }] })]);
  const out = await gateway(config, { op: "embed", texts: ["alpha", "beta"], dim: 4 }, deps);
  const req = calls[0];

  eq("embed: URL is the gateway's google-ai-studio batchEmbedContents path",
     req.url,
     "https://gateway.ai.cloudflare.com/v1/acct123/muninn-gw/google-ai-studio/v1beta/models/gemini-embedding-2:batchEmbedContents");
  eq("embed: no ?key= query param (BYOK gateway)", req.url.includes("?"), false);
  eq("embed: sends cf-aig-authorization as a Bearer header",
     req.headers["cf-aig-authorization"]?.startsWith("Bearer "), true);
  eq("embed: Content-Type is JSON", req.headers["Content-Type"], "application/json");
  eq("embed: no Authorization header (the gateway header carries auth)",
     "Authorization" in req.headers, false);
  eq("embed: one request entry per text, in order",
     req.body.requests.map((r: any) => r.content.parts[0].text), ["alpha", "beta"]);
  eq("embed: each entry names models/<model>, taskType default, outputDimensionality",
     req.body.requests[0],
     { model: "models/gemini-embedding-2", content: { parts: [{ text: "alpha" }] },
       taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 4 });
  const parsed = JSON.parse(out);
  eq("embed: returns {model, dim, vectors}", Object.keys(parsed), ["model", "dim", "vectors"]);
  eq("embed: model and dim echo the request", [parsed.model, parsed.dim], [DEFAULT_EMBED_MODEL, 4]);
  eq("embed: vectors are L2-normalised when dim < 3072 (3,4,0,0 -> 0.6,0.8,0,0)",
     parsed.vectors, [[0.6, 0.8, 0, 0], [0.6, 0.8, 0, 0]]);
  eq("embed: output is compact (no pretty-print newlines)", out.includes("\n"), false);
  eq("embed: token never appears in the output", out.includes(TOKEN), false);
}

{
  // Defaults and overrides on the request body.
  const { deps, calls } = fakeDeps([json({ embeddings: [{ values: Array(256).fill(1) }] })]);
  await gateway(config, { op: "embed", texts: ["q"] }, deps);
  eq("embed: dim defaults to 256", calls[0].body.requests[0].outputDimensionality, 256);
  const { deps: d2, calls: c2 } = fakeDeps([json({ embeddings: [{ values: [1, 0] }] })]);
  await gateway(config, { op: "embed", texts: ["q"], dim: 2, task_type: "RETRIEVAL_QUERY", model: "gemini-embedding-001" }, d2);
  eq("embed: task_type and model override flow into URL and body",
     [c2[0].body.requests[0].taskType, c2[0].body.requests[0].model, c2[0].url.includes("gemini-embedding-001:batchEmbedContents")],
     ["RETRIEVAL_QUERY", "models/gemini-embedding-001", true]);
}

{
  // Batching: 100 texts is exactly one group, one HTTP call.
  const hundred = Array.from({ length: 100 }, (_, i) => `t${i}`);
  const { deps, calls } = fakeDeps([json({ embeddings: hundred.map(() => ({ values: [1, 1] })) })]);
  const out = JSON.parse(await gateway(config, { op: "embed", texts: hundred, dim: 2 }, deps));
  eq("embed: 100 texts go out as one batch request", [calls.length, calls[0].body.requests.length], [1, 100]);
  eq("embed: 100 vectors come back, in order", out.vectors.length, 100);
}

{
  const tooMany = Array.from({ length: EMBED_MAX_TEXTS + 1 }, () => "x");
  const { deps, calls } = fakeDeps([json({})]);
  const err = await thrown(gateway(config, { op: "embed", texts: tooMany }, deps));
  eq("embed: >100 texts is refused before any request",
     [err.includes("too many texts (101)"), err.includes("cap is 100"), calls.length], [true, true, 0]);
  eq("embed: empty texts is refused", (await thrown(gateway(config, { op: "embed", texts: [] }, deps))).includes("non-empty"), true);
}

{
  const { deps } = fakeDeps([json({ embeddings: [{ values: [1, 2, 3] }] })]);
  const err = await thrown(gateway(config, { op: "embed", texts: ["a"], dim: 2 }, deps));
  eq("embed: dim mismatch from the gateway is an error", err.includes("returned 3 dims, expected 2"), true);
}

{
  const { deps } = fakeDeps([json({ embeddings: [{ values: [1] }] })]);
  const err = await thrown(gateway(config, { op: "embed", texts: ["a", "b"], dim: 1 }, deps));
  eq("embed: batch size mismatch is an error", err.includes("sent 2, got 1"), true);
}

eq("normalize leaves a zero vector alone", normalize([0, 0]), [0, 0]);

// ---------------------------------------------------------------- generate

const gen = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  ...extra,
});

{
  const { deps, calls } = fakeDeps([json(gen("Hello there.", {
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 30, totalTokenCount: 46 },
  }))]);
  const out = await gateway(config, { op: "generate", prompt: "Say hi", system: "Be brief." }, deps);
  const req = calls[0];
  eq("generate: URL is the gateway's generateContent path with the default model",
     req.url,
     `https://gateway.ai.cloudflare.com/v1/acct123/muninn-gw/google-ai-studio/v1beta/models/${DEFAULT_GENERATE_MODEL}:generateContent`);
  eq("generate: default model is gemini-3.8-flash", DEFAULT_GENERATE_MODEL, "gemini-3.8-flash");
  eq("generate: sends cf-aig-authorization Bearer header",
     req.headers["cf-aig-authorization"]?.startsWith("Bearer "), true);
  eq("generate: contents carries the prompt as one text part",
     req.body.contents, [{ parts: [{ text: "Say hi" }] }]);
  eq("generate: system goes out as systemInstruction",
     req.body.systemInstruction, { parts: [{ text: "Be brief." }] });
  eq("generate: default temperature 0.7, nothing else in generationConfig",
     req.body.generationConfig, { temperature: 0.7 });
  eq("generate: returns text plus a one-line usage note",
     out, "Hello there.\n[usage: gemini-3.8-flash input 12, output 4, thinking 30 tokens]");
}

{
  const { deps, calls } = fakeDeps([json(gen("ok"))]);
  const out = await gateway(config, {
    op: "generate", prompt: "p", model: "lite", temperature: 0.2, max_tokens: 500, thinking_budget: 0,
  }, deps);
  eq("generate: alias 'lite' resolves per the skill's MODEL_ALIASES",
     calls[0].url.includes("/models/gemini-3.5-flash-lite:generateContent"), true);
  eq("generate: temperature, maxOutputTokens, thinkingConfig are camelCase in generationConfig",
     calls[0].body.generationConfig,
     { temperature: 0.2, maxOutputTokens: 500, thinkingConfig: { thinkingLevel: "minimal" } });
  eq("generate: no systemInstruction when system is absent", "systemInstruction" in calls[0].body, false);
  eq("generate: no usage line when usageMetadata is absent", out, "ok");
}

eq("thinking_budget 0 on 3.8-flash downgrades minimal -> low (HTTP 400 otherwise)",
   thinkingConfigFor("gemini-3.8-flash", 0), { thinkingLevel: "low" });
eq("thinking_budget bands: 1024 low, 8192 medium, 8193 high",
   [thinkingConfigFor("gemini-3.6-flash", 1024), thinkingConfigFor("gemini-3.6-flash", 8192), thinkingConfigFor("gemini-3.6-flash", 8193)],
   [{ thinkingLevel: "low" }, { thinkingLevel: "medium" }, { thinkingLevel: "high" }]);
eq("thinking_budget on 2.5 passes through as an integer thinkingBudget",
   thinkingConfigFor("gemini-2.5-flash", 2048), { thinkingBudget: 2048 });
eq("resolveModel passes unknown ids through untouched", resolveModel("gemini-9-ultra"), "gemini-9-ultra");

{
  // json_schema path: request carries responseMimeType/responseSchema, reply is parsed and re-serialised.
  const schema = { type: "object", properties: { name: { type: "string" }, n: { type: "integer" } }, required: ["name", "n"] };
  const { deps, calls } = fakeDeps([json(gen('{\n  "name": "Muninn",\n  "n": 2\n}', {
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 11 },
  }))]);
  const out = await gateway(config, { op: "generate", prompt: "extract", json_schema: schema }, deps);
  eq("generate+schema: responseMimeType and responseSchema in generationConfig",
     [calls[0].body.generationConfig.responseMimeType, calls[0].body.generationConfig.responseSchema],
     ["application/json", schema]);
  const [first, usage] = out.split("\n");
  eq("generate+schema: JSON is parsed and returned compact", JSON.parse(first), { name: "Muninn", n: 2 });
  eq("generate+schema: usage note follows (no thinking count when zero/absent)",
     usage, "[usage: gemini-3.8-flash input 20, output 11 tokens]");
}

{
  const { deps } = fakeDeps([json(gen("not json"))]);
  const err = await thrown(gateway(config, { op: "generate", prompt: "x", json_schema: { type: "object" } }, deps));
  eq("generate+schema: non-JSON reply is an error naming the cause", err.includes("not valid JSON despite json_schema"), true);
}

{
  const { deps } = fakeDeps([json({ candidates: [{ content: { parts: [{ text: '{"a":' }] }, finishReason: "MAX_TOKENS" }] })]);
  const err = await thrown(gateway(config, { op: "generate", prompt: "x", json_schema: { type: "object" } }, deps));
  eq("generate+schema: MAX_TOKENS truncation is reported as such, not as a parse error",
     err.includes("finishReason=MAX_TOKENS"), true);
}

{
  const { deps } = fakeDeps([json({ promptFeedback: { blockReason: "SAFETY" } })]);
  const err = await thrown(gateway(config, { op: "generate", prompt: "x" }, deps));
  eq("generate: empty response names the block reason", err.includes("(SAFETY)"), true);
}

// ---------------------------------------------------------------- retry / backoff

{
  // 429 with Retry-After: 2 → honour 2000ms (> 500ms backoff); then 503 with no
  // header → 1000ms exponential; then success. Three attempts total.
  const { deps, calls, delays } = fakeDeps([
    textRes("rate limited", 429, { "retry-after": "2" }),
    textRes("upstream", 503),
    json(gen("finally")),
  ]);
  const out = await gateway(config, { op: "generate", prompt: "x" }, deps);
  eq("retry: 429 then 503 then 200 succeeds after three attempts", [out, calls.length], ["finally", 3]);
  eq("retry: Retry-After is honoured, then exponential backoff for the bare 5xx", delays, [2000, 1000]);
}

{
  // Retry-After smaller than the exponential floor: the backoff wins.
  const { deps, delays } = fakeDeps([textRes("", 429, { "retry-after": "0" }), json(gen("ok"))]);
  await gateway(config, { op: "generate", prompt: "x" }, deps);
  eq("retry: a Retry-After below the backoff floor is raised to the floor", delays, [500]);
}

{
  // Retry-After far in the future is capped, not obeyed blindly.
  const { deps, delays } = fakeDeps([textRes("", 429, { "retry-after": "3600" }), json(gen("ok"))]);
  await gateway(config, { op: "generate", prompt: "x" }, deps);
  eq("retry: a huge Retry-After is capped at 30s", delays, [30000]);
}

{
  const { deps, calls, delays } = fakeDeps([textRes("still limited", 429)]);
  const err = await thrown(gateway(config, { op: "embed", texts: ["a"] }, deps));
  eq("retry: persistent 429 gives up after 3 attempts with two sleeps",
     [calls.length, delays, err.includes("HTTP 429")], [3, [500, 1000], true]);
}

{
  const { deps, calls } = fakeDeps([textRes('{"error":{"message":"Invalid JSON payload: unknown field $ref"}}', 400)]);
  const err = await thrown(gateway(config, { op: "generate", prompt: "x", json_schema: { $ref: "#/x" } }, deps));
  eq("retry: a 400 is not retried and its body is preserved",
     [calls.length, err.includes("unknown field $ref")], [1, true]);
}

{
  const { deps, calls } = fakeDeps([() => new Error(`fetch failed: POST with cf-aig-authorization: Bearer ${TOKEN}`), json(gen("ok"))]);
  const out = await gateway(config, { op: "generate", prompt: "x" }, deps);
  eq("retry: a thrown network error is retried", [out, calls.length], ["ok", 2]);
}

// ---------------------------------------------------------------- token never leaks

{
  // A gateway that echoes the request (headers and all) into an error body —
  // the worst realistic case. Neither the raw thrown error nor errorText may
  // contain the token.
  const echo = `bad request: cf-aig-authorization: Bearer ${TOKEN}`;
  const { deps } = fakeDeps([textRes(echo, 400)]);
  let raw = "";
  try { await gateway(config, { op: "generate", prompt: "x" }, deps); } catch (e) { raw = e instanceof Error ? e.message : String(e); }
  eq("leak: raw error from an echoing 400 does not contain the token after sanitising", errorText(new Error(raw)).includes(TOKEN), false);
  eq("leak: sanitised error still says what happened", errorText(new Error(raw)).includes("HTTP 400"), true);
}

{
  const { deps } = fakeDeps([() => new Error(`connect ECONNREFUSED; headers {"cf-aig-authorization":"Bearer ${TOKEN}"}`)]);
  const err = await thrown(gateway(config, { op: "embed", texts: ["a"] }, deps));
  eq("leak: network error text is sanitised of the token", err.includes(TOKEN), false);
  eq("leak: network error is still identifiable", err.includes("network error"), true);
}

{
  const err = await thrown(gateway({ ...config, CF_API_TOKEN: "" }, { op: "embed", texts: ["a"] }, fakeDeps([json({})]).deps));
  eq("unconfigured worker fails before any request", err.includes("not configured"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
