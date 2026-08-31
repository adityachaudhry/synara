import {
  ProviderSession,
  ProviderTurnStartResult,
  EventId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderWorkerMethod,
} from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, PubSub, Schema, Stream } from "effect";

import { ProviderWorkerProvisioner } from "../../providerWorker/Services/ProviderWorkerProvisioner";
import { ProviderWorkerBroker } from "../../providerWorker/Services/ProviderWorkerBroker";
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

export const DISTRIBUTED_PI_RUNTIME_PAYLOAD_KEY = "distributedPiRuntime";
export const DISTRIBUTED_PI_ADAPTER_KEY = "pi:railway-sandbox";
const REMOTE_PI_LAUNCH_TIMEOUT = "60 seconds";

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

function adapterError(method: string, detail: string, cause?: unknown) {
  return new ProviderAdapterRequestError({
    provider: "pi",
    method,
    detail,
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
  ) =>
    broker.request(binding.fence, method, params).pipe(
      Effect.mapError((cause) =>
        adapterError(method, `Remote Pi worker request '${method}' failed.`, cause),
      ),
    );

  const requestDecoded = <A, I>(
    binding: ProviderWorkerRuntimeBinding,
    method: ProviderWorkerMethod,
    params: unknown,
    schema: Schema.Schema<A, I>,
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
  ) => {
    const binding = remoteByThread.get(threadId);
    return binding ? remote(binding) : localEffect;
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

  const withCapacityLaunchDeadline = <A, E, R>(
    launch: (onCapacityAdmitted: () => void) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>();
      const launchFiber = yield* launch(() => {
        Effect.runSync(Deferred.succeed(admitted, undefined));
      }).pipe(Effect.forkChild({ startImmediately: true }));
      const initial = yield* Effect.raceFirst(
        Fiber.await(launchFiber).pipe(
          Effect.map((exit) => ({ _tag: "Completed" as const, exit })),
        ),
        Deferred.await(admitted).pipe(Effect.as({ _tag: "Admitted" as const })),
      );
      if (initial._tag === "Completed") {
        return Exit.isSuccess(initial.exit)
          ? initial.exit.value
          : yield* Effect.failCause(initial.exit.cause);
      }
      const completed = yield* Fiber.await(launchFiber).pipe(
        Effect.timeoutOption(REMOTE_PI_LAUNCH_TIMEOUT),
      );
      if (Option.isSome(completed)) {
        return Exit.isSuccess(completed.value)
          ? completed.value.value
          : yield* Effect.failCause(completed.value.cause);
      }
      yield* Fiber.interrupt(launchFiber);
      const interrupted = yield* Fiber.await(launchFiber);
      if (Exit.isSuccess(interrupted)) return interrupted.value;
      if (Exit.isFailure(interrupted) && !Cause.hasInterruptsOnly(interrupted.cause)) {
        return yield* Effect.failCause(interrupted.cause);
      }
      return yield* adapterError(
        "session.start",
        "Remote Pi launch timed out 60 seconds after Railway capacity admission.",
      );
    });

  const startSession: PiAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const persisted = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      const persistedRemote = persistedDistributedBinding(persisted?.runtimePayload);
      const activeRemote = remoteByThread.get(input.threadId);

      if (input.repositoryBinding === undefined) {
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
      const previous = activeRemote ?? persistedRemote;
      const agentGatewayConnection = agentGatewayCredentials?.readOnlyConnectionForThread(
        input.threadId,
        "pi",
      );
      const previousGatewayToken = remoteGatewayTokenByThread.get(input.threadId);
      const launch = (onCapacityAdmitted?: () => void) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const provisionExit = yield* Effect.exit(
              restore(
                previous
                  ? provisioner.restart(previous, {
                      threadId: input.threadId,
                      lifecycleGeneration,
                      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                      repositoryBinding: input.repositoryBinding,
                      ...(agentGatewayConnection === undefined
                        ? {}
                        : { agentGatewayConnection }),
                      ...(onCapacityAdmitted === undefined ? {} : { onCapacityAdmitted }),
                    })
                  : provisioner.start({
                      threadId: input.threadId,
                      lifecycleGeneration,
                      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                      repositoryBinding: input.repositoryBinding,
                      ...(agentGatewayConnection === undefined
                        ? {}
                        : { agentGatewayConnection }),
                      ...(onCapacityAdmitted === undefined ? {} : { onCapacityAdmitted }),
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
            const cleanupExit = yield* Effect.exit(provisioner.stop(binding));
            if (Exit.isFailure(cleanupExit)) {
              return yield* adapterError(
                "session.start.cleanup",
                "Remote Pi launch failed and its sandbox could not be authoritatively destroyed.",
                Cause.squash(cleanupExit.cause),
              );
            }
            return yield* Effect.failCause(startExit.cause);
          }),
        );
      return yield* (capacity === undefined ? launch() : withCapacityLaunchDeadline(launch)).pipe(
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
          : adapterError("session.start", "Failed to start the selected Pi execution target.", cause),
      ),
    );

  const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
    route(
      input.threadId,
      (binding) =>
        Effect.gen(function* () {
          yield* stageRemoteAttachments(binding, input.attachments, "turn.send");
          return yield* requestDecoded(
            binding,
            "turn.send",
            input,
            ProviderTurnStartResult,
          ).pipe(
            Effect.catch((cause) =>
              provisioner.stop(binding).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    remoteByThread.delete(input.threadId);
                    revokeRemoteGatewayToken(input.threadId);
                  }),
                ),
                Effect.mapError((cleanupCause) =>
                  adapterError(
                    "turn.send.cleanup",
                    "A remote Pi turn became uncertain and its sandbox could not be destroyed.",
                    cleanupCause,
                  ),
                ),
                Effect.andThen(Effect.fail(cause)),
              ),
            ),
          );
        }),
      local.sendTurn(input),
    );

  const requireRepositoryBinding = Effect.fnUntraced(function* (
    threadId: ThreadId,
    operation: string,
  ) {
    const binding = remoteByThread.get(threadId) ?? (yield* loadPersistedRemote(threadId));
    if (!binding?.repositoryCheckout) {
      return yield* adapterError(
        operation,
        "The Pi session does not have a repository-bound sandbox.",
      );
    }
    return binding;
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
      Effect.gen(function* () {
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
      });

  const readPersistenceCandidate: NonNullable<PiAdapterShape["readPersistenceCandidate"]> =
    (threadId, lifecycleGeneration, selection) =>
      Effect.gen(function* () {
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
      });

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
  ) =>
    Effect.gen(function* () {
      const persistedBinding = yield* requireRepositoryBinding(threadId, "repository.reconcile");
      yield* provisioner.markOutboxPromoted(persistedBinding, persistedFiles);
      const binding = yield* requireIdleRepositoryBinding(threadId, "repository.reconcile");
      const previousCommit = binding.repositoryCheckout.commit;
      const reconciled = yield* provisioner.reconcileRepository(
        binding,
        commit,
        persistedFiles,
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
    });

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
    );

  const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const binding = remoteByThread.get(threadId) ?? (yield* loadPersistedRemote(threadId));
      if (!binding) return yield* local.stopSession(threadId);
      yield* requestUnknown(binding, "session.stop", { threadId }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(
            "Remote Pi session.stop response was lost; destroying the bound sandbox.",
            cause,
          ),
        ),
        Effect.catch(() => Effect.void),
      );
      yield* provisioner.stop(binding).pipe(
        Effect.mapError((cause) =>
          adapterError("session.stop", "Failed to destroy the remote Pi runtime.", cause),
        ),
      );
      remoteByThread.delete(threadId);
      revokeRemoteGatewayToken(threadId);
    });

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.all([
      local.listSessions(),
      Effect.forEach(Array.from(remoteByThread.values()), (binding) =>
        requestDecoded(binding, "session.list", {}, Schema.Array(ProviderSession)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("remote Pi session discovery unavailable", {
              sandboxId: binding.fence.sandboxId,
              detail: cause.detail,
            }).pipe(Effect.as([] as const)),
          ),
        ),
      ).pipe(Effect.map((groups) => groups.flat())),
    ]).pipe(Effect.map(([localSessions, remoteSessions]) => [...localSessions, ...remoteSessions]));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    route(
      threadId,
      (binding) => requestDecoded(binding, "session.has", { threadId }, Schema.Boolean),
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
    );

  const compactThread: NonNullable<PiAdapterShape["compactThread"]> = (threadId) =>
    route(
      threadId,
      (binding) =>
        requestUnknown(binding, "thread.compact", { threadId }).pipe(Effect.asVoid),
      local.compactThread
        ? local.compactThread(threadId)
        : Effect.fail(adapterError("thread.compact", "Local Pi compaction is unavailable.")),
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
          provisioner.stop(binding).pipe(
            Effect.tap(() => Effect.sync(() => remoteByThread.delete(threadId))),
            Effect.tap(() => Effect.sync(() => revokeRemoteGatewayToken(threadId))),
            Effect.mapError((cause) =>
              adapterError("runtime.stopAll", "Failed to destroy a remote Pi runtime.", cause),
            ),
          ),
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

  return {
    provider: "pi",
    capabilities: local.capabilities,
    managesStartSessionTimeout: (input) =>
      capacity !== undefined && input.repositoryBinding !== undefined,
    startSession,
    sendTurn,
    reconcileRepository,
    listPersistenceCandidates,
    readPersistenceCandidate,
    readOutboxCheckpoint,
    steerTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
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
      const remoteEvents = broker.streamEvents.pipe(
        Stream.tap((event) => {
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
          if (!binding) return Effect.void;
          return provisioner.checkpointOutbox(binding).pipe(
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.logWarning("provider Outbox terminal checkpoint deferred", {
                threadId: event.threadId,
                sandboxId: binding.workspace.runtimeId,
                cause,
              }),
            ),
          );
        }),
      );
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
