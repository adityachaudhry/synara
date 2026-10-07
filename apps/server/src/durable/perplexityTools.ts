/**
 * Perplexity search and ask, as Pi Durable tools. Port of the diligence runner's
 * in-process MCP server (glasswing-ai-2 agent-ts/src/mcp/perplexity.ts); tool names match.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

const BASE_URL = "https://api.perplexity.ai";
const ASK_MODEL = "sonar-pro";
const MAX_QUERIES = 5;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 5000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(route: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const key = process.env.PERPLEXITY_API_KEY?.trim();
  if (!key) throw new Error("PERPLEXITY_API_KEY is not set");
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return await response.json();
      if (RETRYABLE.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`Perplexity API ${response.status} on ${route}: ${detail || response.statusText}`);
    } catch (error) {
      if (signal?.aborted) throw error;
      const transient = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError");
      if (transient && attempt < RETRY_DELAYS_MS.length) {
        lastError = error;
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Perplexity API failed on ${route}: ${String(lastError)}`);
}

function searchMarkdown(queries: string[], results: any[]): string {
  const lines = [`# Perplexity Search (${queries.length} quer${queries.length === 1 ? "y" : "ies"} batched)`, ""];
  for (const query of queries) lines.push(`- query: ${query}`);
  lines.push("");
  if (!results.length) lines.push("No results returned.");
  results.forEach((item, index) => {
    const snippet = String(item?.snippet ?? "").split(/\s+/u).filter(Boolean).join(" ");
    const date = String(item?.date ?? item?.last_updated ?? "");
    lines.push(`## ${index + 1}. ${String(item?.title ?? "(untitled)")}`, `- url: ${String(item?.url ?? "")}`);
    if (date) lines.push(`- date: ${date}`);
    if (snippet) lines.push(`- snippet: ${snippet}`);
    lines.push("");
  });
  lines.push("Results are one merged ranked list across all batched queries.");
  return lines.join("\n");
}

function askMarkdown(question: string, data: any): string {
  const content = String(data?.choices?.[0]?.message?.content ?? "");
  const lines = [`# Perplexity Ask (${ASK_MODEL})`, "", `Question: ${question}`, "", content.trim(), ""];
  const sources = Array.isArray(data?.search_results) ? data.search_results : [];
  const citations = Array.isArray(data?.citations) ? data.citations : [];
  if (sources.length) {
    lines.push("## Sources");
    for (const item of sources) lines.push(`- ${item?.title ?? "(untitled)"}: ${item?.url ?? ""}`);
  } else if (citations.length) {
    lines.push("## Citations");
    for (const url of citations) lines.push(`- ${url}`);
  }
  return lines.join("\n");
}

export function createPerplexityTools(): ToolRegistration[] {
  if (!process.env.PERPLEXITY_API_KEY?.trim()) return [];
  const search = defineTool({
    name: "perplexity_search",
    description:
      "Web search via the Perplexity Search API. Accepts 1-5 queries per call; batch related questions into one call instead of making sequential calls. Returns one merged ranked list of results (title, url, snippet, date) across all queries. No AI synthesis; for a synthesized answer use perplexity_ask.",
    parameters: Type.Object({
      queries: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_QUERIES, description: "1-5 related search queries, batched into a single API request." }),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Total results across the batch. Defaults to 5 per query, capped at 20." })),
      max_tokens_per_page: Type.Optional(Type.Integer({ minimum: 256, maximum: 2048 })),
    }),
    replay: "safe",
    execute: async (args, _api, context) => {
      const queries = args.queries.map((query) => query.trim()).filter(Boolean).slice(0, MAX_QUERIES);
      if (!queries.length) throw new Error("queries must contain at least one non-empty string");
      const data = await requestJson("/search", {
        query: queries.length > 1 ? queries : queries[0],
        max_results: Math.max(1, Math.min(args.max_results ?? Math.min(20, 5 * queries.length), 20)),
        max_tokens_per_page: Math.max(256, Math.min(args.max_tokens_per_page ?? 1024, 2048)),
      }, 120_000, context.abortSignal);
      return { content: [{ type: "text", text: searchMarkdown(queries, Array.isArray(data?.results) ? data.results : []) }] };
    },
  });
  const ask = defineTool({
    name: "perplexity_ask",
    description:
      "Answer one question using web-grounded AI (Sonar Pro). Returns a synthesized answer with sources. Use for narrow synthesis questions; use perplexity_search (batched) for finding facts, URLs, and sources.",
    parameters: Type.Object({
      question: Type.String({ description: "The question to answer." }),
      search_recency_filter: Type.Optional(Type.Union(["hour", "day", "week", "month", "year"].map((value) => Type.Literal(value)))),
      search_domain_filter: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    }),
    replay: "safe",
    execute: async (args, _api, context) => {
      const question = args.question.trim();
      if (!question) throw new Error("question is required");
      const body: Record<string, unknown> = { model: ASK_MODEL, messages: [{ role: "user", content: question }] };
      if (args.search_recency_filter) body.search_recency_filter = args.search_recency_filter;
      if (args.search_domain_filter?.length) body.search_domain_filter = args.search_domain_filter.slice(0, 20);
      const data = await requestJson("/chat/completions", body, 240_000, context.abortSignal);
      return { content: [{ type: "text", text: askMarkdown(question, data) }] };
    },
  });
  return [search as unknown as ToolRegistration, ask as unknown as ToolRegistration];
}
