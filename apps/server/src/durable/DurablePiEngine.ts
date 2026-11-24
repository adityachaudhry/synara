/**
 * The Pi agent loop for durable threads, running in the controller.
 *
 * One Pi Durable Harness owns one SQLite file. Each Synara thread maps to one Harness
 * conversation. Model requests, tool calls and their results are committed before they are
 * shown, so a controller restart continues an unfinished turn from its last checkpoint.
 * File and shell tools run in the thread's sandbox through `SandboxExecutionEnv`.
 *
 * The engine answers the same requests the in-sandbox worker answered (session.start,
 * turn.send, turn.steer, turn.interrupt, ...), so the routed adapter keeps its sandbox,
 * checkpoint and persistence logic unchanged.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  type AgentEvent,
  type MessageChange,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type Extension,
  type Harness as HarnessType,
  type SubmissionId,
  type ToolRegistration,
  AssistantEntry,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  section,
  ToolResultEntry,
  UsageDoc,
  UserEntry,
  watchEvents,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type OrchestrationMessageAuthor,
  type ProviderRuntimeEvent,
  type ProviderListModelsResult,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
} from "@synara/contracts";
import type { TSchema } from "typebox";

import { appendFileAttachmentsPromptBlock } from "../provider/attachmentProjection.ts";
import {
  GLASSWING_AGENT_SYSTEM_PROMPT,
  renderGlasswingMessageAuthorContext,
} from "../provider/glasswingAgentProfile.ts";
import { renderSynaraHarnessPolicy } from "../agentGateway/harnessPolicy.ts";
import { callAgentGatewayMcpTool, listAgentGatewayMcpTools } from "../agentGateway/mcpInjection.ts";
import { parseModelReference, toPiProviderModelDescriptor } from "../provider/piModelCatalog.ts";
import { textFromToolResult, toolItemType, toolLifecycleData, toolResultForDisplay, toolTitle } from "../provider/piToolDisplay.ts";
import { configurePiWebAccess, createCrunchbaseTools, createWebAccessTools } from "./extensionTools.ts";
import { createPerplexityTools } from "./perplexityTools.ts";
import { SandboxExecutionEnv, type SandboxRunner } from "./sandboxEnv.ts";
import { backupHarness, describe, restoreHarnessIfNeeded, startHarnessBackups } from "./backup.ts";
import { openHarnessStorage } from "./harnessStorage.ts";
import { ContextPackCache, requesterEmailOf } from "./contextPack.ts";
import { resumingDurableThreads } from "../providerWorker/headlessSessions.ts";
import { glasswingAuthorEmail } from "../provider/glasswingAgentProfile.ts";
import { logEvent, recordTurn, setDurableEngineGauges, type ThreadKind } from "../controllerMetrics.ts";
import { sendUsageEvent } from "./usageEvents.ts";
import {
  anthropicCircuit,
  anthropicFailureForced,
  classifyAnthropicFailure,
  CONTINUE_PROMPT,
  describeFailure,
  FALLBACK_OPUS_MODEL,
  FALLBACK_SONNET_MODEL,
  fallbackModelFor,
  logFallback,
  refText,
  withFallbackModels,
  withForcedAnthropicFailure,
  type ModelRef,
  type ProviderFailure,
} from "./llmFallback.ts";

const PROVIDER = "pi" as const;
const ctx = BACKGROUND_CONTEXT;

/**
 * Where a conversation's events go when it is a child of a Synara thread (a diligence step): its
 * events are published on the parent thread with provider refs that make Synara show them in the
 * child thread `subagent:<parentThreadId>:<providerThreadId>`.
 */
type ThreadRoute = {
  parentThreadId: string;
  providerThreadId: string;
};

/** threadId → conversation, kept in the Harness so a restart finds running work. */
const ThreadIndex = defineDoc<{ threads: Record<string, { conversationId: number; generation: string; cwd: string; route?: ThreadRoute; unfenced?: boolean }> }>({
  kind: "synara.thread-index",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
});

export interface DurableThreadTarget {
  readonly threadId: string;
  readonly lifecycleGeneration: string;
  readonly cwd: string;
  readonly homeDir: string;
  readonly runner: SandboxRunner;
  readonly envId: string;
}

export interface DurablePiEngineOptions {
  readonly storagePath: string;
  readonly agentDir: string;
  /** The thread's sandbox, claimed if needed. Called only when a tool needs files or a shell. */
  readonly target: (threadId: string) => Promise<DurableThreadTarget | undefined>;
  /** Controller-local copy of an image attachment. */
  readonly readAttachment: (attachment: ChatAttachment) => Promise<Uint8Array | undefined>;
  readonly gatewayUrl: string | undefined;
  readonly publish: (event: ProviderRuntimeEvent) => void;
  /** The Glasswing company of a thread's project, if it is one; selects the Glasswing profile and context pack. */
  readonly resolveCompany?: ((threadId: string) => Promise<string | undefined>) | undefined;
}

/** A thread that is not (yet) a company conversation is asked about again after this long. */
const COMPANY_LOOKUP_RETRY_MS = 60_000;

interface ThreadState {
  readonly threadId: string;
  readonly conversationId: ConversationId;
  lifecycleGeneration: string;
  cwd: string;
  createdAt: string;
  model?: string | undefined;
  activeTurnId?: TurnId | undefined;
  turns: TurnId[];
  assistantItemId?: RuntimeItemId | undefined;
  reasoningItemId?: RuntimeItemId | undefined;
  tools: Map<string, { itemId: RuntimeItemId; toolName: string; args: unknown; itemType: ReturnType<typeof toolItemType> }>;
  /** Text and thinking of the in-flight assistant message, by content index, and how much was emitted. */
  partial: Map<number, { kind: "text" | "thinking"; text: string; emitted: number }>;
  gatewayToken?: string | undefined;
  /**
   * The open event watch. A watch keeps the conversation's whole active context in memory (a Pi
   * Durable view), so it is open only while a turn runs: 2026-11-19 the production controller ran out
   * of heap holding a view of every conversation since its start.
   */
  watch?: { readonly stop: () => Promise<unknown> } | undefined;
  watching: boolean;
  /** Measurements of the running turn, for metrics and Glasswing usage events. */
  turnInfo?: TurnInfo | undefined;
  /** The Anthropic model a provider fallback replaced; the thread's next turn returns to it. */
  restoreModel?: ModelRef | undefined;
  /** The model the running turn moved to, when a provider fallback moved it. */
  turnModel?: string | undefined;
  stopped: boolean;
  lastUsage?: ThreadTokenUsageSnapshot | undefined;
  turnStartedAt?: number | undefined;
  /** Set for a child conversation shown under another thread. */
  route?: ThreadRoute | undefined;
  /** A turn driven from outside the conversation (a diligence run on its run thread). */
  externalTurnId?: TurnId | undefined;
  /**
   * Started by the controller, not by ProviderService (diligence run threads): ProviderService has
   * no lifecycle generation for it, so its events carry none and are not filtered as stale.
   */
  unfenced?: boolean | undefined;
}

interface UsageTotals {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface TurnInfo {
  readonly startedAt: number;
  readonly author?: OrchestrationMessageAuthor | undefined;
  readonly usageBefore?: UsageTotals | undefined;
  firstTextAt?: number | undefined;
  readonly tools: Record<string, number>;
}

/** How a thread shows in metrics and usage events. */
const threadKindOf = (state: { readonly threadId: string; readonly route?: unknown }): ThreadKind =>
  state.route ? "diligence_step"
    : state.threadId.startsWith("diligence-run-") ? "run"
      : state.threadId.startsWith("glasswing-note-") ? "note_reply" : "chat";

const APP_VERSION = process.env.SYNARA_COMMIT?.trim() || "development";

export interface DurableStartInput {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration: string;
  readonly cwd: string;
  readonly modelSelection?: { readonly provider: string; readonly model: string; readonly options?: unknown } | undefined;
  readonly runtimeMode?: ProviderSession["runtimeMode"];
  readonly unfenced?: boolean | undefined;
}

export interface DurableTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string | undefined;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly modelSelection?: { readonly provider: string; readonly model: string; readonly options?: unknown } | undefined;
  readonly author?: OrchestrationMessageAuthor | undefined;
  readonly repositoryUnavailable?: boolean | undefined;
  readonly gatewayBearerToken?: string | undefined;
  readonly attachmentsDir: string;
}

