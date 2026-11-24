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
 * - Every failure that falls back opens the process's circuit, whatever its reason. While it is open,
 *   every new chat turn and diligence step turn starts on OpenAI and no real turn calls Anthropic.
 *   No timer closes it: a background probe (one 1-token request, never on a turn's path) asks
 *   Anthropic every 30 minutes, whatever the reason, until Anthropic answers. A 2xx closes the circuit,
 *   and so does any answer that is not a fallback reason (a 400 or 404 means the account works).
 *   The circuit lives in memory: a restarted controller starts closed and the first failing turn
 *   reopens it.
 * - Every fallback logs one `llm.fallback` line at warning level, without content; the circuit logs
 *   `llm.circuit_open` (warn, once per opening), `llm.probe` (info, every probe) and
 *   `llm.circuit_closed` (info). Each line carries `event`, `level` and `message` (the event name):
 *   Railway files a JSON line by `level` and keeps `event` as an attribute, which the ops watch
 *   searches (`@event:llm.fallback`).
 * - `LLM_FORCE_ANTHROPIC_FAILURE=1` (dev only) answers every Anthropic request with a simulated 401
 *   before any call is made; the probe fails the same way, so the circuit stays open.
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

export interface TransientFailure extends ProviderFailure {
  /** How long the provider asked to wait, when its error says. */
  readonly retryAfterMs?: number;
}

// OpenAI errors as Pi records them: "OpenAI API error (429): 429 Rate limit reached ...", a stream
// error "Error Code server_error: ...", or a failed response "rate_limit_exceeded: ...". Pi prefixes
// "Server requested 90s retry delay (max: 60s). " when a retry-after was longer than it waits.
const API_ERROR_STATUS = /^\s*[\w .-]*API error \((\d{3})\):\s*/u;
const SERVER_RETRY_DELAY = /^\s*Server requested (\d+)s retry delay[^.]*\.\s*/u;
const OPENAI_TRANSIENT_CODES: Readonly<Record<string, FallbackReason>> = {
  rate_limit_exceeded: "rate_limit",
  server_error: "server_error",
  server_is_overloaded: "overloaded",
  service_unavailable: "server_error",
};

/** "Please try again in 6.5s" / "in 820ms" / "in 1m30s" (OpenAI), or a `retry-after` value in seconds. */
function retryAfterMsOf(detail: string): number | undefined {
  const again = detail.match(/try again in ([\d.hms]+)/iu)?.[1]?.replace(/\.$/u, "");
  if (again) {
    if (/^\d+(?:\.\d+)?ms$/u.test(again)) return Number.parseFloat(again);
    const parts = again.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/u);
    if (parts?.[0])
      return (
        ((Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0)) * 60 + Number(parts[3] ?? 0)) * 1000
      );
  }
  const seconds = detail.match(/retry[-_ ]after["':\s]+(\d+(?:\.\d+)?)/iu)?.[1];
  return seconds ? Number(seconds) * 1000 : undefined;
}

/**
 * Whether a failed turn may succeed if tried again later, from Anthropic or OpenAI: a rate limit,
 * an overload, another 5xx, a timeout or a connection error. Auth, billing and every other 4xx are
 * not transient.
 */
export function classifyTransientFailure(detail: string | undefined): TransientFailure | undefined {
  if (!detail) return undefined;
  let text = detail;
  let retryAfterMs = retryAfterMsOf(detail);
  const requested = text.match(SERVER_RETRY_DELAY);
  if (requested) {
    retryAfterMs = Number(requested[1]) * 1000;
    text = text.slice(requested[0].length);
  }
  // "OpenAI API error (429): ..." reads as Anthropic's "429 ...".
  const apiError = text.match(API_ERROR_STATUS);
  if (apiError) text = `${apiError[1]} ${text.slice(apiError[0].length)}`;
  const code = text.match(/^\s*(?:Error Code\s+)?([a-z_]+):/u)?.[1];
  const reason = code ? OPENAI_TRANSIENT_CODES[code] : undefined;
  const failure = classifyAnthropicFailure(text) ?? (reason ? { reason, status: null } : undefined);
  if (!failure || failure.reason === "auth" || failure.reason === "billing") return undefined;
  return retryAfterMs === undefined ? failure : { ...failure, retryAfterMs };
}

/** Seconds between probes while the circuit is open, whatever opened it. */
const PROBE_EVERY_SECONDS = 30 * 60;
const PROBE_TIMEOUT_MS = 30_000;

/** What one probe found: `failure` is a fallback reason (the circuit stays open), else Anthropic answered. */
interface ProbeResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly failure: ProviderFailure | undefined;
}

