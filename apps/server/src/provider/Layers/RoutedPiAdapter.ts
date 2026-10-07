import { observeProviderOperation } from "../../providerOperationDiagnostics";
import {
  ProviderSession,
  ProviderTurnStartResult,
  EventId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderWorkerMethod,
} from "@synara/contracts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Cause, Deferred, Effect, Exit, Layer, Option, PubSub, Queue, Schema, Scope, Stream } from "effect";

import { ProviderWorkerProvisioner } from "../../providerWorker/Services/ProviderWorkerProvisioner";
import { ProviderWorkerBroker } from "../../providerWorker/Services/ProviderWorkerBroker";
import { ProviderWorkerProvisioningError } from "../../providerWorker/Errors";
import {
  decodeProviderWorkerRuntimeBinding,
  type ProviderWorkerRuntimeBinding,
} from "../../providerWorker/runtimeBinding";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter";
import type { SandboxCapacity } from "../../workspaceRuntime/SandboxCapacity";
import { providerAttachmentStoragePath } from "../providerAttachmentPaths";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { makeKeyedLock } from "../keyedLock";
import { extractLegacyPiResumeSessionFile } from "./PiAdapter.ts";
import { WorkspaceRuntime } from "../../workspaceRuntime/Services/WorkspaceRuntime";
import { ServerConfig } from "../../config.ts";
import { DurablePiEngine, type DurableThreadTarget } from "../../durable/DurablePiEngine.ts";
import type { SandboxRunner } from "../../durable/sandboxEnv.ts";
import { setHeadlessSessionSource } from "../../providerWorker/headlessSessions.ts";

export const DISTRIBUTED_PI_RUNTIME_PAYLOAD_KEY = "distributedPiRuntime";
export const DISTRIBUTED_PI_ADAPTER_KEY = "pi:railway-sandbox";

const ProviderThreadSnapshotSchema = Schema.Struct({
  threadId: ThreadId,
  turns: Schema.Array(
    Schema.Struct({
      id: TurnId,
      items: Schema.Array(Schema.Unknown),
    }),
  ),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
});

function runtimePayloadRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function persistedDistributedBinding(value: unknown): ProviderWorkerRuntimeBinding | undefined {
  return decodeProviderWorkerRuntimeBinding(
    runtimePayloadRecord(value)[DISTRIBUTED_PI_RUNTIME_PAYLOAD_KEY],
  );
}

function adapterError(
  method: string,
  detail: string,
  cause?: unknown,
  options?: { readonly retryable?: boolean },
) {
  return new ProviderAdapterRequestError({
    provider: "pi",
    method,
    detail,
    ...(options?.retryable === true ? { retryable: true } : {}),
    ...(cause === undefined ? {} : { cause }),
  });
}

