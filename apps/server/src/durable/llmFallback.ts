/**
 * Anthropic → OpenAI fallback for chat and diligence turns.
 *
 * The GlasswingOS Python services and the Tracker implement the same contract with the same names.
 *
 * - The configured Anthropic model stays primary. A turn moves to OpenAI only after Anthropic failed
 *   with 401/403, a billing, credit or spend-limit error, or (after Pi's own retries) 429, 529, another
 *   5xx, a timeout or a connection error. Every other 4xx fails as before.
 * - Opus (and any other Anthropic model) → `LLM_FALLBACK_OPUS_MODEL` (default `openai/gpt-6.2-sol`);
 *   Sonnet and Haiku → `LLM_FALLBACK_SONNET_MODEL` (default `openai/gpt-6.1-terra`).
 * - An auth or billing failure opens a 15-minute circuit: new turns start on OpenAI without asking
 *   Anthropic, then Anthropic is tried again. Transient failures fall back for that turn only.
 * - Every fallback logs one `llm.fallback` line at warning level, without content; the circuit logs
 *   `llm.circuit_open` and `llm.circuit_closed`. The ops watch greps for them.
 * - `LLM_FORCE_ANTHROPIC_FAILURE=1` (dev only) answers every Anthropic request with a simulated 401
 *   before any call is made.
 */
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { Provider } from "@earendil-works/pi-ai/models";

import { llmCircuitOpen, llmFallbacks, logEvent } from "../controllerMetrics.ts";

export type FallbackReason =
  | "auth"
  | "billing"
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "connection";

export interface ProviderFailure {
  readonly reason: FallbackReason;
  readonly status: number | null;
}

export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

const SYSTEM = "synara-controller";
const CIRCUIT_MS = 15 * 60_000;

const parseRef = (value: string): ModelRef => {
  const [provider, ...rest] = value.trim().split("/");
  return rest.length
    ? { provider: provider!, modelId: rest.join("/") }
    : { provider: "openai", modelId: value.trim() };
};

export const FALLBACK_OPUS_MODEL = parseRef(
  process.env.LLM_FALLBACK_OPUS_MODEL?.trim() || "openai/gpt-6.2-sol",
);
export const FALLBACK_SONNET_MODEL = parseRef(
  process.env.LLM_FALLBACK_SONNET_MODEL?.trim() || "openai/gpt-6.1-terra",
);

