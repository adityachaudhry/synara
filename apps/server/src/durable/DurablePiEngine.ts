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
import { createModels } from "@earendil-works/pi-ai/models";
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
  section,
  ToolResultEntry,
  UserEntry,
  watchEvents,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
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
  isGlasswingAgentProfileEnabled,
  renderGlasswingMessageAuthorContext,
} from "../provider/glasswingAgentProfile.ts";
import { renderSynaraHarnessPolicy } from "../agentGateway/harnessPolicy.ts";
import { callAgentGatewayMcpTool, listAgentGatewayMcpTools } from "../agentGateway/mcpInjection.ts";
import { parseModelReference, toPiProviderModelDescriptor } from "../provider/piModelCatalog.ts";
import { textFromToolResult, toolItemType, toolLifecycleData, toolResultForDisplay, toolTitle } from "../provider/piToolDisplay.ts";
import { configurePiWebAccess, createCrunchbaseTools, createWebAccessTools } from "./extensionTools.ts";
import { createPerplexityTools } from "./perplexityTools.ts";
import { SandboxExecutionEnv, type SandboxRunner } from "./sandboxEnv.ts";
import { backupHarness, describe, restoreHarnessIfNeeded } from "./backup.ts";
import { resumingDurableThreads } from "../providerWorker/headlessSessions.ts";

const PROVIDER = "pi" as const;
const ctx = BACKGROUND_CONTEXT;

/** threadId → conversation, kept in the Harness so a restart finds running work. */
const ThreadIndex = defineDoc<{ threads: Record<string, { conversationId: number; generation: string; cwd: string }> }>({
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
}

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
  watching: boolean;
  stopped: boolean;
  lastUsage?: ThreadTokenUsageSnapshot | undefined;
  turnStartedAt?: number | undefined;
}

export interface DurableStartInput {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration: string;
  readonly cwd: string;
  readonly modelSelection?: { readonly provider: string; readonly model: string; readonly options?: unknown } | undefined;
  readonly runtimeMode?: ProviderSession["runtimeMode"];
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
  #backupTimer: ReturnType<typeof setInterval> | undefined;
  readonly #models = createModels();

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
    if (process.env.ANTHROPIC_API_KEY) this.#models.setProvider(anthropicProvider());
    if (process.env.OPENAI_API_KEY) this.#models.setProvider(openaiProvider());

