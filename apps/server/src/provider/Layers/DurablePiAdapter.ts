/**
 * The Pi provider for Synara threads.
 *
 * The agent loop runs in this process on Pi Durable (`DurablePiEngine`): conversations are
 * committed before they are shown and continue after a restart. Each company thread gets a
 * disposable sandbox from the provisioner for file and shell tools; its Outbox files and
 * drafts are captured on the controller after file changes and at every turn end.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  EventId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Layer, Option, PubSub, Queue, Scope, Stream } from "effect";

import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerConfig } from "../../config.ts";
import { DurablePiEngine, type DurableThreadTarget } from "../../durable/DurablePiEngine.ts";
import { DiligenceRunner, setDiligenceRunner } from "../../durable/diligence.ts";
import type { SandboxRunner } from "../../durable/sandboxEnv.ts";
import { setHeadlessSessionSource } from "../../providerWorker/headlessSessions.ts";
import { ProviderWorkerProvisioningError } from "../../providerWorker/Errors";
import { decodeProviderWorkerRuntimeBinding, type ProviderWorkerRuntimeBinding } from "../../providerWorker/runtimeBinding";
import { ProviderWorkerProvisioner } from "../../providerWorker/Services/ProviderWorkerProvisioner";
import { observeProviderOperation } from "../../providerOperationDiagnostics";
import type { SandboxCapacity } from "../../workspaceRuntime/SandboxCapacity";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors";
import { makeKeyedLock } from "../keyedLock";
import { extractResumeSessionFile } from "../piSessionFiles.ts";
import { providerAttachmentStoragePath } from "../providerAttachmentPaths";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory";

export const DISTRIBUTED_PI_RUNTIME_PAYLOAD_KEY = "distributedPiRuntime";
export const DISTRIBUTED_PI_ADAPTER_KEY = "pi:railway-sandbox";

const adapterError = (method: string, detail: string, cause?: unknown, options?: { readonly retryable?: boolean }) =>
  new ProviderAdapterRequestError({
    provider: "pi",
    method,
    detail,
    ...(options?.retryable === true ? { retryable: true } : {}),
    ...(cause === undefined ? {} : { cause }),
  });

const persistedBinding = (payload: unknown): ProviderWorkerRuntimeBinding | undefined => {
  const record = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  return decodeProviderWorkerRuntimeBinding(record[DISTRIBUTED_PI_RUNTIME_PAYLOAD_KEY]);
};

const newGeneration = () => `durable-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const makeDurablePiAdapter = (capacity?: SandboxCapacity) => Effect.gen(function* () {
  const provisioner = yield* ProviderWorkerProvisioner;
  const directory = yield* ProviderSessionDirectory;
  const serverConfig = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
  const credentials = Option.getOrUndefined(yield* Effect.serviceOption(AgentGatewayCredentials));
  const execInWorkspace = provisioner.execInWorkspace;
  const writeWorkspaceFile = provisioner.writeWorkspaceFile;
  const home = serverConfig?.stateDir ?? (process.env.SYNARA_HOME ? path.join(process.env.SYNARA_HOME, "userdata") : undefined);

  const sandboxes = new Map<string, ProviderWorkerRuntimeBinding>();
  const gatewayTokens = new Map<string, string>();
  const mutationLock = makeKeyedLock<string>();
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();

  // ------------------------------------------------------------ checkpoints
  type CheckpointRequest = { readonly binding: ProviderWorkerRuntimeBinding; readonly eventId: string; readonly turnId?: string; readonly terminal: boolean };
  type CheckpointWorker = { readonly done: Deferred.Deferred<void>; terminalDone: Deferred.Deferred<void> | undefined; pending: CheckpointRequest | undefined; lastEventId: string };
  const checkpointWorkers = new Map<string, CheckpointWorker>();
  let closing = false;
  const awaitCheckpoint = (threadId: string): Effect.Effect<void> => Effect.suspend(() => {
    const worker = checkpointWorkers.get(threadId);
    return worker?.terminalDone ? Deferred.await(worker.terminalDone).pipe(Effect.andThen(awaitCheckpoint(threadId))) : Effect.void;
  });
  const checkpointScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Effect.suspend(() => {
    closing = true;
    return Effect.forEach(Array.from(checkpointWorkers.values()), (worker) => Deferred.await(worker.done), { concurrency: "unbounded", discard: true });
  }).pipe(Effect.ensuring(Scope.close(scope, Exit.void))));
  /** Thread mutations wait for an in-flight turn-end capture. */
  const withBarrier = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    mutationLock.withLock(threadId, awaitCheckpoint(threadId).pipe(Effect.andThen(effect)));
  const scheduleCheckpoint = (threadId: string, request: CheckpointRequest) => Effect.uninterruptible(Effect.suspend(() => {
    if (closing) return Effect.interrupt;
    const existing = checkpointWorkers.get(threadId);
    if (existing) {
      if (existing.lastEventId === request.eventId) return Effect.void;
      existing.lastEventId = request.eventId;
      if (request.terminal && !existing.terminalDone) existing.terminalDone = Deferred.makeUnsafe<void>();
      if (!existing.pending?.terminal || request.terminal) existing.pending = request;
      return Effect.void;
    }
    const worker: CheckpointWorker = {
      done: Deferred.makeUnsafe<void>(), pending: request, lastEventId: request.eventId,
      terminalDone: request.terminal ? Deferred.makeUnsafe<void>() : undefined,
    };
    checkpointWorkers.set(threadId, worker);
    const drain = (): Effect.Effect<void> => Effect.suspend(() => {
      const next = worker.pending;
      worker.pending = undefined;
      if (!next) {
        if (checkpointWorkers.get(threadId) === worker) checkpointWorkers.delete(threadId);
        return Effect.void;
      }
      const finishTerminal = Effect.suspend(() => {
        if (!next.terminal || worker.pending?.terminal) return Effect.void;
        const done = worker.terminalDone;
        worker.terminalDone = undefined;
        return done ? Deferred.succeed(done, undefined).pipe(Effect.asVoid) : Effect.void;
      });
      const binding = sandboxes.get(threadId);
      if (!binding || binding.workspace.runtimeId !== next.binding.workspace.runtimeId) return finishTerminal.pipe(Effect.andThen(drain()));
      return provisioner.checkpointOutbox(binding, next.turnId).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt
          : Effect.logWarning("thread file capture deferred", { threadId, sandboxId: binding.workspace.runtimeId, cause: Cause.pretty(cause) })),
        Effect.andThen(finishTerminal),
        Effect.andThen(drain()),
      );
    });
    return drain().pipe(
      Effect.interruptible,
      Effect.ensuring(Effect.suspend(() => {
        if (checkpointWorkers.get(threadId) === worker) checkpointWorkers.delete(threadId);
        return Deferred.succeed(worker.done, undefined).pipe(Effect.andThen(worker.terminalDone ? Deferred.succeed(worker.terminalDone, undefined) : Effect.void));
      })),
      Effect.forkIn(checkpointScope),
      Effect.asVoid,
    );
  }));

  // ---------------------------------------------------------- capacity UI
  const capacityEvents = capacity === undefined ? undefined : yield* PubSub.unbounded<ProviderRuntimeEvent>();
  if (capacity !== undefined && capacityEvents !== undefined) {
    let sequence = 0;
    let previousQueued = new Map<string, { readonly threadId: string; readonly lifecycleGeneration: string; readonly position: number }>();
    capacity.subscribe((snapshot) => {
      const queued = new Map<string, { readonly threadId: string; readonly lifecycleGeneration: string; readonly position: number }>();
      const publish = (threadId: string, lifecycleGeneration: string, payload: { state: "queued" | "acquired" | "cancelled"; queuePosition?: number }) => {
        sequence += 1;
        Effect.runSync(PubSub.publish(capacityEvents, {
          type: "runtime.capacity.changed",
          eventId: EventId.makeUnsafe(`sandbox-capacity-${Date.now()}-${sequence}`),
          provider: "pi",
          threadId: ThreadId.makeUnsafe(threadId),
          lifecycleGeneration,
          createdAt: new Date().toISOString() as never,
          payload,
        }));
      };
      for (const entry of snapshot.queued) {
        const reservation = capacity.reservation(entry.key);
        if (!reservation) continue;
        queued.set(entry.key, { ...reservation, position: entry.position });
        if (previousQueued.get(entry.key)?.position !== entry.position)
          publish(reservation.threadId, reservation.lifecycleGeneration, { state: "queued", queuePosition: entry.position });
      }
      for (const [key, previous] of previousQueued) {
        if (!queued.has(key)) publish(previous.threadId, previous.lifecycleGeneration, { state: snapshot.activeKeys.includes(key) ? "acquired" : "cancelled" });
      }
      previousQueued = queued;
    });
  }

  // -------------------------------------------------------------- bindings
  const loadBinding = (threadId: string) => directory.getBinding(ThreadId.makeUnsafe(threadId)).pipe(
    Effect.map((binding) => Option.match(binding, { onNone: () => undefined, onSome: (value) => persistedBinding(value.runtimePayload) })),
    Effect.mapError((cause) => adapterError("runtime.binding.read", "Failed to read the thread's sandbox binding.", cause)),
  );
  const saveBinding = (binding: ProviderWorkerRuntimeBinding) => directory.upsert({
    threadId: ThreadId.makeUnsafe(binding.threadId!),
    provider: "pi",
    adapterKey: DISTRIBUTED_PI_ADAPTER_KEY,
    lifecycleGeneration: binding.fence.lifecycleGeneration,
    runtimePayload: { [DISTRIBUTED_PI_RUNTIME_PAYLOAD_KEY]: binding },
  }).pipe(Effect.mapError((cause) => adapterError("session.start", "Failed to persist the sandbox binding.", cause)));
  const currentBinding = (threadId: string) => Effect.suspend(() => {
    const cached = sandboxes.get(threadId);
    return cached ? Effect.succeed<ProviderWorkerRuntimeBinding | undefined>(cached) : loadBinding(threadId);
  });
  const unavailable = (binding: ProviderWorkerRuntimeBinding) => provisioner.isWorkspaceUnavailable?.(binding) ?? Effect.succeed(false);
  const revokeToken = (threadId: string) => {
    const token = gatewayTokens.get(threadId);
    if (token && credentials) credentials.revokeSessionToken(token);
    gatewayTokens.delete(threadId);
  };

  /** Claims a fresh sandbox for the thread, under the given generation. */
  const claimSandbox = (threadId: string, lifecycleGeneration: string, repositoryBinding: NonNullable<ProviderWorkerRuntimeBinding["repositoryCheckout"]>["binding"] | undefined, speculative = false) =>
    provisioner.start({
      threadId: ThreadId.makeUnsafe(threadId),
      lifecycleGeneration,
      headless: true,
      fresh: true,
      ...(speculative ? { speculative: true } : {}),
      ...(repositoryBinding ? { repositoryBinding } : {}),
    }).pipe(
      Effect.tap((binding) => saveBinding(binding).pipe(Effect.andThen(provisioner.adopt(binding)))),
      Effect.tap((binding) => Effect.sync(() => sandboxes.set(threadId, binding))),
    );

  /**
   * Sandbox claims run in the background: a turn starts at once and only tool calls wait.
   * One claim per thread at a time; it is re-stamped to the session's generation.
   */
  const pendingClaims = new Map<string, Promise<ProviderWorkerRuntimeBinding>>();
  const backgroundClaim = (
    threadId: string,
    lifecycleGeneration: string,
    repositoryBinding: NonNullable<ProviderWorkerRuntimeBinding["repositoryCheckout"]>["binding"] | undefined,
    speculative = false,
  ): Promise<ProviderWorkerRuntimeBinding> => {
    const existing = pendingClaims.get(threadId);
    const claim = (existing ?? Effect.runPromise(claimSandbox(threadId, lifecycleGeneration, repositoryBinding, speculative)))
      .then(async (binding) => {
        if (binding.fence.lifecycleGeneration === lifecycleGeneration) return binding;
        const restamped = { ...binding, fence: { ...binding.fence, lifecycleGeneration } };
        await Effect.runPromise(saveBinding(restamped));
        sandboxes.set(threadId, restamped);
        return restamped;
      });
    const tracked = claim.finally(() => {
      if (pendingClaims.get(threadId) === tracked) pendingClaims.delete(threadId);
    });
    tracked.catch((cause) => Effect.runFork(Effect.logWarning("background sandbox claim failed", { threadId, cause: String(cause) })));
    pendingClaims.set(threadId, tracked);
    return tracked;
  };

  // ---------------------------------------------------------------- engine
  const sandboxRunner = (binding: ProviderWorkerRuntimeBinding): SandboxRunner => ({
    run: (command, options) => Effect.runPromise(execInWorkspace!(binding, {
      command, ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    }).pipe(
      Effect.mapError((cause) => new Error(`Sandbox command failed: ${String((cause as { detail?: unknown; message?: unknown })?.detail ?? (cause as { message?: unknown })?.message ?? cause)}`)),
      Effect.map((result) => ({ exitCode: result.exitCode, output: result.stdout + result.stderr, timedOut: result.timedOut, truncated: result.truncated })),
    )),
    upload: (filePath, data) => Effect.runPromise(writeWorkspaceFile!(binding, { path: filePath, data, mode: 0o644 })),
  });
  // One replacement at a time when a thread's sandbox is lost during a turn.
  const replacing = new Map<string, Promise<ProviderWorkerRuntimeBinding>>();
  const target = async (threadId: string): Promise<DurableThreadTarget | undefined> => {
    if (!execInWorkspace || !writeWorkspaceFile) return undefined;
    const pending = pendingClaims.get(threadId);
    if (pending) await pending.catch(() => undefined);
    let binding = await Effect.runPromise(currentBinding(threadId));
    if (!binding) return undefined;
    if (replacing.has(threadId)) binding = await replacing.get(threadId)!;
    else if (await Effect.runPromise(unavailable(binding))) {
      const lost = binding;
      const started = Effect.runPromise(Effect.logWarning("sandbox lost during a turn; claiming a replacement", { threadId, sandboxId: lost.workspace.runtimeId }).pipe(
        Effect.andThen(claimSandbox(threadId, lost.fence.lifecycleGeneration, lost.repositoryCheckout?.binding ?? lost.repositoryUnavailable?.binding)),
      )).finally(() => replacing.delete(threadId));
      replacing.set(threadId, started);
      binding = await started;
    }
    return { threadId, lifecycleGeneration: binding.fence.lifecycleGeneration, cwd: binding.cwd, homeDir: binding.homeDir, runner: sandboxRunner(binding), envId: binding.workspace.runtimeId };
  };
  if (!execInWorkspace || !writeWorkspaceFile) {
    yield* Effect.logWarning("no sandbox runtime is configured; Pi threads run without file and shell tools");
  }
  const harnessHome = home ?? path.join(process.cwd(), ".synara-durable");
  const engine = yield* Effect.acquireRelease(
    Effect.promise(() => DurablePiEngine.open({
      storagePath: path.join(harnessHome, "durable", "harness.sqlite"),
      agentDir: path.join(harnessHome, "durable", "agent"),
      target,
      readAttachment: async (attachment) => {
        const source = providerAttachmentStoragePath(attachment);
        return source ? new Uint8Array(await readFile(source)) : undefined;
      },
      gatewayUrl: credentials?.mcpEndpointUrl,
      publish: (event) => {
        Queue.offerUnsafe(events, event);
      },
    })),
    (opened) => Effect.promise(() => opened.close()),
  );
  setHeadlessSessionSource((threadId) => engine.listSessions().filter((session) => threadId === undefined || session.threadId === threadId));
  if (execInWorkspace && writeWorkspaceFile) {
    // Durable diligence runs share this Harness and the sandbox provisioner.
    const diligence = new DiligenceRunner(engine, {
      claim: (key, generation, repository) => Effect.runPromise(provisioner.start({
        threadId: ThreadId.makeUnsafe(key), lifecycleGeneration: generation, headless: true, fresh: true, repositoryBinding: repository,
      })),
      unavailable: (binding) => Effect.runPromise(unavailable(binding)),
      runner: sandboxRunner,
      release: (binding) => Effect.runPromise(provisioner.stop(binding).pipe(Effect.catch(() => Effect.void))),
    });
    setDiligenceRunner(diligence);
    yield* Effect.promise(() => diligence.resume());
  }
  const call = <A>(method: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => adapterError(method, cause instanceof Error ? cause.message : `Durable Pi '${method}' failed.`, cause) });

  // -------------------------------------------------------------- sessions
  const startSession: PiAdapterShape["startSession"] = (input) => withBarrier(input.threadId, Effect.gen(function* () {
    const previous = yield* currentBinding(input.threadId);
    const lifecycleGeneration = input.lifecycleGeneration ?? newGeneration();
    const repositoryBinding = input.repositoryBinding ?? previous?.repositoryCheckout?.binding ?? previous?.repositoryUnavailable?.binding;
    // Worker-era thread: move its Pi history, Outbox and drafts once; its disk is kept.
    if (previous && previous.headless !== true && !engine.isDurableThread(input.threadId)) {
      const imported = provisioner.importLegacy
        ? yield* provisioner.importLegacy(previous, extractResumeSessionFile(input.resumeCursor)).pipe(Effect.catch((cause) =>
            Effect.logWarning("worker-era import skipped", { threadId: input.threadId, cause }).pipe(Effect.as({}))))
        : {};
      if ((imported as { sessionJsonl?: string }).sessionJsonl) {
        yield* call("session.import", () => engine.importLegacySession({
          threadId: input.threadId, lifecycleGeneration, cwd: previous.cwd, sessionJsonl: (imported as { sessionJsonl: string }).sessionJsonl,
        }));
      }
    }
    let cwd = previous?.cwd ?? "/workspace";
    if (repositoryBinding) {
      cwd = `/workspace/repository/${repositoryBinding.path}`;
      const live = previous?.headless === true && !pendingClaims.has(input.threadId) && !(yield* unavailable(previous));
      if (live && previous) {
        // A prepared or still-running sandbox is reused under the session's generation.
        const adopted = previous.fence.lifecycleGeneration === lifecycleGeneration ? previous
          : { ...previous, fence: { ...previous.fence, lifecycleGeneration } };
        sandboxes.set(input.threadId, adopted);
        yield* saveBinding(adopted);
        yield* provisioner.adopt(adopted).pipe(Effect.mapError((cause) => adapterError("session.start", "Failed to adopt the prepared sandbox.", cause)));
        cwd = adopted.cwd;
      } else {
        void backgroundClaim(input.threadId, lifecycleGeneration, repositoryBinding);
      }
    }
    const connection = credentials?.repositoryConnectionForThread(input.threadId, "pi");
    if (connection) {
      revokeToken(input.threadId);
      gatewayTokens.set(input.threadId, connection.bearerToken);
    }
    return yield* call("session.start", () => engine.startSession({
      threadId: input.threadId,
      lifecycleGeneration,
      cwd,
      modelSelection: input.modelSelection as never,
      ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
    }));
  })).pipe(observeProviderOperation("worker.provision", { threadId: input.threadId }));

  const prepareWorkspace: NonNullable<PiAdapterShape["prepareWorkspace"]> = (input) => withBarrier(input.threadId, Effect.gen(function* () {
    if (process.env.SYNARA_WORKSPACE_RUNTIME !== "daytona" || !input.repositoryBinding || !input.lifecycleGeneration || capacity?.snapshot().queued.length) return false;
    const previous = yield* currentBinding(input.threadId);
    if (previous?.headless && previous.fence.lifecycleGeneration === input.lifecycleGeneration && !(yield* unavailable(previous))) return true;
    yield* Effect.promise(() => backgroundClaim(input.threadId, input.lifecycleGeneration!, input.repositoryBinding, true).catch(() => undefined));
    return true;
  })).pipe(
    observeProviderOperation("workspace.prepare", { threadId: input.threadId }),
    Effect.mapError((cause) => cause instanceof ProviderAdapterRequestError ? cause
      : adapterError("workspace.prepare", "Could not prepare the company workspace.", cause)),
  );

  /** The thread's live sandbox; a released or lost one is replaced from the company revision and captured files. */
  const liveSandbox = (threadId: string) => Effect.gen(function* () {
    if (pendingClaims.has(threadId)) return undefined;
    const binding = yield* currentBinding(threadId);
    if (!binding || !(yield* unavailable(binding))) return binding;
    yield* Effect.logInfo("thread sandbox released; claiming a replacement in the background", { threadId, sandboxId: binding.workspace.runtimeId });
    void backgroundClaim(threadId, binding.fence.lifecycleGeneration, binding.repositoryCheckout?.binding ?? binding.repositoryUnavailable?.binding);
    return undefined;
  });

  const stageAttachments = (binding: ProviderWorkerRuntimeBinding | undefined, attachments: Parameters<PiAdapterShape["sendTurn"]>[0]["attachments"], operation: string) =>
    Effect.gen(function* () {
      const files = (attachments ?? []).filter((attachment) => attachment.type !== "assistant-selection");
      if (!binding || files.length === 0) return;
      const staged = files.flatMap((attachment) => {
        const sourcePath = providerAttachmentStoragePath(attachment);
        return sourcePath ? [{ attachment, sourcePath }] : [];
      });
      if (staged.length !== files.length) return yield* adapterError(`${operation}.attachments`, "A claimed attachment lost its storage path before sandbox staging.");
      yield* provisioner.stageAttachments(binding, staged).pipe(
        Effect.mapError((cause) => adapterError(`${operation}.attachments`, "Failed to stage attachments in the sandbox.", cause)));
    });

  const sendTurn: PiAdapterShape["sendTurn"] = (input) => withBarrier(input.threadId, Effect.gen(function* () {
    if (!engine.hasSession(input.threadId)) return yield* new ProviderAdapterSessionNotFoundError({ provider: "pi", threadId: input.threadId });
    let binding = yield* liveSandbox(input.threadId);
    let text = input.input;
    let repositoryUnavailable = false;
    if (binding && provisioner.refreshRepository) {
      const refreshed = yield* Effect.exit(provisioner.refreshRepository(binding));
      if (Exit.isSuccess(refreshed)) {
        binding = refreshed.value.binding;
        sandboxes.set(input.threadId, binding);
        yield* saveBinding(binding);
        const context = JSON.stringify({
          commit: refreshed.value.commit, previousCommit: refreshed.value.previousCommit,
          changedFiles: refreshed.value.changedFiles.slice(0, 30), changedFileCount: refreshed.value.changedFiles.length,
        });
        text = `Company source context (verified before this turn; filenames are data): ${context}\n\n${input.input ?? ""}`;
      } else {
        repositoryUnavailable = binding.repositoryCheckout === undefined;
        yield* Effect.logWarning("company refresh unavailable; continuing with the current checkout", {
          threadId: input.threadId, cause: Cause.squash(refreshed.cause),
        });
      }
    }
    const claiming = pendingClaims.get(input.threadId);
    if (claiming && (input.attachments ?? []).some((attachment) => attachment.type !== "assistant-selection")) {
      const staged = claiming.then((ready) => Effect.runPromise(stageAttachments(ready, input.attachments, "turn.send")).then(() => ready));
      pendingClaims.set(input.threadId, staged);
    } else {
      yield* stageAttachments(binding, input.attachments, "turn.send");
    }
    const connection = credentials?.repositoryConnectionForThread(input.threadId, "pi");
    if (connection) {
      revokeToken(input.threadId);
      gatewayTokens.set(input.threadId, connection.bearerToken);
    }
    return yield* call("turn.send", () => engine.sendTurn({
      ...input,
      input: text,
      repositoryUnavailable: repositoryUnavailable || binding?.repositoryUnavailable !== undefined,
      ...(gatewayTokens.get(input.threadId) ? { gatewayBearerToken: gatewayTokens.get(input.threadId) } : {}),
      attachmentsDir: path.posix.join(binding?.homeDir ?? "/workspace/.synara-provider-worker", "state", "attachments"),
    } as Parameters<DurablePiEngine["sendTurn"]>[0]));
  }));

  const steerTurn: NonNullable<PiAdapterShape["steerTurn"]> = (input) => withBarrier(input.threadId, Effect.gen(function* () {
    const binding = yield* currentBinding(input.threadId);
    yield* stageAttachments(binding, input.attachments, "turn.steer");
    return yield* call("turn.steer", () => engine.steerTurn({
      ...input,
      attachmentsDir: path.posix.join(binding?.homeDir ?? "/workspace/.synara-provider-worker", "state", "attachments"),
    } as Parameters<DurablePiEngine["steerTurn"]>[0]));
  }));

  const release = (threadId: string) => withBarrier(threadId, Effect.gen(function* () {
    yield* call("session.stop", () => engine.stopSession(threadId));
    const binding = yield* currentBinding(threadId);
    if (binding?.headless) {
      yield* provisioner.stop(binding).pipe(Effect.mapError((cause) => adapterError("session.stop", "Failed to release the sandbox.", cause)));
    }
    sandboxes.delete(threadId);
    revokeToken(threadId);
  }));

  // ------------------------------------------------- Save to company files
  const requireRepositoryBinding = (threadId: ThreadId, operation: string) => Effect.gen(function* () {
    const binding = yield* currentBinding(threadId);
    if (!binding?.repositoryCheckout || binding.repositoryUnavailable)
      return yield* adapterError(operation, "The Pi session does not have a repository-bound sandbox.");
    return { ...binding, repositoryCheckout: binding.repositoryCheckout };
  });
  const requireIdle = (threadId: ThreadId, operation: string) => Effect.suspend(() =>
    engine.listSessions().some((session) => session.threadId === threadId && session.activeTurnId !== undefined)
      ? Effect.fail(adapterError(operation, "Wait for the active Pi turn to finish before accessing sandbox files."))
      : Effect.void);

  const checkpointOnTerminal = (event: ProviderRuntimeEvent) => Effect.suspend(() => {
    const fileChange = event.type === "item.completed" && event.payload.itemType === "file_change" && event.payload.status === "completed";
    if (!fileChange && event.type !== "turn.completed" && event.type !== "turn.aborted") return Effect.void;
    const binding = sandboxes.get(event.threadId);
    if (!binding) return Effect.void;
    if (!fileChange && event.turnId) {
      const token = gatewayTokens.get(event.threadId);
      // Each completed turn retires write authority; ProviderService rotates it on recovery.
      if (token) void credentials?.retireSessionTurn(token, event.turnId);
    }
    return scheduleCheckpoint(event.threadId, { binding, eventId: event.eventId, terminal: !fileChange, ...(event.turnId ? { turnId: event.turnId } : {}) });
  });

  return {
    provider: "pi",
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsTurnSteering: true,
    },
    managesStartSessionTimeout: (input) => capacity !== undefined && input.repositoryBinding !== undefined,
    startSession,
    prepareWorkspace,
    sendTurn,
    steerTurn,
    interruptTurn: (threadId, turnId) => call("turn.interrupt", () => engine.interruptTurn(threadId, turnId)),
    respondToRequest: () => Effect.fail(adapterError("request.respond", "Pi has no approval requests.")),
    respondToUserInput: () => Effect.void,
    stopSession: release,
    parkSession: release,
    listSessions: (threadId) => Effect.sync(() =>
      engine.listSessions().filter((session) => threadId === undefined || session.threadId === threadId) as ProviderSession[]),
    hasSession: (threadId) => Effect.sync(() => engine.hasSession(threadId)),
    readThread: (threadId) => call("thread.read", async () => engine.readThread(threadId)),
    rollbackThread: () => Effect.fail(adapterError("thread.rollback", "Rollback is not available for durable Pi threads.")),
    compactThread: (threadId) => call("thread.compact", () => engine.compactThread(threadId)),
    stopAll: () => Effect.forEach(Array.from(sandboxes.keys()), (threadId) => release(threadId).pipe(Effect.ignore), { discard: true }),
    listModels: () => call("model/list", () => engine.listModels()),
    listSkills: () => Effect.succeed({ skills: [], source: "pi.durable", cached: false } as never),
    listCommands: () => Effect.succeed({ commands: [], source: "pi.durable", cached: false } as never),
    getComposerCapabilities: () => Effect.succeed({
      provider: "pi",
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: true,
      supportsThreadImport: false,
    }),
    listPersistenceCandidates: (threadId) => withBarrier(threadId, Effect.gen(function* () {
      const binding = yield* requireRepositoryBinding(threadId, "persistence.list");
      yield* requireIdle(threadId, "persistence.list");
      return yield* provisioner.listPersistenceCandidates(binding).pipe(
        Effect.mapError((cause) => adapterError("persistence.list", "The sandbox files available to save could not be listed.", cause)));
    })),
    readPersistenceCandidate: (threadId, lifecycleGeneration, selection) => withBarrier(threadId, Effect.gen(function* () {
      const binding = yield* requireRepositoryBinding(threadId, "persistence.read");
      if (selection.source !== "outbox") yield* requireIdle(threadId, "persistence.read");
      if (binding.fence.lifecycleGeneration !== lifecycleGeneration)
        return yield* adapterError("persistence.read", "The sandbox changed after these files were reviewed. Refresh and select them again.");
      return yield* provisioner.readPersistenceCandidate(binding, selection).pipe(
        Effect.mapError((cause) => adapterError("persistence.read", "The selected sandbox file could not be read safely.", cause)));
    })),
    readWorkspaceFile: (threadId, filePath) => withBarrier(threadId, Effect.gen(function* () {
      const binding = yield* requireRepositoryBinding(threadId, "workspace.file.read");
      if (!provisioner.readWorkspaceFile) return yield* adapterError("workspace.file.read", "Workspace file preview is unavailable.");
      return yield* provisioner.readWorkspaceFile(binding, filePath).pipe(
        Effect.mapError((cause) => adapterError("workspace.file.read", cause.detail, cause)));
    })),
    readOutboxCheckpoint: (threadId, candidatePath) => provisioner.readOutboxCheckpoint(threadId, candidatePath).pipe(
      Effect.mapError((cause) => adapterError("persistence.checkpoint.read", "The captured Outbox file could not be read.", cause))),
    reconcileRepository: (threadId, commit, persistedFiles = [], activeTurnId, workspaceCommit) => withBarrier(threadId, Effect.gen(function* () {
      const binding = yield* requireRepositoryBinding(threadId, "repository.reconcile");
      yield* provisioner.markOutboxPromoted(binding, persistedFiles).pipe(
        Effect.mapError((cause) => adapterError("repository.reconcile", "Saved Outbox files could not be recorded.", cause)));
      if (activeTurnId === undefined) yield* requireIdle(threadId, "repository.reconcile");
      else if (!engine.listSessions().some((session) => session.threadId === threadId && session.activeTurnId === activeTurnId))
        return yield* adapterError("repository.reconcile", "The requesting agent turn is no longer active.");
      const previousCommit = binding.repositoryCheckout.commit;
      const targetCommit = binding.repositoryCheckout.checkoutMode === "company" ? workspaceCommit : commit;
      if (!targetCommit || !/^[a-f0-9]{40}$/u.test(targetCommit))
        return yield* adapterError("repository.reconcile", "The saved company snapshot is not available; existing edits are retained.");
      const reconciled = yield* provisioner.reconcileRepository(binding, targetCommit, persistedFiles, activeTurnId).pipe(
        Effect.mapError((cause) => adapterError("repository.reconcile", "The saved commit could not be applied without overwriting local work.", cause)));
      sandboxes.set(threadId, reconciled);
      yield* saveBinding(reconciled);
      return { runtimeId: reconciled.workspace.runtimeId, previousCommit, commit: reconciled.repositoryCheckout?.commit ?? commit };
    })),
    get streamEvents() {
      const durableEvents = Stream.fromQueue(events).pipe(Stream.tap(checkpointOnTerminal));
      return capacityEvents === undefined ? durableEvents : Stream.merge(durableEvents, Stream.fromPubSub(capacityEvents));
    },
  } satisfies PiAdapterShape;
});

export const makeDurablePiAdapterLive = (capacity?: SandboxCapacity) => Layer.effect(PiAdapter, makeDurablePiAdapter(capacity));