export const refText = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`;

/** The OpenAI model an Anthropic model falls back to; undefined for any other provider. */
export function fallbackModelFor(ref: ModelRef | undefined): ModelRef | undefined {
  if (ref?.provider !== "anthropic") return undefined;
  return /sonnet|haiku/iu.test(ref.modelId) ? FALLBACK_SONNET_MODEL : FALLBACK_OPUS_MODEL;
}

// Anthropic's credit, billing and spend-limit errors are 400s ("Your credit balance is too low",
// "You have reached your specified API usage limits"); OpenAI-style gateways say quota.
const BILLING =
  /credit balance|billing|spend(?:ing)? limit|usage limits?\b|insufficient_quota|quota exceeded/iu;

/**
 * Whether an Anthropic failure moves the turn to OpenAI, and why. `detail` is the provider's error
 * text as Pi records it: the SDK's `"<status> {json body}"` for HTTP errors, the error event's JSON
 * for errors inside a stream, or the transport's message.
 */
export function classifyAnthropicFailure(detail: string | undefined): ProviderFailure | undefined {
  if (!detail) return undefined;
  const leading = detail.match(/^\s*(\d{3})\b/u);
  const status = leading ? Number(leading[1]) : null;
  const type = detail.match(/"type"\s*:\s*"([a-z_]+_error)"/u)?.[1];
  // A refusal's explanation is prose and can name anything; a refusal never moves providers.
  if (
    status === null &&
    !type &&
    /(?<!connection |ECONN)refus|usage policy|stopped with: sensitive/iu.test(detail)
  )
    return undefined;
  if (BILLING.test(detail)) return { reason: "billing", status };
  if (status !== null) {
    if (status === 401 || status === 403) return { reason: "auth", status };
    if (status === 429) return { reason: "rate_limit", status };
    if (status === 529) return { reason: "overloaded", status };
    if (status >= 500) return { reason: "server_error", status };
    if (status === 408) return { reason: "timeout", status };
    // Every other 4xx is the request's own fault; another provider would not fix it.
    return undefined;
  }
  // An error event inside the stream carries Anthropic's error type.
  if (type === "authentication_error" || type === "permission_error")
    return { reason: "auth", status: null };
  if (type === "rate_limit_error") return { reason: "rate_limit", status: null };
  if (type === "overloaded_error") return { reason: "overloaded", status: null };
  if (type === "api_error") return { reason: "server_error", status: null };
  if (type) return undefined;
  if (/request timed out|timed out|\bETIMEDOUT\b/iu.test(detail))
    return { reason: "timeout", status: null };
  if (
    /connection error|connection (?:refused|reset|closed)|fetch failed|socket hang up|other side closed|^terminated$|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|stream ended before message_stop|stream ended without a stop reason/iu.test(
      detail,
    )
  ) {
    return { reason: "connection", status: null };
  }
  if (/\boverloaded\b/iu.test(detail)) return { reason: "overloaded", status: null };
  return undefined;
}

/** After an auth or billing failure, new turns go straight to OpenAI for 15 minutes. */
class Circuit {
  #open: (ProviderFailure & { readonly until: number }) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  current(): ProviderFailure | undefined {
    return this.#open && Date.now() < this.#open.until ? this.#open : undefined;
  }

  /** Opens on auth and billing failures; a transient failure leaves it as it is. */
  trip(failure: ProviderFailure, feature: string) {
    if (failure.reason !== "auth" && failure.reason !== "billing") return;
    if (this.current()) return;
    this.#open = { ...failure, until: Date.now() + CIRCUIT_MS };
    llmCircuitOpen.set({}, 1);
    logEvent("warn", "llm.circuit_open", {
      system: SYSTEM,
      provider: "anthropic",
      feature,
      reason: failure.reason,
      status: failure.status,
      until: new Date(this.#open.until).toISOString().replace(/\.\d{3}Z$/u, "Z"),
    });
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      const closed = this.#open;
      this.#open = undefined;
      llmCircuitOpen.set({}, 0);
      logEvent("info", "llm.circuit_closed", {
        system: SYSTEM,
        provider: "anthropic",
        reason: closed?.reason ?? null,
        status: closed?.status ?? null,
      });
    }, CIRCUIT_MS);
    this.#timer.unref();
  }
}

export const anthropicCircuit = new Circuit();

/** The one flag line per fallback; never carries content. */
export function logFallback(
  feature: string,
  from: ModelRef,
  to: ModelRef,
  failure: ProviderFailure,
) {
  llmFallbacks.inc({
    reason: failure.reason,
    feature: feature.startsWith("diligence:") ? "diligence" : feature,
  });
  logEvent("warn", "llm.fallback", {
    system: SYSTEM,
    feature,
    from_model: refText(from),
    to_model: refText(to),
    reason: failure.reason,
    status: failure.status,
  });
}

/** What the product shows next to a switch ("model.rerouted", the run's live log). */
export function describeFailure(failure: ProviderFailure) {
  const what: Record<FallbackReason, string> = {
    auth: "rejected the API key",
    billing: "refused for billing or spend limits",
    rate_limit: "rate limited the request",
    overloaded: "was overloaded",
    server_error: "returned a server error",
    timeout: "timed out",
    connection: "could not be reached",
  };
  return `Anthropic ${what[failure.reason]}${failure.status ? ` (${failure.status})` : ""}`;
}

export const CONTINUE_PROMPT =
  "Your previous response was interrupted before it finished. Continue the task from where you left off.";

const SIMULATED_AUTH_FAILURE =
  '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key (simulated by LLM_FORCE_ANTHROPIC_FAILURE)"}}';

const PRODUCTION =
  (
    process.env.SYNARA_ENVIRONMENT?.trim() ||
    process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
    ""
  ).toLowerCase() === "production";

/**
 * Dev-only switch: every Anthropic request fails as a dead key would, before any network call.
 * Ignored in production.
 */
export const anthropicFailureForced = () =>
  process.env.LLM_FORCE_ANTHROPIC_FAILURE?.trim() === "1" && !PRODUCTION;

function simulatedAuthFailure(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: SIMULATED_AUTH_FAILURE,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error });
    stream.end();
  });
  return stream;
}

/** The Anthropic provider with the dev-only forced failure; unchanged unless the switch is set. */
export function withForcedAnthropicFailure<P extends object>(base: P): P {
  return new Proxy(base, {
    get(target, property) {
      if ((property === "stream" || property === "streamSimple") && anthropicFailureForced()) {
        return (model: Model<Api>) => simulatedAuthFailure(model);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** "gpt-6.2-sol" → "GPT-6.2 Sol". */
const openAiName = (id: string) =>
  id
    .replace(/^gpt-/u, "GPT-")
    .replace(
      /-([a-z]+)$/u,
      (_, family: string) => ` ${family.charAt(0).toUpperCase()}${family.slice(1)}`,
    );

const versionOf = (id: string) => (id.match(/(\d+(?:\.\d+)*)/u)?.[1] ?? "0").split(".").map(Number);
const newer = (a: number[], b: number[]) => {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The OpenAI provider, with the fallback models added when Pi's catalog predates them: each is the
 * newest catalog model of its family ("sol", "terra") under the new ID, so limits, thinking levels
 * and prices follow that model until Pi's catalog lists it.
 */
export function withFallbackModels<P extends object>(base: P): P {
  const provider = base as unknown as Provider;
  const wanted = [FALLBACK_OPUS_MODEL, FALLBACK_SONNET_MODEL].filter(
    (ref) => ref.provider === provider.id,
  );
  if (!wanted.length) return base;
  const extend = <T extends { readonly id: string; readonly type?: string }>(
    models: readonly T[],
  ): T[] => {
    const out = [...models];
    for (const ref of wanted) {
      if (out.some((model) => model.id === ref.modelId)) continue;
      const family = ref.modelId.match(/-([a-z]+)$/u)?.[1];
      const template = family
        ? models
            .filter((model) => (model.type ?? "chat") === "chat" && model.id.endsWith(`-${family}`))
            .toSorted((a, b) => newer(versionOf(b.id), versionOf(a.id)))[0]
        : undefined;
      if (template) out.push({ ...template, id: ref.modelId, name: openAiName(ref.modelId) });
    }
    return out;
  };
  return new Proxy(base, {
    get(target, property) {
      if (property === "getModels") return () => extend(provider.getModels());
      if (property === "getAllModels" && provider.getAllModels)
        return () =>
          extend(
            provider.getAllModels!() as ReadonlyArray<{
              readonly id: string;
              readonly type?: string;
            }>,
          );
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