const thinkingLevelOf = (options: unknown): string | undefined => {
  const value = options && typeof options === "object" ? (options as Record<string, unknown>).thinkingLevel : undefined;
  return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value) ? value : undefined;
};

const modelRefOf = (model: string | undefined) => {
  const parsed = parseModelReference(model);
  if (!parsed) return undefined;
  return { provider: parsed.provider ?? "anthropic", modelId: parsed.id };
};

const DEFAULT_MODEL = { provider: "anthropic", modelId: "claude-opus-5-5" } as const;

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Whether an image file is whole: its format's start and end markers are both present. */
function completeImage(bytes: Buffer, mimeType: string): boolean {
  const ends = (tail: number[]) => bytes.length > tail.length && tail.every((byte, index) => bytes[bytes.length - tail.length + index] === byte);
  switch (mimeType) {
    case "image/png":
      // IEND chunk type plus its CRC.
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        && ends([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && ends([0xff, 0xd9]);
    case "image/gif":
      return bytes.subarray(0, 4).toString("latin1") === "GIF8" && ends([0x3b]);
    case "image/webp":
      return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"
        && bytes.length >= 8 && bytes.readUInt32LE(4) + 8 <= bytes.length;
    default:
      return bytes.length > 0;
  }
}

/**
 * Anthropic models that may fall back to another model when a safety classifier declines
 * (server-side `fallbacks`). Off unless SYNARA_ANTHROPIC_FALLBACKS lists the targets, e.g.
 * "claude-opus-5,claude-opus-4-8"; Anthropic rejects the field for targets it does not permit,
 * so a wrong list fails every request on that model. Applies to claude-opus-5-5 only.
 */
const FALLBACK_SOURCE_MODELS = new Set(["claude-opus-5-5"]);

function anthropicWithFallbacks(base: Provider<"anthropic-messages">): Provider<"anthropic-messages"> {
  const targets = (process.env.SYNARA_ANTHROPIC_FALLBACKS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!targets.length) return base;
  const catalog = base.getModels();
  const allowed = targets.flatMap((id) => {
    const target = catalog.find((model) => model.id === id);
    return target ? [{ provider: target.provider, model: target.id, cost: target.cost }] : [];
  });
  if (!allowed.length) return base;
  const withFallbacks = <T extends { id: string; compat?: unknown }>(model: T): T =>
    FALLBACK_SOURCE_MODELS.has(model.id)
      ? { ...model, compat: { ...(model.compat as object | undefined), allowedFallbackModels: allowed } }
      : model;
  console.info(JSON.stringify({ event: "durable.anthropic-fallbacks", models: [...FALLBACK_SOURCE_MODELS], targets: allowed.map((target) => target.model) }));
  return new Proxy(base, {
    get(target, property) {
      if (property === "getModels") return () => target.getModels().map(withFallbacks);
      if (property === "getAllModels" && target.getAllModels) return () => target.getAllModels!().map((model) => withFallbacks(model as never));
      if (property === "filterModels" && target.filterModels) {
        return (models: Parameters<NonNullable<typeof target.filterModels>>[0], credential: Parameters<NonNullable<typeof target.filterModels>>[1]) =>
          target.filterModels!(models, credential).map(withFallbacks);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Pi Durable's read tool does not return images yet; the agent reads screenshots and scans this way. */
function readWithImages(read: ReturnType<typeof createReadTool>): ToolRegistration {
  return {
    ...read,
    execute: async (args: unknown, api: Parameters<ToolRegistration["execute"]>[1], context: Parameters<ToolRegistration["execute"]>[2]) => {
      const mimeType = IMAGE_TYPES[path.extname(String((args as { path?: unknown }).path ?? "")).toLowerCase()];
      if (!mimeType || !api.env) return read.execute(args as never, api as never, context);
      const absolute = await api.env.absolutePath(String((args as { path: string }).path), context);
      if (!absolute.ok) throw absolute.error;
      const bytes = await api.env.readBinaryFile(absolute.value, context);
      if (!bytes.ok) throw bytes.error;
      if (bytes.value.byteLength > MAX_IMAGE_BYTES) {
        return { content: [{ type: "text", text: `${String((args as { path: string }).path)} is an image larger than 5 MB; convert or crop it with bash first.` }] };
      }
      // Anthropic rejects the whole request for an empty or truncated image ("Could not process image"),
      // which ends the turn; a file still being written by pdftoppm and the like is the usual cause.
      if (!completeImage(Buffer.from(bytes.value), mimeType)) {
        return { content: [{ type: "text", text: `${String((args as { path: string }).path)} is empty or incomplete (it may still be being written). Make sure the command that creates it has finished, then read it again.` }] };
      }
      return { content: [{ type: "image", data: Buffer.from(bytes.value).toString("base64"), mimeType }] };
    },
  } as unknown as ToolRegistration;
}

export class DurablePiEngine {
  readonly #options: DurablePiEngineOptions;
  #harness!: HarnessType;
  readonly #threads = new Map<string, ThreadState>();
  readonly #byConversation = new Map<ConversationId, ThreadState>();
  readonly #gatewayTools = new Map<string, ToolRegistration>();
  #gatewayExtensionInstalled = false;
  readonly #registry = createRegistry();
  #stopBackups: (() => void) | undefined;
  readonly #models = createModels();
  readonly #contextPacks = new ContextPackCache();
  readonly #companies = new Map<string, { readonly at: number; readonly companyId: Promise<string | undefined> }>();

  private constructor(options: DurablePiEngineOptions) {
    this.#options = options;
  }

  static async open(options: DurablePiEngineOptions): Promise<DurablePiEngine> {
    const engine = new DurablePiEngine(options);
    await engine.#init();
    return engine;
  }

  async #init() {
    mkdirSync(path.dirname(this.#options.storagePath), { recursive: true });
    if (process.env.ANTHROPIC_API_KEY) this.#models.setProvider(withForcedAnthropicFailure(anthropicWithFallbacks(anthropicProvider())));
    // OpenAI is the fallback when Anthropic is unusable (llmFallback.ts), and a model of its own.
    if (process.env.OPENAI_API_KEY) this.#models.setProvider(withFallbackModels(openaiProvider()));

    const today = () => new Date().toISOString().slice(0, 10);
    // Tools and research are shared by chat threads and diligence runs; the chat profile is chat-only.
    this.toolsExtension = defineExtension({
      name: "synara-tools",
      tools: [readWithImages(createReadTool()), createWriteTool(), createEditTool(), createBashTool()],
    }) as unknown as Extension;
    this.#registry.install(this.toolsExtension);
    this.#registry.install(
      defineExtension({
        name: "synara-chat-profile",
        sections: [
          section("profile", async (input) =>
            ((await this.#conversationCompany(input.conversationId)) ? GLASSWING_AGENT_SYSTEM_PROMPT : "You are a helpful coding agent."), { tag: false }),
          section("harness_policy", () => renderSynaraHarnessPolicy({ gatewayControlAvailable: this.#options.gatewayUrl !== undefined }), { tag: false }),
          // The Glasswing context pack (firm, person and deal memory), after the static sections so they stay cacheable.
          section("glasswing_context", (input) => {
            const thread = this.#byConversation.get(input.conversationId);
            return thread && !thread.route ? this.#contextPacks.prompt(thread.threadId) : undefined;
          }),
          section("environment", (input) => `Current date: ${today()}\nCurrent working directory: ${input.env?.cwd ?? "unknown"}`),
        ],
      }) as unknown as Extension,
    );
    await configurePiWebAccess(this.#options.agentDir);
    const [web, crunchbase] = await Promise.all([
      createWebAccessTools().catch((cause) => {
        console.warn(JSON.stringify({ event: "durable.web-tools.unavailable", message: String(cause) }));
        return [];
      }),
      createCrunchbaseTools().catch((cause) => {
        console.warn(JSON.stringify({ event: "durable.crunchbase-tools.unavailable", message: String(cause) }));
        return [];
      }),
    ]);
    this.researchExtension = defineExtension({
      name: "synara-research",
      tools: [...web, ...crunchbase, ...createPerplexityTools()],
    }) as unknown as Extension;
    this.#registry.install(this.researchExtension);

    // A lost volume (or a forced drill) restores the newest off-volume snapshot before opening.
    await restoreHarnessIfNeeded(this.#options.storagePath, process.env.SYNARA_DURABLE_RESTORE === "1");
    this.#harness = await Harness.open(
      // pi-durable's own open unless SYNARA_HARNESS_LOCKING_MODE=exclusive (harnessStorage.ts).
      await openHarnessStorage(this.#options.storagePath),
      {
        models: this.#models,
        registry: this.#registry,
        settings: {
          compaction: { reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 },
          retry: { maxRetries: 3 },
        } as never,
        env: async (target) => {
          const registered = this.#conversationTargets.get(target.conversationId);
          if (registered) return this.#targetEnv(`synara-conversation:${target.conversationId}`, registered.cwd, registered.resolve);
          const thread = this.#byConversation.get(target.conversationId);
          if (!thread) return undefined;
          return this.#lazyEnv(thread);
        },
        onReport: (error) => console.warn(JSON.stringify({ event: "durable.extension.report", message: String(error) })),
      },
      ctx,
    );
    const index = (await this.#harness.snapshot(ThreadIndex, ctx)) ?? { threads: {} };
    for (const [threadId, entry] of Object.entries(index.threads)) {
      const conversationId = entry.conversationId as ConversationId;
      const state = this.#state(threadId, conversationId, entry.generation, entry.cwd);
      if (entry.route) state.route = entry.route;
      if (entry.unfenced) state.unfenced = true;
      // The live document alone says whether a turn was running; watching every thread here would
      // load every conversation's context into memory.
      const live = (await this.#harness.snapshot(LiveDoc, conversationId, ctx)) as { run?: { inputs?: SubmissionId[] } } | undefined;
      const inputs = live?.run?.inputs ?? [];
      if (inputs.length > 0) {
        // Restart during a turn: re-attach to the running work before the scheduler continues it.
        await this.#watch(state);
        const submission = await this.#harness.submission(inputs[0]!, ctx);
        const record = submission ? await submission.status(ctx) : undefined;
        // A chat turn's fallback request is `<turnId>:fallback`; the turn keeps its own ID.
        const turnId = TurnId.makeUnsafe((record?.requestId ?? crypto.randomUUID()).replace(/:fallback$/u, ""));
        state.activeTurnId = turnId;
        state.turns.push(turnId);
        // Diligence steps fall back in the runner; every other turn falls back here.
        if (submission) this.#settleWhenDone(state, turnId, submission.id, !record?.requestId?.startsWith("diligence:"));
        resumingDurableThreads.add(threadId);
        console.info(JSON.stringify({ event: "durable.turn.resumed", threadId, turnId }));
      }
    }
    this.#harness.resume();
    this.#stopBackups = startHarnessBackups(this.#options.storagePath);
    setDurableEngineGauges({
      openWatches: () => this.openWatchCount(),
      activeConversations: () => [...this.#threads.values()].filter((thread) => thread.activeTurnId).length,
    });
    console.info(JSON.stringify({
      event: "durable.engine.ready",
      threads: this.#threads.size,
      resumed: [...this.#threads.values()].filter((thread) => thread.activeTurnId).length,
      tools: this.#registry.snapshot().tools().map((entry) => entry.tool.name),
    }));
    const fallbackTargets = [FALLBACK_OPUS_MODEL, FALLBACK_SONNET_MODEL];
    logEvent(fallbackTargets.every((ref) => this.#models.getModel(ref.provider, ref.modelId)) ? "info" : "warn", "llm.fallback.config", {
      system: "synara-controller",
      opus: refText(FALLBACK_OPUS_MODEL),
      sonnet: refText(FALLBACK_SONNET_MODEL),
      available: fallbackTargets.filter((ref) => this.#models.getModel(ref.provider, ref.modelId)).map(refText),
      force_anthropic_failure: anthropicFailureForced(),
    });
  }

  toolsExtension!: Extension;
  researchExtension!: Extension;
  readonly #conversationTargets = new Map<ConversationId, { cwd: string; resolve: () => Promise<DurableThreadTarget | undefined> }>();

  /** The Harness, for durable work beyond chat threads (diligence runs). */
  get harness(): HarnessType {
    return this.#harness;
  }

  get models() {
    return this.#models;
  }

  /** The Glasswing company of a thread's project; positive answers are kept, negative ones retried after a minute. */
  #companyOf(threadId: string): Promise<string | undefined> {
    const resolve = this.#options.resolveCompany;
    if (!resolve) return Promise.resolve(undefined);
    const cached = this.#companies.get(threadId);
    if (cached && Date.now() - cached.at < COMPANY_LOOKUP_RETRY_MS) return cached.companyId;
    const companyId = resolve(threadId).catch((cause: unknown) => {
      console.warn(JSON.stringify({ event: "durable.company.lookup-failed", threadId, message: String(cause).slice(0, 300) }));
      this.#companies.delete(threadId);
      return undefined;
    });
    this.#companies.set(threadId, { at: Date.now(), companyId });
    void companyId.then((found) => {
      if (found && this.#companies.get(threadId)?.companyId === companyId) this.#companies.set(threadId, { at: Number.POSITIVE_INFINITY, companyId });
    });
    return companyId;
  }

  async #conversationCompany(conversationId: ConversationId) {
    const thread = this.#byConversation.get(conversationId);
    return thread && !thread.route ? this.#companyOf(thread.threadId) : undefined;
  }

  /** Fetches the thread's context pack at a session's first turn and when it is older than 30 minutes. */
  async #refreshContextPack(state: ThreadState, author: OrchestrationMessageAuthor | undefined) {
    if (state.route) return;
    const companyId = await this.#companyOf(state.threadId);
    if (companyId) await this.#contextPacks.refresh(state.threadId, { companyId, requesterEmail: requesterEmailOf(author) });
  }

  /** The thread's current context pack, for sandbox labels. */
  contextPackId(threadId: string) {
    return this.#contextPacks.packId(threadId);
  }

  /** Routes a non-thread conversation's tools to a sandbox (diligence steps). */
  registerConversationTarget(conversationId: ConversationId, cwd: string, resolve: () => Promise<DurableThreadTarget | undefined>) {
    this.#conversationTargets.set(conversationId, { cwd, resolve });
  }

  #targetEnv(id: string, cwd: string, resolveTarget: () => Promise<DurableThreadTarget | undefined>) {
    let resolved: Promise<DurableThreadTarget> | undefined;
    const resolve = () => {
      resolved ??= resolveTarget().then((target) => {
        if (!target) throw new Error("This conversation has no sandbox for files or commands.");
        return target;
      });
      return resolved;
    };
    return new SandboxExecutionEnv({
      id,
      cwd,
      runner: {
        run: async (command, options) => (await resolve()).runner.run(command, options),
        upload: async (filePath, data) => (await resolve()).runner.upload(filePath, data),
      },
    });
  }

  /** The environment object is cheap; it reaches the sandbox only when a tool calls it. */
  #lazyEnv(thread: ThreadState) {
    let resolved: Promise<DurableThreadTarget> | undefined;
    const resolve = () => {
      resolved ??= this.#options.target(thread.threadId).then((target) => {
        if (!target) throw new Error("This conversation has no sandbox for files or commands.");
        return target;
      });
      return resolved;
    };
    const runner: SandboxRunner = {
      run: async (command, options) => (await resolve()).runner.run(command, options),
      upload: async (filePath, data) => (await resolve()).runner.upload(filePath, data),
    };
    return new SandboxExecutionEnv({ id: `synara-thread:${thread.threadId}`, cwd: thread.cwd, runner });
  }

  #state(threadId: string, conversationId: ConversationId, generation: string, cwd: string): ThreadState {
    const existing = this.#threads.get(threadId);
    if (existing) return existing;
    const state: ThreadState = {
      threadId,
      conversationId,
      lifecycleGeneration: generation,
      cwd,
      createdAt: new Date().toISOString(),
      turns: [],
      tools: new Map(),
      partial: new Map(),
      watching: false,
      stopped: false,
    };
    this.#threads.set(threadId, state);
    this.#byConversation.set(conversationId, state);
    return state;
  }

  async #conversation(state: ThreadState): Promise<Conversation> {
    const conversation = await this.#harness.conversation(state.conversationId, ctx);
    if (!conversation) throw new Error(`Durable conversation ${state.conversationId} is missing.`);
    return conversation;
  }

  #modelList: { at: number; value: ProviderListModelsResult } | undefined;

  /** Models for Synara's picker: Pi's catalog, Anthropic intersected with the live account list. */
  async listModels(): Promise<ProviderListModelsResult> {
    if (this.#modelList && Date.now() - this.#modelList.at < 10 * 60_000) return this.#modelList.value;
    let liveAnthropic: Set<string> | undefined;
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) {
      try {
        const response = await fetch("https://api.anthropic.com/v1/models?limit=100", {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) liveAnthropic = new Set(((await response.json()) as { data?: Array<{ id: string }> }).data?.map((model) => model.id));
      } catch {
        liveAnthropic = undefined;
      }
    }
    const names: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI" };
    const models = ["anthropic", "openai"]
      .filter((provider) => this.#models.getProvider(provider))
      .flatMap((provider) => this.#models.getModels(provider))
      .filter((model) => model.provider !== "anthropic" || !liveAnthropic?.size || liveAnthropic.has(model.id))
      .flatMap((model) => {
        const descriptor = toPiProviderModelDescriptor(model, (provider) => names[provider] ?? provider);
        return descriptor ? [descriptor] : [];
      });
    const value = { models, source: liveAnthropic?.size ? "pi.durable+anthropic.models" : "pi.durable", cached: false } satisfies ProviderListModelsResult;
    this.#modelList = { at: Date.now(), value };
    return value;
  }

  isDurableThread(threadId: string) {
    return this.#threads.has(threadId);
  }

  // ---------------------------------------------------------------- requests

  async startSession(input: DurableStartInput): Promise<ProviderSession> {
    let state = this.#threads.get(input.threadId);
    if (!state) {
      const conversation = await this.#harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: DEFAULT_MODEL, thinkingLevel: "medium" as never, cwd: input.cwd } },
        ctx,
      );
      state = this.#state(input.threadId, conversation.id, input.lifecycleGeneration, input.cwd);
    }
    state.lifecycleGeneration = input.lifecycleGeneration;
    state.cwd = input.cwd;
    state.stopped = false;
    this.#contextPacks.reset(input.threadId);
    if (input.unfenced) state.unfenced = true;
    await this.#harness.commit(async (tx) => {
      const index = await tx.doc(ThreadIndex);
      index.threads[input.threadId] = {
        conversationId: state.conversationId as number, generation: input.lifecycleGeneration, cwd: input.cwd,
        ...(state.unfenced ? { unfenced: true } : {}),
      };
    }, ctx);
    const conversation = await this.#conversation(state);
    await conversation.configure({ cwd: input.cwd }, ctx);
    await this.#applyModel(state, conversation, input.modelSelection);
    // Turns open their own watch; an idle session holds none.
    if (state.activeTurnId) await this.#watch(state);
    const session = this.#session(state, input.runtimeMode);
    this.#emit(state, { type: "session.started", payload: { message: "Durable Pi session ready", resume: session.resumeCursor } });
    this.#emit(state, { type: "thread.started", payload: { providerThreadId: `durable-${state.conversationId}` } });
    return session;
  }

  /**
   * Moves a worker-era thread onto the durable runtime: rebuilds the exact model context of its Pi
   * session file (compaction, branches and context edits applied) as durable entries. The original
   * file is not changed.
   */
  async importLegacySession(input: DurableStartInput & { readonly sessionJsonl: string }): Promise<{ readonly messages: number }> {
    if (this.#threads.has(input.threadId)) return { messages: 0 };
    const sdk = await import("@earendil-works/pi-coding-agent");
    const fileEntries = sdk.parseSessionEntries(input.sessionJsonl);
    sdk.migrateSessionEntries(fileEntries);
    const entries = fileEntries.filter((entry): entry is Exclude<typeof entry, { type: "session" }> => entry.type !== "session");
    const context = sdk.buildSessionContext(entries as never);
    const messages = sdk.convertToLlm(context.messages).filter((message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult");
    const model = context.model ? { provider: context.model.provider, modelId: context.model.modelId } : DEFAULT_MODEL;
    const conversation = await this.#harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model, thinkingLevel: (context.thinkingLevel || "medium") as never, cwd: input.cwd } },
      ctx,
    );
    await this.#harness.commit(async (tx) => {
      for (const message of messages) {
        if (message.role === "user") await tx.appendEntry(UserEntry, conversation.id, { model: [message] });
        else if (message.role === "assistant") await tx.appendEntry(AssistantEntry, conversation.id, { model: [message] });
        else await tx.appendEntry(ToolResultEntry, conversation.id, { model: [message], data: { diagnostics: [] } });
      }
      const index = await tx.doc(ThreadIndex);
      index.threads[input.threadId] = { conversationId: conversation.id as number, generation: input.lifecycleGeneration, cwd: input.cwd };
    }, ctx);
    const state = this.#state(input.threadId, conversation.id, input.lifecycleGeneration, input.cwd);
    state.model = `${model.provider}/${model.modelId}`;
    console.info(JSON.stringify({ event: "durable.legacy.imported", threadId: input.threadId, messages: messages.length, sessionEntries: entries.length }));
    return { messages: messages.length };
  }

  /** Configures the selected model; true when there was a selection to apply. */
  async #applyModel(state: ThreadState, conversation: Conversation, selection: DurableStartInput["modelSelection"]) {
    if (selection?.provider !== "pi") return false;
    const model = modelRefOf(selection.model);
    if (!model) return false;
    if (!this.#models.getModel(model.provider, model.modelId)) throw new Error(`Pi model '${selection.model}' is not available.`);
    const thinkingLevel = thinkingLevelOf(selection.options);
    await conversation.configure({ model, ...(thinkingLevel ? { thinkingLevel: thinkingLevel as never } : {}) }, ctx);
    state.model = `${model.provider}/${model.modelId}`;
    return true;
  }

  /** How fallbacks name this thread's work: chat, or the diligence step a step thread shows. */
  #feature(state: ThreadState) {
    return state.route ? `diligence:${state.route.providerThreadId.replace(/^step:/u, "")}` : "chat";
  }

  /**
   * A new turn starts on the thread's own model: one a fallback replaced comes back once the probe
   * has closed the circuit. While it is open, an Anthropic model goes straight to OpenAI.
   */
  async #routeTurn(state: ThreadState, conversation: Conversation, selected: boolean) {
    state.turnModel = undefined;
    if (state.restoreModel) {
      if (!selected) await conversation.configure({ model: state.restoreModel }, ctx);
      state.restoreModel = undefined;
    }
    const open = anthropicCircuit.current();
    if (open) await this.#fallBack(state, conversation, (await conversation.agent(ctx)).model, open);
  }

  /** Moves the conversation from its Anthropic model to the OpenAI fallback and flags it. */
  async #fallBack(state: ThreadState, conversation: Conversation, from: ModelRef | undefined, failure: ProviderFailure) {
    const to = fallbackModelFor(from);
    if (!from || !to) return false;
    if (!this.#models.getModel(to.provider, to.modelId)) {
      logEvent("warn", "llm.fallback.unavailable", { system: "synara-controller", feature: this.#feature(state), from_model: refText(from), to_model: refText(to), reason: failure.reason });
      return false;
    }
    await conversation.configure({ model: to }, ctx);
    state.restoreModel ??= from;
    state.turnModel = refText(to);
    logFallback(this.#feature(state), from, to, failure);
    this.#emit(state, {
      type: "model.rerouted",
      payload: { fromModel: refText(from), toModel: refText(to), reason: describeFailure(failure) },
    });
    return true;
  }

  /**
   * After an Anthropic turn failed in a way another provider can fix, the turn continues on OpenAI:
   * returns the continuation's submission, or undefined when the failure stands.
   */
  async #fallbackAfterFailure(state: ThreadState, turnId: TurnId, detail: string | undefined) {
    const failure = classifyAnthropicFailure(detail);
    if (!failure) return undefined;
    const conversation = await this.#conversation(state);
    const from = (await conversation.agent(ctx)).model;
    if (from?.provider !== "anthropic") return undefined;
    anthropicCircuit.trip(failure, this.#feature(state), from);
    if (!(await this.#fallBack(state, conversation, from, failure))) return undefined;
    return (await conversation.submit({ type: "input", content: CONTINUE_PROMPT, requestId: `${turnId}:fallback` }, ctx)).id;
  }

  /** A diligence step moved models (the runner moves its own steps); shows it in the step's thread. */
  noteReroute(key: string, fromModel: string, toModel: string, reason: string) {
    const state = this.#threads.get(key);
    if (state) this.#emit(state, { type: "model.rerouted", payload: { fromModel, toModel, reason } });
  }

  async #content(input: DurableTurnInput): Promise<string | Array<TextContent | ImageContent>> {
    const text =
      appendFileAttachmentsPromptBlock({
        text: input.input,
        attachments: input.attachments,
        attachmentsDir: input.attachmentsDir,
        include: "all-files",
      }) ?? "";
    const providerText = [
      input.repositoryUnavailable
        ? "Company files are currently unavailable and all tools are disabled for this turn. Continue conversation using only the messages provided. Do not claim to have read, verified, edited or saved company files, or started diligence. If the request needs those operations, explain the limitation; do not invent file contents."
        : null,
      (await this.#companyOf(input.threadId)) ? renderGlasswingMessageAuthorContext(input.author) : null,
      text,
    ]
      .filter(Boolean)
      .join("\n\n");
    const images: ImageContent[] = [];
    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image" || !attachment.mimeType) continue;
      const bytes = await this.#options.readAttachment(attachment);
      if (bytes) images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: attachment.mimeType });
    }
    return images.length === 0 ? providerText : [{ type: "text", text: providerText }, ...images];
  }

  async sendTurn(input: DurableTurnInput): Promise<{ threadId: ThreadId; turnId: TurnId; resumeCursor: string }> {
    const state = this.#require(input.threadId);
    if (state.activeTurnId) throw new Error("A Pi turn is already active for this thread.");
    const conversation = await this.#conversation(state);
    const selected = await this.#applyModel(state, conversation, input.modelSelection);
    if (input.gatewayBearerToken) {
      state.gatewayToken = input.gatewayBearerToken;
      await this.#installGatewayTools(input.gatewayBearerToken);
    }
    await conversation.configure({ tools: input.repositoryUnavailable ? [] : null }, ctx);
    await this.#refreshContextPack(state, input.author);
    const content = await this.#content(input);
    const turnId = TurnId.makeUnsafe(crypto.randomUUID());
    const usageBefore = await this.#usageTotals(state).catch(() => undefined);
    state.activeTurnId = turnId;
    state.turnStartedAt = Date.now();
    state.turnInfo = { startedAt: state.turnStartedAt, author: input.author, usageBefore, tools: {} };
    state.turns.push(turnId);
    await this.#watch(state);
    this.#emitTurnStarted(state);
    await this.#routeTurn(state, conversation, selected).catch((cause: unknown) =>
      logEvent("warn", "llm.route-failed", { threadId: state.threadId, message: String(cause).slice(0, 300) }));
    const submission = await conversation.submit({ type: "input", content, requestId: turnId, whenBusy: "reject" }, ctx);
    this.#settleWhenDone(state, turnId, submission.id, true);
    return { threadId: input.threadId, turnId, resumeCursor: this.#cursor(state) };
  }

  async steerTurn(input: DurableTurnInput): Promise<{ threadId: ThreadId; turnId: TurnId; resumeCursor: string }> {
    const state = this.#require(input.threadId);
    if (!state.activeTurnId) return this.sendTurn(input);
    const conversation = await this.#conversation(state);
    const content = await this.#content(input);
    await conversation.submit({ type: "input", content, requestId: `steer-${crypto.randomUUID()}`, whenBusy: "steer" }, ctx);
    return { threadId: input.threadId, turnId: state.activeTurnId, resumeCursor: this.#cursor(state) };
  }

  async interruptTurn(threadId: string, turnId?: string) {
    const state = this.#threads.get(threadId);
    if (!state?.activeTurnId || (turnId !== undefined && turnId !== state.activeTurnId)) return;
    await (await this.#conversation(state)).abort(ctx);
  }

  async stopSession(threadId: string) {
    const state = this.#threads.get(threadId);
    if (!state) return;
    if (state.activeTurnId) await (await this.#conversation(state)).abort(ctx);
    state.stopped = true;
    if (!state.activeTurnId) void this.#unwatch(state);
    this.#emit(state, { type: "thread.state.changed", payload: { state: "closed" } });
    this.#emit(state, { type: "session.exited", payload: { reason: "stopped", exitKind: "graceful" } });
  }

  listSessions(): ProviderSession[] {
    return [...this.#threads.values()].filter((state) => !state.stopped && !state.route).map((state) => this.#session(state));
  }

  hasSession(threadId: string) {
    const state = this.#threads.get(threadId);
    return state !== undefined && !state.stopped && !state.route;
  }

  generationOf(threadId: string) {
    return this.#threads.get(threadId)?.lifecycleGeneration;
  }

  // ------------------------------------------------- child and external turns

  /** Shows an existing conversation (a diligence step) as a child thread of `route.parentThreadId`. */
  async attachChild(input: { readonly key: string; readonly conversationId: ConversationId; readonly cwd: string; readonly route: ThreadRoute; readonly model?: string | undefined }) {
    const existing = this.#threads.get(input.key);
    if (existing) return;
    const state = this.#state(input.key, input.conversationId, this.#threads.get(input.route.parentThreadId)?.lifecycleGeneration ?? "child", input.cwd);
    state.route = input.route;
    if (input.model) state.model = input.model;
    await this.#harness.commit(async (tx) => {
      const index = await tx.doc(ThreadIndex);
      index.threads[input.key] = { conversationId: input.conversationId as number, generation: state.lifecycleGeneration, cwd: input.cwd, route: input.route };
    }, ctx);
    // `runChildTurn` opens the watch when the step's turn starts.
  }

  /**
   * Runs one request on a child conversation as a visible turn. The request ID makes it idempotent:
   * after a restart the same request re-attaches to its running submission.
   */
  async runChildTurn(key: string, content: string, requestId: string) {
    const state = this.#require(key);
    const turnId = TurnId.makeUnsafe(requestId);
    // An analyst's follow-up runs to completion first.
    while (state.activeTurnId && state.activeTurnId !== turnId) await new Promise((resolve) => setTimeout(resolve, 500));
    const conversation = await this.#conversation(state);
    if (state.activeTurnId !== turnId) {
      state.activeTurnId = turnId;
      state.turnStartedAt = Date.now();
      state.turnInfo = { startedAt: state.turnStartedAt, tools: {} };
      state.turns.push(turnId);
      await this.#watch(state);
      this.#emitTurnStarted(state);
    }
    const submission = await conversation.submit({ type: "input", content, requestId }, ctx);
    // The diligence runner falls back for its own steps.
    this.#settleWhenDone(state, turnId, submission.id, false);
    return submission;
  }

  /** Opens a turn on a thread whose work happens elsewhere (the diligence run thread). */
  beginExternalTurn(threadId: string, turnId: string, announce: boolean) {
    const state = this.#require(threadId);
    const id = TurnId.makeUnsafe(turnId);
    state.externalTurnId = id;
    if (state.activeTurnId === id) return;
    state.activeTurnId = id;
    state.turns.push(id);
    if (announce) this.#emitTurnStarted(state);
  }

  /** Publishes an event in the thread's external turn. */
  emitExternal(threadId: string, event: { type: string; payload: unknown; itemId?: string; providerRefs?: unknown }) {
    const state = this.#require(threadId);
    this.#emit(state, { ...event, itemId: event.itemId === undefined ? undefined : RuntimeItemId.makeUnsafe(event.itemId), turnId: state.externalTurnId ?? null });
  }

  /** Posts a complete assistant message in the thread's external turn. */
  emitExternalMessage(threadId: string, id: string, text: string) {
    const itemId = `external-message-${id}`;
    this.emitExternal(threadId, { type: "item.started", itemId, payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" } });
    this.emitExternal(threadId, { type: "content.delta", itemId, payload: { streamKind: "assistant_text", delta: text, contentIndex: 0 } });
    this.emitExternal(threadId, { type: "item.completed", itemId, payload: { itemType: "assistant_message", status: "completed", title: "Assistant" } });
  }

  endExternalTurn(threadId: string, status: "completed" | "interrupted" | "failed", errorMessage?: string) {
    const state = this.#threads.get(threadId);
    const turnId = state?.externalTurnId;
    if (!state || !turnId) return;
    state.externalTurnId = undefined;
    if (state.activeTurnId === turnId) state.activeTurnId = undefined;
    this.#emit(state, {
      type: "turn.completed",
      turnId,
      payload: status === "completed" ? { state: "completed", stopReason: null }
        : status === "interrupted" ? { state: "interrupted", stopReason: "aborted", errorMessage: errorMessage ?? "Stopped." }
          : { state: "failed", stopReason: "error", errorMessage: errorMessage ?? "Failed." },
    });
  }

  hasExternalTurn(threadId: string) {
    return this.#threads.get(threadId)?.externalTurnId !== undefined;
  }

  readThread(threadId: string) {
    const state = this.#require(threadId);
    return { threadId: ThreadId.makeUnsafe(threadId), turns: state.turns.map((id) => ({ id, items: [] })), cwd: state.cwd };
  }

  async compactThread(threadId: string) {
    await (await this.#conversation(this.#require(threadId))).compact(undefined, ctx);
  }

  async close() {
    this.#stopBackups?.();
    await this.#harness.close(ctx);
    await backupHarness(this.#options.storagePath).catch((cause) =>
      console.warn(JSON.stringify({ event: "durable.backup.failed", message: describe(cause) })));
  }

  /** Takes one backup now, changed or not; used by the restore drill. */
  backupNow() {
    return backupHarness(this.#options.storagePath, { force: true });
  }

  // ------------------------------------------------------------------ helpers

  #require(threadId: string) {
    const state = this.#threads.get(threadId);
    if (!state) throw new Error(`No durable Pi session for thread ${threadId}.`);
    return state;
  }

  #cursor(state: ThreadState) {
    return `pi-durable:${state.conversationId}`;
  }

  #session(state: ThreadState, runtimeMode: ProviderSession["runtimeMode"] = "full-access"): ProviderSession {
    return {
      provider: PROVIDER,
      status: state.activeTurnId ? "running" : "ready",
      runtimeMode,
      threadId: ThreadId.makeUnsafe(state.threadId),
      createdAt: state.createdAt as never,
      updatedAt: new Date().toISOString() as never,
      cwd: state.cwd,
      ...(state.model ? { model: state.model } : {}),
      resumeCursor: this.#cursor(state),
      ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
    } as ProviderSession;
  }

  async #installGatewayTools(token: string) {
    if (this.#gatewayExtensionInstalled || !this.#options.gatewayUrl) return;
    const catalog = await listAgentGatewayMcpTools({ connection: { url: this.#options.gatewayUrl, bearerToken: token } });
    for (const tool of catalog) {
      this.#gatewayTools.set(
        tool.name,
        defineTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema as unknown as TSchema,
          execute: async (args, api) => {
            const thread = this.#byConversation.get(api.conversationId);
            if (!thread?.gatewayToken || !this.#options.gatewayUrl) throw new Error("Synara gateway is unavailable for this thread.");
            const result = (await callAgentGatewayMcpTool({
              connection: { url: this.#options.gatewayUrl, bearerToken: thread.gatewayToken },
              name: tool.name,
              arguments: args as Record<string, unknown>,
            })) as { isError?: boolean; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
            const content = (result?.content ?? []).flatMap((item): Array<TextContent | ImageContent> =>
              item.type === "text" && typeof item.text === "string"
                ? [{ type: "text", text: item.text }]
                : item.type === "image" && typeof item.data === "string"
                  ? [{ type: "image", data: item.data, mimeType: item.mimeType ?? "image/png" }]
                  : [],
            );
            if (result?.isError) throw new Error(content.map((item) => (item.type === "text" ? item.text : "")).join("\n") || "Synara gateway tool failed.");
            return { content: content.length > 0 ? content : [{ type: "text", text: JSON.stringify(result ?? null) }] };
          },
        }) as unknown as ToolRegistration,
      );
    }
    this.#registry.install(defineExtension({ name: "synara-gateway", tools: [...this.#gatewayTools.values()] }) as unknown as Extension);
    this.#gatewayExtensionInstalled = true;
  }

  #emit(state: ThreadState, event: { type: string; payload: unknown; itemId?: RuntimeItemId | undefined; providerRefs?: unknown; turnId?: TurnId | null }) {
    const { turnId, itemId, providerRefs, ...rest } = event;
    const resolvedTurn = turnId === null ? undefined : (turnId ?? state.activeTurnId);
    const route = state.route;
    const parent = route ? this.#threads.get(route.parentThreadId) : undefined;
    const refs = route
      ? { ...(providerRefs as object | undefined), providerThreadId: route.providerThreadId, providerParentThreadId: route.parentThreadId }
      : providerRefs;
    this.#options.publish({
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      provider: PROVIDER,
      threadId: ThreadId.makeUnsafe(route ? route.parentThreadId : state.threadId),
      createdAt: new Date().toISOString(),
      ...((route ? parent?.unfenced : state.unfenced) ? {} : { lifecycleGeneration: parent?.lifecycleGeneration ?? state.lifecycleGeneration }),
      ...(resolvedTurn ? { turnId: resolvedTurn } : {}),
      ...(itemId ? { itemId } : {}),
      ...(refs ? { providerRefs: refs } : {}),
      ...rest,
      raw: { source: "pi.sdk.event", messageType: "pi.durable", payload: null },
    } as unknown as ProviderRuntimeEvent);
  }

  #emitTurnStarted(state: ThreadState) {
    this.#emit(state, { type: "thread.state.changed", payload: { state: "active" } });
    this.#emit(state, { type: "turn.started", payload: { ...(state.model ? { model: state.model } : {}) } });
  }

  async #watch(state: ThreadState) {
    if (state.watching) return;
    state.watching = true;
    let stream: Awaited<ReturnType<typeof watchEvents>>;
    try {
      stream = await watchEvents(this.#harness, state.conversationId, ctx);
    } catch (cause) {
      state.watching = false;
      throw cause;
    }
    state.watch = stream;
    stream.start(async (events) => {
      for (const event of events) this.#onEvent(state, event);
    });
    void stream.closed.then(() => {
      if (state.watch !== stream) return;
      state.watch = undefined;
      state.watching = false;
    });
  }

  /** Closes the thread's watch, which drops its conversation view from memory. */
  async #unwatch(state: ThreadState) {
    const stream = state.watch;
    if (!stream) return;
    state.watch = undefined;
    state.watching = false;
    await stream.stop().catch((cause: unknown) =>
      logEvent("warn", "durable.watch.stop-failed", { threadId: state.threadId, message: String(cause).slice(0, 300) }));
  }

  /** Open event watches; each holds one conversation view in memory. */
  openWatchCount() {
    let count = 0;
    for (const state of this.#threads.values()) if (state.watch) count++;
    return count;
  }

  /**
   * Forgets a finished diligence run's step threads and step tool routes. A follow-up message to a
   * step attaches it again (`attachChild`, `registerConversationTarget`).
   */
  forgetRun(parentThreadId: string | undefined, conversationIds: ReadonlyArray<number>) {
    for (const id of conversationIds) {
      const thread = this.#byConversation.get(id as ConversationId);
      if (thread?.activeTurnId) continue;
      this.#conversationTargets.delete(id as ConversationId);
    }
    if (!parentThreadId) return;
    // Deleting the current entry while iterating a Map is safe.
    for (const state of this.#threads.values()) {
      if (state.route?.parentThreadId !== parentThreadId || state.activeTurnId) continue;
      void this.#unwatch(state);
      this.#threads.delete(state.threadId);
      if (this.#byConversation.get(state.conversationId) === state) this.#byConversation.delete(state.conversationId);
    }
  }

  async #usageTotals(state: ThreadState): Promise<UsageTotals> {
    const usage = (await this.#harness.snapshot(UsageDoc, state.conversationId, ctx)) as
      | { models?: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }> }
      | undefined;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const model of Object.values(usage?.models ?? {})) {
      costUsd += model.cost?.total ?? 0;
      inputTokens += (model.input ?? 0) + (model.cacheRead ?? 0) + (model.cacheWrite ?? 0);
      outputTokens += model.output ?? 0;
    }
    return { costUsd, inputTokens, outputTokens };
  }

  #onEvent(state: ThreadState, event: AgentEvent) {
    if (!state.activeTurnId) return;
    switch (event.type) {
      case "message_start": {
        if ((event.message as { role?: string }).role !== "assistant") return;
        state.partial.clear();
        // One Harness commit can create the message and write its first text, and then
        // message_start carries that text while the next message_update holds only what
        // follows. Start from the message as it stands, so the deltas extend it rather than
        // standing in for it (a later full-message change would otherwise slice the final
        // text at the deltas' length and splice it).
        const message = event.message as AssistantMessage;
        if (Array.isArray(message.content) && message.content.length > 0) {
          this.#applyChange(state, { type: "message", message } as MessageChange);
          this.#flushPartial(state);
        }
        return;
      }
      case "message_update":
        for (const change of event.changes) this.#applyChange(state, change);
        this.#flushPartial(state);
        return;
      case "tool_execution_start": {
        const itemId = RuntimeItemId.makeUnsafe(`pi-tool-${event.toolCallId}`);
        const tracked = { itemId, toolName: event.toolName, args: event.args, itemType: toolItemType(event.toolName) };
        state.tools.set(event.toolCallId, tracked);
        this.#emit(state, {
          type: "item.started",
          itemId,
          providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
          payload: {
            itemType: tracked.itemType,
            status: "inProgress",
            title: toolTitle(event.toolName, event.args),
            data: toolLifecycleData({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }),
          },
        });
        return;
      }
      case "tool_execution_end": {
        const tracked = state.tools.get(event.toolCallId) ?? {
          itemId: RuntimeItemId.makeUnsafe(`pi-tool-${event.toolCallId}`),
          toolName: event.toolName,
          args: undefined,
          itemType: toolItemType(event.toolName),
        };
        state.tools.delete(event.toolCallId);
        if (state.turnInfo) state.turnInfo.tools[event.toolName] = (state.turnInfo.tools[event.toolName] ?? 0) + 1;
        const message = event.entry?.model?.[0] as { content?: unknown; isError?: boolean } | undefined;
        const result = toolResultForDisplay({ content: message?.content ?? [], details: event.entry?.data });
        const isError = message?.isError === true || event.entry === undefined;
        const detail = textFromToolResult(result);
        this.#emit(state, {
          type: "item.completed",
          itemId: tracked.itemId,
          providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
          payload: {
            itemType: tracked.itemType,
            status: isError ? "failed" : "completed",
            title: toolTitle(event.toolName, tracked.args),
            ...(detail ? { detail } : {}),
            data: toolLifecycleData({ toolCallId: event.toolCallId, toolName: event.toolName, args: tracked.args, result, isError }),
          },
        });
        return;
      }
      case "compaction_start":
        this.#emit(state, { type: "item.updated", itemId: RuntimeItemId.makeUnsafe(`pi-compaction-${event.taskId}`), payload: { itemType: "context_compaction", status: "inProgress", title: "Compacting context" } });
        return;
      case "compaction_end":
        this.#emit(state, { type: "item.completed", itemId: RuntimeItemId.makeUnsafe(`pi-compaction-${event.taskId}`), payload: { itemType: "context_compaction", status: "completed", title: "Context compacted" } });
        return;
      case "message_end": {
        const message = event.entry.model?.[0] as AssistantMessage | undefined;
        if (message?.role !== "assistant") return;
        this.#applyChange(state, { type: "message", message } as MessageChange);
        this.#flushPartial(state);
        state.partial.clear();
        state.lastUsage = this.#usage(message);
        return;
      }
      default:
        return;
    }
  }

  #applyChange(state: ThreadState, change: MessageChange) {
    const setBlock = (index: number, block: { type: string; text?: string; thinking?: string }) => {
      const kind = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : undefined;
      if (!kind) return;
      const text = (kind === "text" ? block.text : block.thinking) ?? "";
      const current = state.partial.get(index);
      // What this block has already streamed must be the start of its text; the flush
      // sends only the rest. If it is not, the message on screen no longer matches what
      // the model wrote: say so, since a delta cannot take streamed text back.
      const sent = current?.kind === kind ? current.text.slice(0, current.emitted) : "";
      if (sent.length > 0 && !text.startsWith(sent)) {
        logEvent("warn", "durable.text.diverged", {
          threadId: state.threadId,
          turnId: state.activeTurnId,
          contentIndex: index,
          kind,
          sentChars: sent.length,
          textChars: text.length,
          model: state.turnModel ?? state.model,
        });
      }
      state.partial.set(index, { kind, text, emitted: Math.min(sent.length, text.length) });
    };
    switch (change.type) {
      case "text_start":
      case "thinking_start":
      case "block":
        setBlock(change.contentIndex, change.block as never);
        return;
      case "text_delta":
      case "thinking_delta": {
        const current = state.partial.get(change.contentIndex) ?? {
          kind: change.type === "text_delta" ? ("text" as const) : ("thinking" as const),
          text: "",
          emitted: 0,
        };
        current.text += change.delta;
        state.partial.set(change.contentIndex, current);
        return;
      }
      case "message":
        change.message.content.forEach((block, index) => setBlock(index, block as never));
        return;
      default:
        return;
    }
  }

  /** Emits the not-yet-emitted suffix of each text and thinking block as Synara content deltas. */
  #flushPartial(state: ThreadState) {
    for (const [contentIndex, block] of [...state.partial.entries()].sort(([a], [b]) => a - b)) {
      if (block.text.length <= block.emitted) continue;
      const delta = block.text.slice(block.emitted);
      block.emitted = block.text.length;
      if (block.kind === "text") {
        if (state.turnInfo && state.turnInfo.firstTextAt === undefined) state.turnInfo.firstTextAt = Date.now();
        if (!state.assistantItemId) {
          state.assistantItemId = RuntimeItemId.makeUnsafe(`pi-assistant-${crypto.randomUUID()}`);
          this.#emit(state, { type: "item.started", itemId: state.assistantItemId, payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" } });
        }
        this.#emit(state, { type: "content.delta", itemId: state.assistantItemId, payload: { streamKind: "assistant_text", delta, contentIndex } });
      } else {
        if (!state.reasoningItemId) {
          state.reasoningItemId = RuntimeItemId.makeUnsafe(`pi-reasoning-${crypto.randomUUID()}`);
          this.#emit(state, { type: "item.started", itemId: state.reasoningItemId, payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" } });
        }
        this.#emit(state, { type: "content.delta", itemId: state.reasoningItemId, payload: { streamKind: "reasoning_text", delta, contentIndex } });
      }
    }
  }

  #usage(message: AssistantMessage): ThreadTokenUsageSnapshot | undefined {
    const usage = message.usage;
    if (!usage) return undefined;
    const used = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    const model = this.#models.getModel(message.provider, message.model);
    const maxTokens = model?.contextWindow && model.contextWindow > 0 ? Math.floor(model.contextWindow) : undefined;
    return {
      usedTokens: used,
      ...(maxTokens ? { maxTokens, usedPercent: Math.min(100, (used / maxTokens) * 100) } : {}),
      inputTokens: usage.input,
      cachedInputTokens: usage.cacheRead,
      outputTokens: usage.output,
      lastUsedTokens: used,
      compactsAutomatically: true,
    };
  }

  #settleWhenDone(state: ThreadState, turnId: TurnId, submissionId: SubmissionId, fallback: boolean) {
    void (async () => {
      let status: "completed" | "failed" | "interrupted" = "completed";
      let errorMessage: string | undefined;
      try {
        let current = submissionId;
        for (;;) {
          const submission = await this.#harness.submission(current, ctx);
          const settled = submission ? await submission.wait(ctx) : undefined;
          if (settled?.status !== "unanswered") break;
          const last = await this.#lastAssistant(state);
          if (settled.reason === "aborted" || last?.stopReason === "aborted") {
            status = "interrupted";
            break;
          }
          const detail = typeof settled.detail === "string" ? settled.detail : last?.errorMessage;
          // An unusable Anthropic moves the turn to OpenAI; it settles when the continuation does.
          const next = fallback && settled.reason === "model_error" && state.activeTurnId === turnId
            ? await this.#fallbackAfterFailure(state, turnId, detail).catch((cause: unknown) => {
              logEvent("warn", "llm.fallback-failed", { threadId: state.threadId, message: String(cause).slice(0, 300) });
              return undefined;
            })
            : undefined;
          if (next) {
            current = next;
            continue;
          }
          status = "failed";
          errorMessage = last?.errorMessage ?? `Durable turn ended without an answer (${settled.reason}).`;
          break;
        }
      } catch (cause) {
        status = "failed";
        errorMessage = cause instanceof Error ? cause.message : String(cause);
      }
      if (state.activeTurnId !== turnId) return;
      for (const itemId of [state.assistantItemId, state.reasoningItemId]) {
        if (!itemId) continue;
        const itemType = itemId === state.assistantItemId ? "assistant_message" : "reasoning";
        this.#emit(state, { type: "item.completed", itemId, payload: { itemType, status: status === "failed" ? "failed" : "completed", title: itemType === "reasoning" ? "Reasoning" : "Assistant" } });
      }
      if (state.lastUsage) this.#emit(state, { type: "thread.token-usage.updated", payload: { usage: state.lastUsage } });
      if (status === "failed" && errorMessage) {
        this.#emit(state, { type: "runtime.error", turnId: null, payload: { message: errorMessage, class: "provider_error", detail: { source: "pi.durable" } } });
      }
      const turnModel = state.turnModel ?? state.model;
      console.info(JSON.stringify({
        event: "durable.turn.completed",
        threadId: state.threadId,
        turnId,
        status,
        durationMs: state.turnStartedAt ? Date.now() - state.turnStartedAt : undefined,
        model: turnModel,
        lastInputTokens: state.lastUsage?.inputTokens,
        lastCachedInputTokens: state.lastUsage?.cachedInputTokens,
        lastOutputTokens: state.lastUsage?.outputTokens,
      }));
      const turnInfo = state.turnInfo;
      state.activeTurnId = undefined;
      state.assistantItemId = undefined;
      state.reasoningItemId = undefined;
      state.turnInfo = undefined;
      state.turnModel = undefined;
      state.tools.clear();
      this.#emit(state, {
        type: "turn.completed",
        turnId,
        payload:
          status === "completed"
            ? { state: "completed", stopReason: null }
            : status === "interrupted"
              ? { state: "interrupted", stopReason: "aborted", errorMessage: "Interrupted by user." }
              : { state: "failed", stopReason: "error", errorMessage },
      });
      // The view goes with the watch; the next turn opens a new one.
      await this.#unwatch(state);
      const threadKind = threadKindOf(state);
      const durationMs = turnInfo ? Date.now() - turnInfo.startedAt : undefined;
      const firstTokenMs = turnInfo?.firstTextAt !== undefined ? turnInfo.firstTextAt - turnInfo.startedAt : undefined;
      recordTurn({ status, threadKind, durationMs, firstTokenMs });
      if (turnInfo && threadKind !== "diligence_step") void this.#reportTurn(state, { turnId, status, threadKind, durationMs: durationMs ?? 0, firstTokenMs, turnInfo, model: turnModel });
    })();
  }

  /** A person's turn in a Glasswing company workspace, as a `chat.turn` usage event. */
  async #reportTurn(state: ThreadState, input: { turnId: TurnId; status: string; threadKind: ThreadKind; durationMs: number; firstTokenMs: number | undefined; turnInfo: TurnInfo; model: string | undefined }) {
    try {
      const email = glasswingAuthorEmail(input.turnInfo.author);
      if (!email || !input.turnInfo.author) return;
      const companyId = await this.#companyOf(state.threadId);
      if (!companyId) return;
      const after = await this.#usageTotals(state).catch(() => undefined);
      const before = input.turnInfo.usageBefore;
      const delta = (pick: (totals: UsageTotals) => number) => (after && before ? Math.max(0, pick(after) - pick(before)) : null);
      const cost = delta((totals) => totals.costUsd);
      sendUsageEvent({
        dedupe_key: `synara:chat.turn:${input.turnId}`,
        name: "chat.turn",
        occurred_at: new Date().toISOString(),
        actor_email: email,
        actor_subject: input.turnInfo.author.subject,
        company_id: companyId,
        thread_id: state.threadId,
        app_version: APP_VERSION,
        props: {
          thread_kind: input.threadKind,
          turn_id: input.turnId,
          status: input.status,
          duration_ms: input.durationMs,
          first_token_ms: input.firstTokenMs ?? null,
          model: input.model ?? null,
          cost_usd: cost === null ? null : Math.round(cost * 1_000_000) / 1_000_000,
          input_tokens: delta((totals) => totals.inputTokens),
          output_tokens: delta((totals) => totals.outputTokens),
          tools: input.turnInfo.tools,
        },
      });
    } catch (cause) {
      logEvent("warn", "usage.turn-report-failed", { threadId: state.threadId, message: String(cause).slice(0, 300) });
    }
  }

  async #lastAssistant(state: ThreadState): Promise<AssistantMessage | undefined> {
    const conversation = await this.#conversation(state);
    const page = await conversation.entries({}, 20, undefined, ctx);
    const entry = page.items.find((item: EntryRecord) => item.kind === "pi.assistant");
    return entry?.model?.[0] as AssistantMessage | undefined;
  }
}