    const glasswing = isGlasswingAgentProfileEnabled();
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
          section("profile", () => (glasswing ? GLASSWING_AGENT_SYSTEM_PROMPT : "You are a helpful coding agent."), { tag: false }),
          section("harness_policy", () => renderSynaraHarnessPolicy({ gatewayControlAvailable: this.#options.gatewayUrl !== undefined }), { tag: false }),
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
      await openNodeSqliteStorage(this.#options.storagePath),
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
      const inputs = (await this.#watch(state))?.run?.inputs ?? [];
      if (inputs.length > 0) {
        // Restart during a turn: re-attach to the running work before the scheduler continues it.
        const submission = await this.#harness.submission(inputs[0]!, ctx);
        const record = submission ? await submission.status(ctx) : undefined;
        const turnId = TurnId.makeUnsafe(record?.requestId ?? crypto.randomUUID());
        state.activeTurnId = turnId;
        state.turns.push(turnId);
        if (submission) this.#settleWhenDone(state, turnId, submission.id);
        resumingDurableThreads.add(threadId);
        console.info(JSON.stringify({ event: "durable.turn.resumed", threadId, turnId }));
      }
    }
    this.#harness.resume();
    const backup = () => {
      backupHarness(this.#options.storagePath).catch((cause) =>
        console.warn(JSON.stringify({ event: "durable.backup.failed", message: describe(cause) })));
    };
    setTimeout(backup, 2 * 60_000).unref();
    this.#backupTimer = setInterval(backup, 10 * 60_000);
    this.#backupTimer.unref();
    console.info(JSON.stringify({
      event: "durable.engine.ready",
      threads: this.#threads.size,
      resumed: [...this.#threads.values()].filter((thread) => thread.activeTurnId).length,
      tools: this.#registry.snapshot().tools().map((entry) => entry.tool.name),
    }));
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
    await this.#harness.commit(async (tx) => {
      const index = await tx.doc(ThreadIndex);
      index.threads[input.threadId] = { conversationId: state.conversationId as number, generation: input.lifecycleGeneration, cwd: input.cwd };
    }, ctx);
    const conversation = await this.#conversation(state);
    await conversation.configure({ cwd: input.cwd }, ctx);
    await this.#applyModel(state, conversation, input.modelSelection);
    await this.#watch(state);
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

  async #applyModel(state: ThreadState, conversation: Conversation, selection: DurableStartInput["modelSelection"]) {
    if (selection?.provider !== "pi") return;
    const model = modelRefOf(selection.model);
    if (!model) return;
    if (!this.#models.getModel(model.provider, model.modelId)) throw new Error(`Pi model '${selection.model}' is not available.`);
    const thinkingLevel = thinkingLevelOf(selection.options);
    await conversation.configure({ model, ...(thinkingLevel ? { thinkingLevel: thinkingLevel as never } : {}) }, ctx);
    state.model = `${model.provider}/${model.modelId}`;
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
      isGlasswingAgentProfileEnabled() ? renderGlasswingMessageAuthorContext(input.author) : null,
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
    await this.#applyModel(state, conversation, input.modelSelection);
    if (input.gatewayBearerToken) {
      state.gatewayToken = input.gatewayBearerToken;
      await this.#installGatewayTools(input.gatewayBearerToken);
    }
    await conversation.configure({ tools: input.repositoryUnavailable ? [] : null }, ctx);
    const content = await this.#content(input);
    const turnId = TurnId.makeUnsafe(crypto.randomUUID());
    state.activeTurnId = turnId;
    state.turnStartedAt = Date.now();
    state.turns.push(turnId);
    await this.#watch(state);
    this.#emitTurnStarted(state);
    const submission = await conversation.submit({ type: "input", content, requestId: turnId, whenBusy: "reject" }, ctx);
    this.#settleWhenDone(state, turnId, submission.id);
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
    this.#emit(state, { type: "thread.state.changed", payload: { state: "closed" } });
    this.#emit(state, { type: "session.exited", payload: { reason: "stopped", exitKind: "graceful" } });
  }

  listSessions(): ProviderSession[] {
    return [...this.#threads.values()].filter((state) => !state.stopped).map((state) => this.#session(state));
  }

  hasSession(threadId: string) {
    const state = this.#threads.get(threadId);
    return state !== undefined && !state.stopped;
  }

  readThread(threadId: string) {
    const state = this.#require(threadId);
    return { threadId: ThreadId.makeUnsafe(threadId), turns: state.turns.map((id) => ({ id, items: [] })), cwd: state.cwd };
  }

  async compactThread(threadId: string) {
    await (await this.#conversation(this.#require(threadId))).compact(undefined, ctx);
  }

  async close() {
    if (this.#backupTimer) clearInterval(this.#backupTimer);
    await this.#harness.close(ctx);
    await backupHarness(this.#options.storagePath).catch((cause) =>
      console.warn(JSON.stringify({ event: "durable.backup.failed", message: describe(cause) })));
  }

  /** Takes one backup now; used by the restore drill. */
  backupNow() {
    return backupHarness(this.#options.storagePath);
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

  #emit(state: ThreadState, event: { type: string; payload: unknown; itemId?: RuntimeItemId; providerRefs?: unknown; turnId?: TurnId | null }) {
    const { turnId, ...rest } = event;
    const resolvedTurn = turnId === null ? undefined : (turnId ?? state.activeTurnId);
    this.#options.publish({
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      provider: PROVIDER,
      threadId: ThreadId.makeUnsafe(state.threadId),
      createdAt: new Date().toISOString(),
      lifecycleGeneration: state.lifecycleGeneration,
      ...(resolvedTurn ? { turnId: resolvedTurn } : {}),
      ...rest,
      raw: { source: "pi.sdk.event", messageType: "pi.durable", payload: null },
    } as unknown as ProviderRuntimeEvent);
  }

  #emitTurnStarted(state: ThreadState) {
    this.#emit(state, { type: "thread.state.changed", payload: { state: "active" } });
    this.#emit(state, { type: "turn.started", payload: { ...(state.model ? { model: state.model } : {}) } });
  }

  async #watch(state: ThreadState) {
    if (state.watching) return undefined;
    state.watching = true;
    const stream = await watchEvents(this.#harness, state.conversationId, ctx);
    stream.start(async (events) => {
      for (const event of events) this.#onEvent(state, event);
    });
    void stream.closed.then(() => {
      state.watching = false;
    });
    return stream.snapshot;
  }

  #onEvent(state: ThreadState, event: AgentEvent) {
    if (!state.activeTurnId) return;
    switch (event.type) {
      case "message_start":
        if ((event.message as { role?: string }).role === "assistant") state.partial.clear();
        return;
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
      state.partial.set(index, { kind, text, emitted: current?.kind === kind ? Math.min(current.emitted, text.length) : 0 });
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

  #settleWhenDone(state: ThreadState, turnId: TurnId, submissionId: SubmissionId) {
    void (async () => {
      let status: "completed" | "failed" | "interrupted" = "completed";
      let errorMessage: string | undefined;
      try {
        const submission = await this.#harness.submission(submissionId, ctx);
        const settled = submission ? await submission.wait(ctx) : undefined;
        if (settled?.status === "unanswered") {
          const last = await this.#lastAssistant(state);
          if (settled.reason === "aborted" || last?.stopReason === "aborted") status = "interrupted";
          else {
            status = "failed";
            errorMessage = last?.errorMessage ?? `Durable turn ended without an answer (${settled.reason}).`;
          }
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
      console.info(JSON.stringify({
        event: "durable.turn.completed",
        threadId: state.threadId,
        turnId,
        status,
        durationMs: state.turnStartedAt ? Date.now() - state.turnStartedAt : undefined,
        model: state.model,
        lastInputTokens: state.lastUsage?.inputTokens,
        lastCachedInputTokens: state.lastUsage?.cachedInputTokens,
        lastOutputTokens: state.lastUsage?.outputTokens,
      }));
      state.activeTurnId = undefined;
      state.assistantItemId = undefined;
      state.reasoningItemId = undefined;
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
    })();
  }

  async #lastAssistant(state: ThreadState): Promise<AssistantMessage | undefined> {
    const conversation = await this.#conversation(state);
    const page = await conversation.entries({}, 20, undefined, ctx);
    const entry = page.items.find((item: EntryRecord) => item.kind === "pi.assistant");
    return entry?.model?.[0] as AssistantMessage | undefined;
  }
}
