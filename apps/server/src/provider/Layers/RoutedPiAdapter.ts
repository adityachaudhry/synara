import { randomUUID } from "node:crypto";

import {
  EventId,
  ProviderSession,
  ProviderTurnStartResult,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type RuntimeStagePayload,
  type ProviderWorkerMethod,
} from "@synara/contracts";
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect";

import { ProviderWorkerProvisioner } from "../../providerWorker/Services/ProviderWorkerProvisioner";
import { ProviderWorkerBroker } from "../../providerWorker/Services/ProviderWorkerBroker";
import {
  decodeProviderWorkerRuntimeBinding,
  type ProviderWorkerRuntimeBinding,
} from "../../providerWorker/runtimeBinding";
import { ServerSettingsService } from "../../serverSettings";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter";

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

function adapterError(method: string, detail: string, cause?: unknown) {
  return new ProviderAdapterRequestError({
    provider: "pi",
    method,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

export const makeRoutedPiAdapter = Effect.gen(function* () {
  const local = yield* PiAdapter;
  const provisioner = yield* ProviderWorkerProvisioner;
  const broker = yield* ProviderWorkerBroker;
  const directory = yield* ProviderSessionDirectory;
  const settings = yield* ServerSettingsService;
  const remoteByThread = new Map<string, ProviderWorkerRuntimeBinding>();
  const runtimeStageQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
    PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  );

  const publishRuntimeStage = (input: {
    readonly threadId: ThreadId;
    readonly lifecycleGeneration: string;
    readonly payload: RuntimeStagePayload;
    readonly turnId?: TurnId;
  }) =>
    Queue.offer(runtimeStageQueue, {
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: "pi",
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
      lifecycleGeneration: input.lifecycleGeneration,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      type: "runtime.stage",
      payload: input.payload,
    } satisfies ProviderRuntimeEvent).pipe(Effect.asVoid);

  const withAdapterStage = <A, E, R>(input: {
    readonly threadId: ThreadId;
    readonly lifecycleGeneration: string;
    readonly stage: "session.start" | "turn.dispatch";
    readonly cold: boolean;
    readonly effect: Effect.Effect<A, E, R>;
    readonly turnId?: TurnId;
  }) =>
    Effect.suspend(() => {
      const startedAt = Date.now();
      const publish = (state: "started" | "completed" | "failed") =>
        publishRuntimeStage({
          threadId: input.threadId,
          lifecycleGeneration: input.lifecycleGeneration,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
          payload: {
            stage: input.stage,
            state,
            cold: input.cold,
            ...(state === "started"
              ? {}
              : { elapsedMs: Math.max(0, Date.now() - startedAt) }),
          },
        });
      return publish("started").pipe(
        Effect.andThen(input.effect),
        Effect.tap(() => publish("completed")),
        Effect.tapError(() => publish("failed")),
      );
    });

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

  const requestDecoded = <S extends Schema.Top>(
    binding: ProviderWorkerRuntimeBinding,
    method: ProviderWorkerMethod,
    params: unknown,
    schema: S,
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
    readonly operation?: "session.start" | "workspace.refresh";
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
          adapterError(
            input.operation ?? "session.start",
            "Failed to persist the remote Pi runtime binding.",
            cause,
          ),
        ),
      );

  const startSession: PiAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const target = (yield* settings.getSettings).providers.pi.executionTarget;
      const persisted = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      const persistedRemote = persistedDistributedBinding(persisted?.runtimePayload);
      const activeRemote = remoteByThread.get(input.threadId);

      if (target === "local") {
        if (input.repositoryBinding !== undefined) {
          return yield* adapterError(
            "session.start",
            "Gitea-bound projects require the Railway sandbox Pi execution target.",
          );
        }
        const remote = activeRemote ?? persistedRemote;
        if (remote) {
          yield* provisioner.stop(remote).pipe(
            Effect.mapError((cause) =>
              adapterError("session.start", "Failed to retire the previous remote Pi runtime.", cause),
            ),
          );
          remoteByThread.delete(input.threadId);
        }
        return yield* local.startSession(input);
      }

      const lifecycleGeneration = input.lifecycleGeneration ?? randomLifecycleGeneration();
      const previous = activeRemote ?? persistedRemote;
      const repositoryBinding =
        input.repositoryBinding ?? previous?.repositoryCheckout?.binding;
      const binding = previous
        ? yield* provisioner.restart(previous, {
            lifecycleGeneration,
            onStage: (payload) =>
              publishRuntimeStage({ threadId: input.threadId, lifecycleGeneration, payload }),
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            ...(repositoryBinding === undefined
              ? {}
              : { repositoryBinding }),
          })
        : yield* provisioner.start({
            lifecycleGeneration,
            onStage: (payload) =>
              publishRuntimeStage({ threadId: input.threadId, lifecycleGeneration, payload }),
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            ...(repositoryBinding === undefined
              ? {}
              : { repositoryBinding }),
          });
      const { repositoryBinding: _repositoryBinding, ...workerSessionInput } = input;
      const session = yield* withAdapterStage({
        threadId: input.threadId,
        lifecycleGeneration,
        stage: "session.start",
        cold: true,
        effect: requestDecoded(
          binding,
          "session.start",
          { ...workerSessionInput, cwd: binding.cwd, lifecycleGeneration },
          ProviderSession,
        ),
      }).pipe(Effect.onError(() => provisioner.stop(binding).pipe(Effect.catch(() => Effect.void))));
      yield* persistRemoteBinding({ threadId: input.threadId, lifecycleGeneration, binding }).pipe(
        Effect.onError(() => provisioner.stop(binding).pipe(Effect.catch(() => Effect.void))),
      );
      remoteByThread.set(input.threadId, binding);
      return session;
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
          const refreshed = yield* provisioner.refresh(binding, {
            onStage: (payload) =>
              publishRuntimeStage({
                threadId: input.threadId,
                lifecycleGeneration: binding.fence.lifecycleGeneration,
                payload,
              }),
          }).pipe(
            Effect.mapError((cause) =>
              adapterError(
                "workspace.refresh",
                "Failed to refresh the company workspace before the Pi turn.",
                cause,
              ),
            ),
          );
          remoteByThread.set(input.threadId, refreshed);
          const previousCheckout = binding.repositoryCheckout;
          const refreshedCheckout = refreshed.repositoryCheckout;
          const checkoutChanged =
            previousCheckout?.commit !== refreshedCheckout?.commit ||
            previousCheckout?.checkoutMode !== refreshedCheckout?.checkoutMode;
          if (checkoutChanged) {
            yield* persistRemoteBinding({
              threadId: input.threadId,
              lifecycleGeneration: refreshed.fence.lifecycleGeneration,
              binding: refreshed,
              operation: "workspace.refresh",
            });
          }
          return yield* withAdapterStage({
            threadId: input.threadId,
            lifecycleGeneration: refreshed.fence.lifecycleGeneration,
            stage: "turn.dispatch",
            cold: false,
            effect: requestDecoded(refreshed, "turn.send", input, ProviderTurnStartResult),
          });
        }),
      local.sendTurn(input),
    );

  const steerTurn: NonNullable<PiAdapterShape["steerTurn"]> = (input) =>
    route(
      input.threadId,
      (binding) => requestDecoded(binding, "turn.steer", input, ProviderTurnStartResult),
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
    });

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.all([
      local.listSessions(),
      Effect.forEach(Array.from(remoteByThread.values()), (binding) =>
        requestDecoded(binding, "session.list", {}, Schema.Array(ProviderSession)),
      ).pipe(
        Effect.map((groups) => groups.flat()),
        Effect.catch(() => Effect.succeed([])),
      ),
    ]).pipe(Effect.map(([localSessions, remoteSessions]) => [...localSessions, ...remoteSessions]));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    route(
      threadId,
      (binding) =>
        requestDecoded(binding, "session.has", { threadId }, Schema.Boolean).pipe(
          Effect.catch(() => Effect.succeed(false)),
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
    startSession,
    sendTurn,
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
    listModels: local.listModels!,
    listSkills: local.listSkills!,
    listCommands: local.listCommands!,
    getComposerCapabilities: local.getComposerCapabilities!,
    get streamEvents() {
      return Stream.merge(
        Stream.merge(local.streamEvents, broker.streamEvents),
        Stream.fromQueue(runtimeStageQueue),
      );
    },
  } satisfies PiAdapterShape;
});

function randomLifecycleGeneration(): string {
  return `remote-${Date.now().toString(36)}`;
}

export const RoutedPiAdapterLive = Layer.effect(PiAdapter, makeRoutedPiAdapter);