export const makeRoutedPiAdapterWithCapacity = (capacity?: SandboxCapacity) => Effect.gen(function* () {
  const local = yield* PiAdapter;
  const provisioner = yield* ProviderWorkerProvisioner;
  const broker = yield* ProviderWorkerBroker;
  const directory = yield* ProviderSessionDirectory;
  const agentGatewayCredentials = Option.getOrUndefined(
    yield* Effect.serviceOption(AgentGatewayCredentials),
  );
  const remoteByThread = new Map<string, ProviderWorkerRuntimeBinding>();
  const remoteGatewayTokenByThread = new Map<string, string>();
  const workspaceRuntime = yield* WorkspaceRuntime;
  const serverConfig = yield* ServerConfig;
  // Durable threads run the Pi agent loop in this process; their sandboxes only run tools.
  const durableEnabled = ["1", "true"].includes(process.env.SYNARA_PI_DURABLE?.trim().toLowerCase() ?? "");
  const durableEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sandboxRunner = (binding: ProviderWorkerRuntimeBinding): SandboxRunner => ({
    run: (command, options) =>
      Effect.runPromise(
        workspaceRuntime
          .exec(binding.workspace, { command, ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}) })
          .pipe(Effect.map((result) => ({
            exitCode: result.exitCode,
            output: result.stdout + result.stderr,
            timedOut: result.timedOut,
            truncated: result.truncated,
          }))),
      ),
    upload: (filePath, data) =>
      Effect.runPromise(workspaceRuntime.writeFile(binding.workspace, { path: filePath, data, mode: 0o644 })),
  });
  const mutationLock = makeKeyedLock<string>();
  type CheckpointRequest = {
    readonly binding: ProviderWorkerRuntimeBinding;
    readonly eventId: string;
    readonly turnId?: TurnId;
    readonly terminal: boolean;
  };
  type CheckpointWorker = {
    readonly done: Deferred.Deferred<void>;
    terminalDone: Deferred.Deferred<void> | undefined;
    pending: CheckpointRequest | undefined;
    lastEventId: string;
  };
  const checkpointWorkers = new Map<string, CheckpointWorker>();
  let checkpointClosing = false;
  const awaitCheckpoint = (threadId: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const worker = checkpointWorkers.get(threadId);
      return worker?.terminalDone
        ? Deferred.await(worker.terminalDone).pipe(Effect.andThen(awaitCheckpoint(threadId)))
        : Effect.void;
    });
  const checkpointScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Effect.suspend(() => {
      checkpointClosing = true;
      return Effect.forEach(Array.from(checkpointWorkers.values()), (worker) => Deferred.await(worker.done),
        { concurrency: "unbounded", discard: true });
    }).pipe(Effect.ensuring(Scope.close(scope, Exit.void))),
  );
  const withCheckpointBarrier = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    mutationLock.withLock(threadId, awaitCheckpoint(threadId).pipe(Effect.andThen(effect)));
  const scheduleCheckpoint = (threadId: string, request: CheckpointRequest) =>
    Effect.uninterruptible(Effect.suspend(() => {
      if (checkpointClosing) return Effect.interrupt;
      const existing = checkpointWorkers.get(threadId);
      if (existing) {
        if (existing.lastEventId === request.eventId) return Effect.void;
        existing.lastEventId = request.eventId;
        if (request.terminal && !existing.terminalDone) existing.terminalDone = Deferred.makeUnsafe<void>();
        // A terminal capture also reads the Outbox; file-change bursts need only
        // one pending read and must not replace a pending terminal capture.
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
        const binding = remoteByThread.get(threadId);
        if (!binding || binding.fence.lifecycleGeneration !== next.binding.fence.lifecycleGeneration ||
            binding.fence.sandboxId !== next.binding.fence.sandboxId || binding.fence.workerId !== next.binding.fence.workerId) {
          return finishTerminal.pipe(Effect.andThen(drain()));
        }
        const checkpoint = next.terminal && provisioner.checkpointWorkspace
          ? provisioner.checkpointWorkspace(binding).pipe(
              Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt :
                Effect.logWarning("provider native session checkpoint deferred", { threadId, cause })),
            )
          : Effect.void;
        return checkpoint.pipe(
          Effect.andThen(provisioner.checkpointOutbox(binding, next.turnId)),
          Effect.asVoid,
          Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt :
            Effect.logWarning("provider Outbox terminal checkpoint deferred", {
              threadId, sandboxId: binding.workspace.runtimeId, cause,
            })),
          Effect.andThen(finishTerminal),
          Effect.andThen(drain()),
        );
      });
      // Register the barrier before the event is forwarded, and retain the job
      // in the adapter scope even if its stream subscription is restarted.
      return drain().pipe(
        Effect.interruptible,
        Effect.ensuring(Effect.suspend(() => {
          if (checkpointWorkers.get(threadId) === worker) checkpointWorkers.delete(threadId);
          return Deferred.succeed(worker.done, undefined).pipe(Effect.andThen(worker.terminalDone
            ? Deferred.succeed(worker.terminalDone, undefined) : Effect.void));
        })),
        Effect.forkIn(checkpointScope),
        Effect.asVoid,
      );
    }));
  const workspaceUnavailable = (binding: ProviderWorkerRuntimeBinding) =>
    provisioner.isWorkspaceUnavailable?.(binding) ?? Effect.succeed(false);
  const retainFailedWorker = (binding: ProviderWorkerRuntimeBinding) =>
    binding.workspace.runtimeKind === "daytona-sandbox" && provisioner.park
      ? provisioner.park(binding) : provisioner.stop(binding);
  const revokeRemoteGatewayToken = (threadId: string) => {
    const token = remoteGatewayTokenByThread.get(threadId);
    if (token && agentGatewayCredentials) agentGatewayCredentials.revokeSessionToken(token);
    remoteGatewayTokenByThread.delete(threadId);
  };
  const capacityEvents = capacity === undefined
    ? undefined
    : yield* PubSub.unbounded<ProviderRuntimeEvent>();
  if (capacity !== undefined && capacityEvents !== undefined) {
    let sequence = 0;
    let previousQueued = new Map<
      string,
      { readonly threadId: string; readonly lifecycleGeneration: string; readonly position: number }
    >();
    capacity.subscribe((snapshot) => {
      const queued = new Map<
        string,
        { readonly threadId: string; readonly lifecycleGeneration: string; readonly position: number }
      >();
      for (const entry of snapshot.queued) {
        const reservation = capacity.reservation(entry.key);
        if (!reservation) continue;
        const current = { ...reservation, position: entry.position };
        queued.set(entry.key, current);
        if (previousQueued.get(entry.key)?.position === entry.position) continue;
        sequence += 1;
        Effect.runSync(PubSub.publish(capacityEvents, {
          type: "runtime.capacity.changed",
          eventId: EventId.makeUnsafe(`sandbox-capacity-${Date.now()}-${sequence}`),
          provider: "pi",
          threadId: ThreadId.makeUnsafe(current.threadId),
          lifecycleGeneration: current.lifecycleGeneration,
          createdAt: new Date().toISOString() as never,
          payload: { state: "queued", queuePosition: entry.position },
        }));
      }
      for (const [key, previous] of previousQueued) {
        if (queued.has(key)) continue;
        sequence += 1;
        Effect.runSync(PubSub.publish(capacityEvents, {
          type: "runtime.capacity.changed",
          eventId: EventId.makeUnsafe(`sandbox-capacity-${Date.now()}-${sequence}`),
          provider: "pi",
          threadId: ThreadId.makeUnsafe(previous.threadId),
          lifecycleGeneration: previous.lifecycleGeneration,
          createdAt: new Date().toISOString() as never,
          payload: {
            state: snapshot.activeKeys.includes(key) ? "acquired" : "cancelled",
          },
        }));
      }
      previousQueued = queued;
    });
  }

  const requestUnknown = (
    binding: ProviderWorkerRuntimeBinding,
    method: ProviderWorkerMethod,
    params: unknown,
  ) => {
    const request = binding.headless ? durableRequest(binding, method, params) : broker.request(binding.fence, method, params);
    const mutates = ["session.start", "turn.send", "turn.steer", "turn.interrupt", "request.respond",
      "userInput.respond", "thread.rollback", "thread.compact"].includes(method);
    return (mutates && provisioner.withWorkspaceMutation ? provisioner.withWorkspaceMutation(binding, request) : request).pipe(
      Effect.mapError((cause) =>
        adapterError(method, `Remote Pi worker request '${method}' failed.`, cause),
      ),
    );
  };

  const requestDecoded = <A, I>(
    binding: ProviderWorkerRuntimeBinding,
    method: ProviderWorkerMethod,
    params: unknown,
    schema: Schema.Codec<A, I>,
  ) =>
    requestUnknown(binding, method, params).pipe(
      Effect.flatMap((result) => Schema.decodeUnknownEffect(schema)(result)),
      Effect.mapError((cause) =>
        cause instanceof ProviderAdapterRequestError
          ? cause
          : adapterError(method, `Remote Pi worker returned an invalid '${method}' result.`, cause),
      ),
    );

  const route = <A, E>(
    threadId: string,
    remote: (binding: ProviderWorkerRuntimeBinding) => Effect.Effect<A, E>,
    localEffect: Effect.Effect<A, E>,
    mutates = false,
  ) => {
    const routed = Effect.suspend(() => {
      const cached = remoteByThread.get(threadId);
      // After a restart a durable thread may still be running; find its sandbox binding.
      const resolved: Effect.Effect<ProviderWorkerRuntimeBinding | undefined> = cached || !engine?.isDurableThread(threadId)
        ? Effect.succeed(cached)
        : loadPersistedRemote(ThreadId.makeUnsafe(threadId)).pipe(
            Effect.tap((binding) => Effect.sync(() => {
              if (binding?.headless) remoteByThread.set(threadId, binding);
            })),
            Effect.orElseSucceed(() => undefined),
          );
      return resolved.pipe(Effect.flatMap((binding) => binding ? (mutates && provisioner.markWorkspaceMutation
        ? provisioner.markWorkspaceMutation(binding).pipe(
            Effect.mapError((cause) => adapterError("workspace.mutation", "Could not preserve native workspace recovery coverage.", cause)),
            Effect.andThen(remote(binding)),
          ) : remote(binding)) : localEffect));
    });
    return mutates ? withCheckpointBarrier(threadId, routed) : routed;
  };

  const loadPersistedRemote = (threadId: Parameters<PiAdapterShape["hasSession"]>[0]) =>
    directory.getBinding(threadId).pipe(
      Effect.map((binding) =>
        Option.match(binding, {
          onNone: () => undefined,
          onSome: (value) => persistedDistributedBinding(value.runtimePayload),
        }),
      ),
      Effect.mapError((cause) =>
        adapterError(
          "runtime.binding.read",
          "Failed to read the persisted remote Pi runtime binding.",
          cause,
        ),
      ),
    );

  const persistRemoteBinding = (input: {
    readonly threadId: Parameters<PiAdapterShape["hasSession"]>[0];
    readonly lifecycleGeneration: string;
    readonly binding: ProviderWorkerRuntimeBinding;
  }) =>
    directory
      .upsert({
        threadId: input.threadId,
        provider: "pi",
        adapterKey: DISTRIBUTED_PI_ADAPTER_KEY,
        lifecycleGeneration: input.lifecycleGeneration,
        runtimePayload: { [DISTRIBUTED_PI_RUNTIME_PAYLOAD_KEY]: input.binding },
      })
      .pipe(
        Effect.mapError((cause) =>
          adapterError("session.start", "Failed to persist the remote Pi runtime binding.", cause),
        ),
      );

  const durableTarget = (threadId: string): Promise<DurableThreadTarget | undefined> =>
    Effect.runPromise(Effect.gen(function* () {
      const binding = remoteByThread.get(threadId) ?? (yield* loadPersistedRemote(ThreadId.makeUnsafe(threadId)));
      if (!binding?.headless) return undefined;
      return {
        threadId,
        lifecycleGeneration: binding.fence.lifecycleGeneration,
        cwd: binding.cwd,
        homeDir: binding.homeDir,
        runner: sandboxRunner(binding),
        envId: binding.workspace.runtimeId,
      };
    }));
  const engine = durableEnabled
    ? yield* Effect.acquireRelease(
        Effect.promise(() =>
          DurablePiEngine.open({
            storagePath: path.join(serverConfig.stateDir, "durable", "harness.sqlite"),
            agentDir: path.join(serverConfig.stateDir, "durable", "agent"),
            target: durableTarget,
            readAttachment: async (attachment) => {
              const source = providerAttachmentStoragePath(attachment);
              return source ? new Uint8Array(await readFile(source)) : undefined;
            },
            gatewayUrl: agentGatewayCredentials?.mcpEndpointUrl,
            publish: (event) => {
              Queue.offerUnsafe(durableEvents, event);
            },
          }),
        ),
        (opened) => Effect.promise(() => opened.close()),
      )
    : undefined;
  if (engine) {
    setHeadlessSessionSource((threadId) =>
      engine.listSessions().filter((session) => threadId === undefined || session.threadId === threadId),
    );
  }
  const durableRequest = (binding: ProviderWorkerRuntimeBinding, method: ProviderWorkerMethod, params: unknown) =>
    Effect.tryPromise({
      try: async (): Promise<unknown> => {
        if (!engine) throw new Error("The durable Pi runtime is not enabled on this controller.");
        const input = params as Record<string, unknown> & { threadId: ThreadId };
        const attachmentsDir = path.posix.join(binding.homeDir, "state", "attachments");
        switch (method) {
          case "session.start":
            return engine.startSession({
              threadId: input.threadId,
              lifecycleGeneration: binding.fence.lifecycleGeneration,
              cwd: binding.cwd,
              modelSelection: input.modelSelection as never,
              runtimeMode: input.runtimeMode as never,
            });
          case "turn.send":
            return engine.sendTurn({ ...(input as object), attachmentsDir } as Parameters<DurablePiEngine["sendTurn"]>[0]);
          case "turn.steer":
            return engine.steerTurn({ ...(input as object), attachmentsDir } as Parameters<DurablePiEngine["steerTurn"]>[0]);
          case "turn.interrupt":
            return engine.interruptTurn(input.threadId, input.turnId as string | undefined);
          case "session.stop":
            return engine.stopSession(input.threadId);
          case "session.list":
            return engine.listSessions();
          case "session.has":
            return engine.hasSession(input.threadId);
          case "thread.read":
            return engine.readThread(input.threadId);
          case "thread.compact":
            return engine.compactThread(input.threadId);
          case "userInput.respond":
          case "runtime.stopAll":
            return undefined;
          default:
            throw new Error(`The durable Pi runtime does not support '${method}'.`);
        }
      },
      catch: (cause) => cause,
    });

  const stageRemoteAttachments = (
    binding: ProviderWorkerRuntimeBinding,
    attachments: Parameters<PiAdapterShape["sendTurn"]>[0]["attachments"],
    operation: "turn.send" | "turn.steer",
  ) =>
    Effect.gen(function* () {
      const staged = (attachments ?? []).flatMap((attachment) => {
        if (attachment.type === "assistant-selection") return [];
        const sourcePath = providerAttachmentStoragePath(attachment);
        return sourcePath ? [{ attachment, sourcePath }] : [];
      });
      const fileCount = (attachments ?? []).filter(
        (attachment) => attachment.type !== "assistant-selection",
      ).length;
      if (staged.length !== fileCount) {
        return yield* adapterError(
          `${operation}.attachments`,
          "A claimed attachment lost its authorized storage path before sandbox staging.",
        );
      }
      if (staged.length === 0) return;
      yield* provisioner.stageAttachments(binding, staged).pipe(
        Effect.mapError((cause) =>
          adapterError(
            `${operation}.attachments`,
            "Failed to stage attachments in the remote Pi sandbox.",
            cause,
          ),
        ),
      );
    });

  const startSession: PiAdapterShape["startSession"] = (input) =>
    withCheckpointBarrier(input.threadId, Effect.gen(function* () {
      const persisted = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      const persistedRemote = persistedDistributedBinding(persisted?.runtimePayload);
      const activeRemote = remoteByThread.get(input.threadId);
      // ProviderService recovery supplies the native cursor; its repository coordinates live in this binding.
      const repositoryBinding = input.repositoryBinding ??
        (input.resumeCursor !== undefined ? ((activeRemote ?? persistedRemote)?.repositoryCheckout?.binding ?? (activeRemote ?? persistedRemote)?.repositoryUnavailable?.binding) : undefined);

      if (repositoryBinding === undefined) {
        const remote = activeRemote ?? persistedRemote;
        if (remote) {
          yield* provisioner.stop(remote).pipe(
            Effect.mapError((cause) =>
              adapterError("session.start", "Failed to retire the previous remote Pi runtime.", cause),
            ),
          );
          remoteByThread.delete(input.threadId);
          revokeRemoteGatewayToken(input.threadId);
        }
        return yield* local.startSession(input);
      }

      const lifecycleGeneration = input.lifecycleGeneration ?? randomLifecycleGeneration();
      const legacyPiResumeSessionFile = extractLegacyPiResumeSessionFile(input.resumeCursor);
      const previous = activeRemote ?? persistedRemote;
      const migratingToDaytona = process.env.SYNARA_WORKSPACE_RUNTIME === "daytona" &&
        previous?.workspace.runtimeKind === "railway-sandbox";
      const prepared = activeRemote && activeRemote.workspace.runtimeKind === "daytona-sandbox" &&
        activeRemote.fence.lifecycleGeneration === lifecycleGeneration;
      const preparedToken = prepared ? remoteGatewayTokenByThread.get(input.threadId) : undefined;
      const agentGatewayConnection = preparedToken && agentGatewayCredentials
        ? { url: agentGatewayCredentials.mcpEndpointUrl, bearerToken: preparedToken }
        : agentGatewayCredentials?.repositoryConnectionForThread(input.threadId, "pi");
      const previousGatewayToken = remoteGatewayTokenByThread.get(input.threadId);
      // New threads, and threads already durable, use the in-controller agent loop.
      const headless = engine !== undefined && (previous === undefined || previous.headless === true);
      const launch = () =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const provisionExit = yield* Effect.exit(
              restore(
                prepared
                  ? Effect.succeed(previous)
                  : previous && !migratingToDaytona
                  ? provisioner.restart(previous, {
                      threadId: input.threadId,
                      lifecycleGeneration,
                      ...(headless ? { headless: true } : {}),
                      ...(legacyPiResumeSessionFile ? { legacyPiResumeSessionFile } : {}),
                      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                      repositoryBinding,
                      ...(agentGatewayConnection === undefined
                        ? {}
                        : { agentGatewayConnection }),
                    })
                  : provisioner.start({
                      threadId: input.threadId,
                      lifecycleGeneration,
                      ...(headless ? { headless: true } : {}),
                      ...(legacyPiResumeSessionFile ? { legacyPiResumeSessionFile } : {}),
                      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                      repositoryBinding,
                      ...(agentGatewayConnection === undefined
                        ? {}
                        : { agentGatewayConnection }),
                    }),
              ),
            );
            if (Exit.isFailure(provisionExit)) {
              return yield* Effect.failCause(provisionExit.cause);
            }
            const binding = provisionExit.value;
            const { repositoryBinding: _repositoryBinding, ...workerInput } = input;
            const startExit = yield* Effect.exit(
              restore(
                Effect.gen(function* () {
                  yield* provisioner.markWorkspaceMutation?.(binding) ?? Effect.void;
                  const session = yield* requestDecoded(
                    binding,
                    "session.start",
                    { ...workerInput, cwd: binding.cwd, lifecycleGeneration },
                    ProviderSession,
                  );
                  yield* persistRemoteBinding({
                    threadId: input.threadId,
                    lifecycleGeneration,
                    binding,
                  });
                  yield* provisioner.adopt(binding);
                  remoteByThread.set(input.threadId, binding);
                  return session;
                }),
              ),
            );
            if (Exit.isSuccess(startExit)) return startExit.value;
            const cleanupExit = yield* Effect.exit((binding.workspace.runtimeKind === "daytona-sandbox"
              ? persistRemoteBinding({ threadId: input.threadId, lifecycleGeneration, binding }).pipe(
                  Effect.andThen(provisioner.adopt(binding)),
                )
              : Effect.void).pipe(Effect.ensuring(retainFailedWorker(binding))));
            if (Exit.isFailure(cleanupExit)) {
              return yield* adapterError(
                "session.start.cleanup",
                "Remote Pi launch failed and its worker could not be safely retired.",
                Cause.squash(cleanupExit.cause),
              );
            }
            return yield* Effect.failCause(startExit.cause);
          }),
        );
      return yield* launch().pipe(
        observeProviderOperation("worker.provision", { threadId: input.threadId, lifecycleGeneration }),
        Effect.tap(() =>
          Effect.sync(() => {
            if (agentGatewayConnection !== undefined) {
              remoteGatewayTokenByThread.set(
                input.threadId,
                agentGatewayConnection.bearerToken,
              );
            }
            if (
              previousGatewayToken &&
              previousGatewayToken !== agentGatewayConnection?.bearerToken &&
              agentGatewayCredentials
            ) {
              agentGatewayCredentials.revokeSessionToken(previousGatewayToken);
            }
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            if (agentGatewayConnection && agentGatewayCredentials) {
              agentGatewayCredentials.revokeSessionToken(agentGatewayConnection.bearerToken);
            }
          }),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof ProviderAdapterRequestError ||
        cause instanceof ProviderAdapterSessionNotFoundError
          ? cause
          : adapterError(
              "session.start",
              "Failed to start the selected Pi execution target.",
              cause,
              { retryable: cause instanceof ProviderWorkerProvisioningError },
            ),
      ),
    ));

  const prepareWorkspace: NonNullable<PiAdapterShape["prepareWorkspace"]> = (input) =>
    withCheckpointBarrier(input.threadId, Effect.gen(function* () {
      if (process.env.SYNARA_WORKSPACE_RUNTIME !== "daytona" || !input.repositoryBinding ||
          !input.lifecycleGeneration || capacity?.snapshot().queued.length) return false;
      const gateway = agentGatewayCredentials?.repositoryConnectionForThread(input.threadId, "pi");
      const previous = remoteByThread.get(input.threadId) ?? (yield* loadPersistedRemote(input.threadId));
      const legacyPiResumeSessionFile = extractLegacyPiResumeSessionFile(input.resumeCursor);
      const provisionInput = {
        threadId: input.threadId, lifecycleGeneration: input.lifecycleGeneration,
        repositoryBinding: input.repositoryBinding, speculative: true,
        ...(engine !== undefined && (previous === undefined || previous.headless === true) ? { headless: true } : {}),
        ...(legacyPiResumeSessionFile ? { legacyPiResumeSessionFile } : {}),
        ...(gateway ? { agentGatewayConnection: gateway } : {}),
      };
      const binding = yield* (previous?.workspace.runtimeKind === "daytona-sandbox"
        ? provisioner.restart(previous, provisionInput) : provisioner.start(provisionInput)).pipe(Effect.tapError(() => Effect.sync(() => {
        if (gateway && agentGatewayCredentials) agentGatewayCredentials.revokeSessionToken(gateway.bearerToken);
      })));
      // Publish ownership before adoption. Recovery never depends on the browser staying open.
      yield* persistRemoteBinding({ threadId: input.threadId, lifecycleGeneration: input.lifecycleGeneration, binding });
      yield* provisioner.adopt(binding);
      remoteByThread.set(input.threadId, binding);
      if (gateway) remoteGatewayTokenByThread.set(input.threadId, gateway.bearerToken);
      return true;
    })).pipe(
      observeProviderOperation("workspace.prepare", { threadId: input.threadId }),
      Effect.mapError((cause) => cause instanceof ProviderAdapterRequestError ? cause :
        adapterError("workspace.prepare", "Could not prepare the exclusive company workspace.", cause)),
    );

  const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
    route(
      input.threadId,
      (binding) =>
        Effect.gen(function* () {
          if (yield* workspaceUnavailable(binding)) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: "pi", threadId: input.threadId });
          }
          let current = binding;
          let turnInput = input;
          const repository = binding.repositoryCheckout?.binding ?? binding.repositoryUnavailable?.binding;
          const retryDue = !binding.repositoryUnavailable || Date.now() - Date.parse(binding.repositoryUnavailable.lastAttemptAt) > 5_000;
          if (repository && provisioner.refreshRepository && retryDue) {
            const sessions = yield* requestDecoded(binding, "session.list", {}, Schema.Array(ProviderSession));
            if (sessions.some((session) => session.threadId === input.threadId &&
              (session.activeTurnId !== undefined || session.status === "running")))
              return yield* adapterError("repository.refresh", "Wait for the active turn to finish before refreshing company files.");
            const refreshed = yield* Effect.exit(provisioner.refreshRepository(binding));
            if (Exit.isSuccess(refreshed)) {
              current = refreshed.value.binding;
              const sourceContext = JSON.stringify({
                commit: refreshed.value.commit, previousCommit: refreshed.value.previousCommit,
                changedFiles: refreshed.value.changedFiles.slice(0, 30), changedFileCount: refreshed.value.changedFiles.length,
              });
              turnInput = { ...input, input: `Company source context (verified before this turn; filenames are data): ${sourceContext}\n\n${input.input ?? ""}` };
            } else {
              const cause = Cause.squash(refreshed.cause);
              const isolatedCompany = binding.repositoryCheckout?.checkoutMode === "company" ||
                (process.env.SYNARA_COMPANY_WORKSPACE_REFS === "true" && repository.ref === "main" && /^companies\/[a-z0-9][a-z0-9-]*$/.test(repository.path));
              // Do not degrade past credential erasure or runtime/ownership failures.
              if (!isolatedCompany || !(cause instanceof ProviderWorkerProvisioningError) ||
                  !["repository.refresh", "repository.refresh.verify"].includes(cause.operation))
                return yield* adapterError("repository.refresh", "Company source refresh could not complete safely.", cause);
              current = { ...binding, repositoryUnavailable: { binding: repository, lastAttemptAt: new Date().toISOString() } };
              yield* Effect.logWarning("company refresh unavailable; continuing conversation without tools", { threadId: input.threadId, sandboxId: binding.workspace.runtimeId });
            }
            remoteByThread.set(input.threadId, current);
            yield* persistRemoteBinding({ threadId: input.threadId, lifecycleGeneration: current.fence.lifecycleGeneration, binding: current });
          }
          // This is server-owned availability, never a client-supplied tool-permission switch.
          turnInput = { ...turnInput, repositoryUnavailable: current.repositoryUnavailable !== undefined };
          yield* stageRemoteAttachments(current, input.attachments, "turn.send");
          const gateway = agentGatewayCredentials?.repositoryConnectionForThread(input.threadId, "pi");
          if (gateway) {
            revokeRemoteGatewayToken(input.threadId);
            remoteGatewayTokenByThread.set(input.threadId, gateway.bearerToken);
          }
          return yield* requestDecoded(
            current,
            "turn.send",
            { ...turnInput, ...(gateway ? { gatewayBearerToken: gateway.bearerToken } : {}) },
            ProviderTurnStartResult,
          ).pipe(
            Effect.catch((cause) =>
              retainFailedWorker(current).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    remoteByThread.delete(input.threadId);
                    revokeRemoteGatewayToken(input.threadId);
                  }),
                ),
                Effect.mapError((cleanupCause) =>
                  adapterError(
                    "turn.send.cleanup",
                    "A remote Pi turn became uncertain and its worker could not be safely retired.",
                    cleanupCause,
                  ),
                ),
                Effect.andThen(Effect.fail(cause)),
              ),
            ),
          );
        }),
      local.sendTurn(input),
      true,
    );

  const requireRepositoryBinding = Effect.fnUntraced(function* (
    threadId: ThreadId,
    operation: string,
  ) {
    const binding = remoteByThread.get(threadId) ?? (yield* loadPersistedRemote(threadId));
    if (!binding?.repositoryCheckout || binding.repositoryUnavailable) {
      return yield* adapterError(
        operation,
        "The Pi session does not have a repository-bound sandbox.",
      );
    }
    return { ...binding, repositoryCheckout: binding.repositoryCheckout };
  });

  const requireIdleRepositoryBinding = Effect.fnUntraced(function* (
    threadId: ThreadId,
    operation: string,
  ) {
    const binding = yield* requireRepositoryBinding(threadId, operation);
    const sessions = yield* requestDecoded(
      binding,
      "session.list",
      {},
      Schema.Array(ProviderSession),
    );
    const session = sessions.find((candidate) => candidate.threadId === threadId);
    if (session?.activeTurnId !== undefined || session?.status === "running") {
      return yield* adapterError(
        operation,
        "Wait for the active Pi turn to finish before accessing sandbox files.",
      );
    }
    return binding;
  });

  const requireReadableOutboxBinding = Effect.fnUntraced(function* (
    threadId: ThreadId,
    operation: string,
  ) {
    const binding = yield* requireRepositoryBinding(threadId, operation);
    if (!remoteByThread.has(threadId)) return binding;
    const sessions = yield* requestDecoded(
      binding,
      "session.list",
      {},
      Schema.Array(ProviderSession),
    );
    const session = sessions.find((candidate) => candidate.threadId === threadId);
    if (session?.activeTurnId !== undefined || session?.status === "running") {
      return yield* adapterError(
        operation,
        "Wait for the active Pi turn to finish before accessing sandbox files.",
      );
    }
    return binding;
  });

  const listPersistenceCandidates: NonNullable<PiAdapterShape["listPersistenceCandidates"]> =
    (threadId) =>
      withCheckpointBarrier(threadId, Effect.gen(function* () {
        const binding = yield* requireReadableOutboxBinding(threadId, "persistence.list");
        return yield* provisioner.listPersistenceCandidates(binding).pipe(
          Effect.mapError((cause) =>
            adapterError(
              "persistence.list",
              "The sandbox files available to save could not be listed.",
              cause,
            ),
          ),
        );
      }));

  const readPersistenceCandidate: NonNullable<PiAdapterShape["readPersistenceCandidate"]> =
    (threadId, lifecycleGeneration, selection) =>
      withCheckpointBarrier(threadId, Effect.gen(function* () {
        const binding =
          selection.source === "outbox"
            ? yield* requireReadableOutboxBinding(threadId, "persistence.read")
            : yield* requireIdleRepositoryBinding(threadId, "persistence.read");
        if (binding.fence.lifecycleGeneration !== lifecycleGeneration) {
          return yield* adapterError(
            "persistence.read",
            "The sandbox changed after these files were reviewed. Refresh and select them again.",
          );
        }
        return yield* provisioner.readPersistenceCandidate(binding, selection).pipe(
          Effect.mapError((cause) =>
            adapterError(
              "persistence.read",
              "The selected sandbox file could not be read safely.",
              cause,
            ),
          ),
        );
      }));

  const readWorkspaceFile: NonNullable<PiAdapterShape["readWorkspaceFile"]> = (threadId, filePath) =>
    withCheckpointBarrier(threadId, Effect.gen(function* () {
      const binding = yield* requireRepositoryBinding(threadId, "workspace.file.read");
      if (!provisioner.readWorkspaceFile) return yield* adapterError("workspace.file.read", "Workspace file preview is unavailable.");
      return yield* provisioner.readWorkspaceFile(binding, filePath).pipe(
        Effect.mapError((cause) => adapterError("workspace.file.read", cause.detail, cause)),
      );
    }));

  const readOutboxCheckpoint: NonNullable<PiAdapterShape["readOutboxCheckpoint"]> =
    (threadId, candidatePath) =>
      provisioner.readOutboxCheckpoint(threadId, candidatePath).pipe(
        Effect.mapError((cause) =>
          adapterError(
            "persistence.checkpoint.read",
            "The durable Outbox file could not be read.",
            cause,
          ),
        ),
      );

  const reconcileRepository: NonNullable<PiAdapterShape["reconcileRepository"]> = (
    threadId,
    commit,
    persistedFiles = [],
    activeTurnId,
    workspaceCommit,
  ) =>
    withCheckpointBarrier(threadId, Effect.gen(function* () {
      const persistedBinding = yield* requireRepositoryBinding(threadId, "repository.reconcile");
      yield* provisioner.markOutboxPromoted(persistedBinding, persistedFiles);
      const binding = activeTurnId === undefined
        ? yield* requireIdleRepositoryBinding(threadId, "repository.reconcile")
        : persistedBinding;
      if (activeTurnId !== undefined) {
        const sessions = yield* requestDecoded(binding, "session.list", {}, Schema.Array(ProviderSession));
        if (sessions.find((session) => session.threadId === threadId)?.activeTurnId !== activeTurnId)
          return yield* adapterError("repository.reconcile", "The requesting agent turn is no longer active.");
      }
      const previousCommit = binding.repositoryCheckout.commit;
      const targetCommit = binding.repositoryCheckout.checkoutMode === "company" ? workspaceCommit : commit;
      if (!targetCommit || !/^[a-f0-9]{40}$/.test(targetCommit))
        return yield* adapterError("repository.reconcile", "The saved company snapshot is not available; existing edits are retained.");
      const reconciled = yield* provisioner.reconcileRepository(
        binding,
        targetCommit,
        persistedFiles,
        activeTurnId,
      ).pipe(
        Effect.mapError((cause) =>
          adapterError(
            "repository.reconcile",
            "The saved commit could not be applied to the current sandbox without overwriting local work.",
            cause,
          ),
        ),
      );
      remoteByThread.set(threadId, reconciled);
      yield* persistRemoteBinding({
        threadId,
        lifecycleGeneration: reconciled.fence.lifecycleGeneration,
        binding: reconciled,
      });
      return {
        runtimeId: reconciled.workspace.runtimeId,
        previousCommit,
        commit: reconciled.repositoryCheckout?.commit ?? commit,
      };
    }));

  const steerTurn: NonNullable<PiAdapterShape["steerTurn"]> = (input) =>
    route(
      input.threadId,
      (binding) =>
        Effect.gen(function* () {
          yield* stageRemoteAttachments(binding, input.attachments, "turn.steer");
          return yield* requestDecoded(binding, "turn.steer", input, ProviderTurnStartResult);
        }),
      local.steerTurn
        ? local.steerTurn(input)
        : Effect.fail(adapterError("turn.steer", "Local Pi turn steering is unavailable.")),
      true,
    );

  const interruptTurn: PiAdapterShape["interruptTurn"] = (
    threadId,
    turnId,
    providerThreadId,
  ) =>
    route(
      threadId,
      (binding) =>
        requestUnknown(binding, "turn.interrupt", {
          threadId,
          ...(turnId === undefined ? {} : { turnId }),
          ...(providerThreadId === undefined ? {} : { providerThreadId }),
        }).pipe(Effect.asVoid),
      local.interruptTurn(threadId, turnId, providerThreadId),
      true,
    );

  const respondToRequest: PiAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    route(
      threadId,
      (binding) =>
        requestUnknown(binding, "request.respond", { threadId, requestId, decision }).pipe(
          Effect.asVoid,
        ),
      local.respondToRequest(threadId, requestId, decision),
      true,
    );

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    route(
      threadId,
      (binding) =>
        requestUnknown(binding, "userInput.respond", { threadId, requestId, answers }).pipe(
          Effect.asVoid,
        ),
      local.respondToUserInput(threadId, requestId, answers),
      true,
    );

  const stopRemoteSession = (threadId: Parameters<PiAdapterShape["stopSession"]>[0], park: boolean) =>
    withCheckpointBarrier(threadId, Effect.gen(function* () {
      const binding = remoteByThread.get(threadId) ?? (yield* loadPersistedRemote(threadId));
      if (!binding) return yield* local.stopSession(threadId);
      const preserve = park && binding.workspace.runtimeKind === "daytona-sandbox" && provisioner.park;
      if (!(yield* workspaceUnavailable(binding))) yield* requestUnknown(binding, "session.stop", { threadId }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(
            "Remote Pi session.stop response was lost; retiring the bound worker.",
            cause,
          ),
        ),
        Effect.catch(() => Effect.void),
      );
      yield* (preserve ? preserve(binding) : provisioner.stop(binding)).pipe(
        Effect.mapError((cause) =>
          adapterError("session.stop", "Failed to retire the remote Pi runtime.", cause),
        ),
      );
      remoteByThread.delete(threadId);
      revokeRemoteGatewayToken(threadId);
    }));

  const stopSession: PiAdapterShape["stopSession"] = (threadId) => stopRemoteSession(threadId, false);
  const parkSession: NonNullable<PiAdapterShape["parkSession"]> = (threadId) => stopRemoteSession(threadId, true);

  const listSessions: PiAdapterShape["listSessions"] = (threadId) =>
    Effect.suspend(() => Effect.all([
      local.listSessions(threadId),
      Effect.forEach((threadId === undefined ? Array.from(remoteByThread.values())
        : [remoteByThread.get(threadId)].flatMap((binding) => binding ? [binding] : [])).filter((binding) => !binding.headless), (binding) =>
        workspaceUnavailable(binding).pipe(
          Effect.flatMap((unavailable) => unavailable
            ? Effect.succeed([] as const)
            : requestDecoded(binding, "session.list", {}, Schema.Array(ProviderSession))),
          Effect.catch((cause) =>
            Effect.logWarning("remote Pi session discovery unavailable", {
              sandboxId: binding.fence.sandboxId,
              detail: cause.detail,
            }).pipe(Effect.as([] as const)),
          ),
        ),
      ).pipe(Effect.map((groups) => groups.flat())),
    ]).pipe(Effect.map(([localSessions, remoteSessions]) => [
      ...localSessions,
      ...remoteSessions,
      ...(engine?.listSessions().filter((session) => threadId === undefined || session.threadId === threadId) ?? []),
    ])));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    route(
      threadId,
      (binding) => workspaceUnavailable(binding).pipe(
        Effect.flatMap((unavailable) => unavailable
          ? Effect.succeed(false)
          : requestDecoded(binding, "session.has", { threadId }, Schema.Boolean)),
      ),
      local.hasSession(threadId),
    );

  const readThread: PiAdapterShape["readThread"] = (threadId) =>
    route(
      threadId,
      (binding) =>
        requestDecoded(binding, "thread.read", { threadId }, ProviderThreadSnapshotSchema).pipe(
          Effect.map((snapshot) => snapshot as ProviderThreadSnapshot),
        ),
      local.readThread(threadId),
    );

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    route(
      threadId,
      (binding) =>
        requestDecoded(
          binding,
          "thread.rollback",
          { threadId, numTurns },
          ProviderThreadSnapshotSchema,
        ).pipe(Effect.map((snapshot) => snapshot as ProviderThreadSnapshot)),
      local.rollbackThread(threadId, numTurns),
      true,
    );

  const compactThread: NonNullable<PiAdapterShape["compactThread"]> = (threadId) =>
    route(
      threadId,
      (binding) =>
        requestUnknown(binding, "thread.compact", { threadId }).pipe(Effect.asVoid),
      local.compactThread
        ? local.compactThread(threadId)
        : Effect.fail(adapterError("thread.compact", "Local Pi compaction is unavailable.")),
      true,
    );

  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      const bindings = new Map<string, ProviderWorkerRuntimeBinding>();
      for (const persisted of yield* directory.listBindings()) {
        if (persisted.provider !== "pi") continue;
        const remote = persistedDistributedBinding(persisted.runtimePayload);
        if (remote) bindings.set(persisted.threadId, remote);
      }
      for (const [threadId, binding] of remoteByThread) bindings.set(threadId, binding);

      yield* Effect.forEach(
        Array.from(bindings.entries()),
        ([threadId, binding]) =>
          withCheckpointBarrier(threadId, Effect.suspend(() => {
            const current = remoteByThread.get(threadId) ?? binding;
            return current.workspace.runtimeKind === "daytona-sandbox" && provisioner.park
              ? provisioner.park(current) : provisioner.stop(current);
          }).pipe(
            Effect.tap(() => Effect.sync(() => remoteByThread.delete(threadId))),
            Effect.tap(() => Effect.sync(() => revokeRemoteGatewayToken(threadId))),
            Effect.mapError((cause) =>
              adapterError("runtime.stopAll", "Failed to destroy a remote Pi runtime.", cause),
            ),
          )),
        { discard: true },
      );
      yield* local.stopAll();
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof ProviderAdapterRequestError
          ? cause
          : adapterError("runtime.stopAll", "Failed to stop all Pi runtimes.", cause),
      ),
    );

  const checkpointOnTerminal = (event: ProviderRuntimeEvent) => Effect.suspend(() => {
    const completedFileChange =
      event.type === "item.completed" &&
      event.payload.itemType === "file_change" &&
      event.payload.status === "completed";
    if (
      !completedFileChange &&
      event.type !== "turn.completed" &&
      event.type !== "turn.aborted"
    ) {
      return Effect.void;
    }
    const binding = remoteByThread.get(event.threadId);
    if (!binding || event.lifecycleGeneration !== binding.fence.lifecycleGeneration) return Effect.void;
    if (!completedFileChange && event.turnId) {
      const token = remoteGatewayTokenByThread.get(event.threadId);
      if (token) {
        // Each completed turn retires write authority; ProviderService rotates it on recovery.
        void agentGatewayCredentials?.retireSessionTurn(token, event.turnId);
      }
    }
    return scheduleCheckpoint(event.threadId, {
      binding, eventId: event.eventId, terminal: !completedFileChange,
      ...(event.turnId ? { turnId: event.turnId } : {}),
    });
  });

  return {
    provider: "pi",
    capabilities: local.capabilities,
    managesStartSessionTimeout: (input) =>
      capacity !== undefined && input.repositoryBinding !== undefined,
    startSession,
    prepareWorkspace,
    sendTurn,
    reconcileRepository,
    listPersistenceCandidates,
    readPersistenceCandidate,
    readOutboxCheckpoint,
    readWorkspaceFile,
    steerTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    parkSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    compactThread,
    stopAll,
    listModels: local.listModels,
    listSkills: local.listSkills,
    listCommands: local.listCommands,
    getComposerCapabilities: local.getComposerCapabilities,
    get streamEvents() {
      const remoteEvents = Stream.merge(
        broker.streamEvents,
        Stream.fromQueue(durableEvents),
      ).pipe(Stream.tap(checkpointOnTerminal));
      const providerEvents = Stream.merge(local.streamEvents, remoteEvents);
      return capacityEvents === undefined
        ? providerEvents
        : Stream.merge(providerEvents, Stream.fromPubSub(capacityEvents));
    },
  } satisfies PiAdapterShape;
});

export const makeRoutedPiAdapter = makeRoutedPiAdapterWithCapacity();

function randomLifecycleGeneration(): string {
  return `remote-${Date.now().toString(36)}`;
}

export const makeRoutedPiAdapterLive = (capacity?: SandboxCapacity) =>
  Layer.effect(PiAdapter, makeRoutedPiAdapterWithCapacity(capacity));

export const RoutedPiAdapterLive = makeRoutedPiAdapterLive();