/**
 * One 1-token request to the model whose failure opened the circuit, with the key Pi uses
 * (`ANTHROPIC_API_KEY`), and no retries. A thrown fetch (no answer) is a timeout or a connection
 * failure.
 */
async function probeAnthropic(model: string): Promise<ProbeResult> {
  if (anthropicFailureForced()) {
    return { ok: false, status: 401, failure: classifyAnthropicFailure(SIMULATED_AUTH_FAILURE) };
  }
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return { ok: false, status: null, failure: { reason: "auth", status: null } };
  const base = (process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(
    /\/+$/u,
    "",
  );
  try {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: true, status: response.status, failure: undefined };
    }
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      failure: classifyAnthropicFailure(`${response.status} ${body}`),
    };
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    const reason: FallbackReason =
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "connection";
    return { ok: false, status: null, failure: { reason, status: null } };
  }
}

interface OpenCircuit extends ProviderFailure {
  /** The reason and status that opened the circuit; `reason`/`status` follow the latest failure. */
  readonly opened: ProviderFailure;
  readonly since: number;
  /** The Anthropic model ID whose failure opened the circuit; the probe asks it. */
  readonly model: string;
}

/**
 * Once a turn falls back, every new turn goes straight to OpenAI until a background probe finds
 * Anthropic answering again. One circuit per process, in memory.
 */
class Circuit {
  #open: OpenCircuit | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  current(): ProviderFailure | undefined {
    return this.#open;
  }

  /**
   * Opens on any failure that falls back (auth, billing or transient), from the Anthropic `model`
   * that failed. An open circuit stays as it is and logs nothing more.
   */
  trip(failure: ProviderFailure, feature: string, model: ModelRef) {
    if (this.#open) return;
    this.#open = {
      reason: failure.reason,
      status: failure.status,
      opened: { reason: failure.reason, status: failure.status },
      since: Date.now(),
      model: model.modelId,
    };
    llmCircuitOpen.set({}, 1);
    logEvent("warn", "llm.circuit_open", {
      message: "llm.circuit_open",
      system: SYSTEM,
      provider: "anthropic",
      feature,
      model: model.modelId,
      reason: failure.reason,
      status: failure.status,
      probe_every_s: PROBE_EVERY_SECONDS,
    });
    this.#schedule(PROBE_EVERY_SECONDS);
  }

  #schedule(seconds: number) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#probe(), seconds * 1000);
    this.#timer.unref();
  }

  async #probe() {
    const open = this.#open;
    if (!open) return;
    const result = await probeAnthropic(open.model).catch(
      (): ProbeResult => ({
        ok: false,
        status: null,
        failure: { reason: "connection", status: null },
      }),
    );
    logEvent("info", "llm.probe", {
      message: "llm.probe",
      system: SYSTEM,
      provider: "anthropic",
      model: open.model,
      ok: result.ok,
      reason: result.failure?.reason ?? null,
      status: result.status,
    });
    if (this.#open !== open) return;
    if (result.failure) {
      // Still unusable: the circuit takes the latest reason and probes again later.
      this.#open = { ...open, reason: result.failure.reason, status: result.failure.status };
      this.#schedule(PROBE_EVERY_SECONDS);
      return;
    }
    // A 2xx, or an answer no other provider would fix (a 400 or 404): the account works again.
    this.#open = undefined;
    this.#timer = undefined;
    llmCircuitOpen.set({}, 0);
    logEvent("info", "llm.circuit_closed", {
      message: "llm.circuit_closed",
      system: SYSTEM,
      provider: "anthropic",
      by: "probe",
      reason: open.opened.reason,
      status: open.opened.status,
      open_seconds: Math.round((Date.now() - open.since) / 1000),
    });
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
    message: "llm.fallback",
    system: SYSTEM,
    feature,
    from_model: refText(from),
    to_model: refText(to),
    reason: failure.reason,
    status: failure.status,
  });
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** What the product shows next to a switch or a retry ("model.rerouted", the run's live log). */
export function describeFailure(failure: ProviderFailure, provider = "anthropic") {
  const what: Record<FallbackReason, string> = {
    auth: "rejected the API key",
    billing: "refused for billing or spend limits",
    rate_limit: "rate limited the request",
    overloaded: "was overloaded",
    server_error: "returned a server error",
    timeout: "timed out",
    connection: "could not be reached",
  };
  return `${PROVIDER_NAMES[provider] ?? provider} ${what[failure.reason]}${failure.status ? ` (${failure.status})` : ""}`;
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
  // Every request looks its model up; a catalog list is extended once.
  const extended = new WeakMap<object, unknown[]>();
  const extend = <T extends { readonly id: string; readonly type?: string }>(
    models: readonly T[],
  ): T[] => {
    const cached = extended.get(models);
    if (cached) return cached as T[];
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
    extended.set(models, out);
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
