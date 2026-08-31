import { randomUUID } from "node:crypto";

import { Effect, Exit, Layer } from "effect";

import {
  WorkspaceCreationIntentRepository,
  type WorkspaceCreationIntentRepositoryShape,
} from "../../persistence/Services/WorkspaceCreationIntents";
import {
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntimeRepositoryShape,
} from "../../persistence/Services/ProviderSessionRuntime";
import { decodeProviderWorkerRuntimeBinding } from "../../providerWorker/runtimeBinding";
import { WorkspaceRuntimeError } from "../Errors";
import { RailwaySandboxClient } from "../Services/RailwaySandboxClient";
import {
  WorkspaceRuntime,
  type WorkspaceRuntimeBinding,
  type WorkspaceRuntimeInventoryRecord,
  type WorkspaceRuntimeShape,
} from "../Services/WorkspaceRuntime";
import type { RailwaySandboxClientShape } from "../Services/RailwaySandboxClient";
import type { RailwaySandboxRuntimeConfig } from "../railwaySandboxConfig";
import {
  SandboxCapacity,
  reconcileSandboxCapacityInventory,
  type SandboxCapacityLease,
} from "../SandboxCapacity";

function runtimeStatus(
  status: "CREATING" | "DESTROYING" | "RUNNING" | "STOPPED" | "DESTROYED" | "FAILED",
): WorkspaceRuntimeBinding["status"] {
  switch (status) {
    case "CREATING":
      return "creating";
    case "RUNNING":
      return "running";
    case "DESTROYING":
      return "destroying";
    case "STOPPED":
      return "stopped";
    case "DESTROYED":
      return "destroyed";
    case "FAILED":
      return "failed";
  }
}

function toRuntimeError(operation: string, runtimeId?: string) {
  return (cause: unknown) =>
    new WorkspaceRuntimeError({
      operation,
      detail: `Railway workspace runtime ${operation} failed.`,
      ...(runtimeId === undefined ? {} : { runtimeId }),
      cause,
    });
}

function requireEnabled(
  config: RailwaySandboxRuntimeConfig,
  operation: string,
): Effect.Effect<Extract<RailwaySandboxRuntimeConfig, { readonly enabled: true }>, WorkspaceRuntimeError> {
  return config.enabled
    ? Effect.succeed(config)
    : Effect.fail(
        new WorkspaceRuntimeError({
          operation,
          detail: "Railway Sandbox runtime is not configured.",
        }),
      );
}

export interface WorkspaceRuntimeOptions {
  readonly createOperationId?: () => string;
  readonly reconcileIntervalMs?: number;
  readonly capacity?: SandboxCapacity;
}

const DEFAULT_RECONCILE_INTERVAL_MS = 10_000;
const MAX_RECONCILE_BACKOFF_MS = 5 * 60_000;

export function reconcileWorkspaceCreationIntents(input: {
  readonly client: RailwaySandboxClientShape;
  readonly intents: WorkspaceCreationIntentRepositoryShape;
  readonly ownedOperationIds: ReadonlySet<string>;
  readonly onIntentCleaned?: (operationId: string) => Effect.Effect<void>;
}) {
  return input.intents.list().pipe(
    Effect.flatMap(
      Effect.forEach((intent) => {
        if (input.ownedOperationIds.has(intent.operationId)) return Effect.void;
        return Effect.gen(function* () {
          const runtimeId =
            intent.runtimeId ??
            (yield* input.client.findByCreateOperationId(intent.operationId));
          if (runtimeId === null) return;
          if (intent.runtimeId === null) {
            yield* input.intents.bindRuntime({ operationId: intent.operationId, runtimeId });
          }
          yield* input.client
            .destroy(runtimeId)
            .pipe(Effect.catchTag("RailwaySandboxNotFoundError", () => Effect.void));
          yield* input.intents.remove(intent.operationId);
          yield* input.onIntentCleaned?.(intent.operationId) ?? Effect.void;
        });
      }),
    ),
    Effect.asVoid,
  );
}

export function reconcileSandboxCapacityAtStartup(input: {
  readonly client: RailwaySandboxClientShape;
  readonly intents: WorkspaceCreationIntentRepositoryShape;
  readonly runtimes: ProviderSessionRuntimeRepositoryShape;
  readonly capacity: SandboxCapacity;
}) {
  return Effect.gen(function* () {
    const [inventory, pendingCreationIntents, persistedRuntimes] = yield* Effect.all([
      input.client.list,
      input.intents.list(),
      input.runtimes.list(),
    ]);
    const resolvedIntents = yield* Effect.forEach(pendingCreationIntents, (intent) =>
      intent.runtimeId !== null
        ? Effect.succeed(intent)
        : input.client.findByCreateOperationId(intent.operationId).pipe(
            Effect.map((runtimeId) => ({ ...intent, runtimeId })),
          ),
    );
    const liveBindings: Array<{
      capacityKey: string;
      threadId: string;
      lifecycleGeneration: string;
      runtimeId: string;
    }> = [];
    for (const runtime of persistedRuntimes) {
      if (runtime.status !== "starting" && runtime.status !== "running") continue;
      const payload =
        runtime.runtimePayload !== null &&
        typeof runtime.runtimePayload === "object" &&
        !Array.isArray(runtime.runtimePayload)
          ? (runtime.runtimePayload as Record<string, unknown>)
          : {};
      const binding = decodeProviderWorkerRuntimeBinding(payload.distributedPiRuntime);
      if (!binding) continue;
      const expectedCapacityKey = `${runtime.threadId}:${runtime.lifecycleGeneration}`;
      const capacityKey = binding.workspace.capacityKey;
      if (
        capacityKey !== expectedCapacityKey ||
        binding.workspace.lifecycleGeneration !== runtime.lifecycleGeneration ||
        binding.fence.lifecycleGeneration !== runtime.lifecycleGeneration ||
        (binding.threadId !== undefined && binding.threadId !== runtime.threadId)
      ) {
        return yield* new WorkspaceRuntimeError({
          operation: "capacity.reconcile",
          detail: `Persisted Railway capacity key for thread '${runtime.threadId}' does not match lifecycle generation '${runtime.lifecycleGeneration}'.`,
          runtimeId: binding.workspace.runtimeId,
        });
      }
      liveBindings.push({
        capacityKey,
        threadId: runtime.threadId,
        lifecycleGeneration: runtime.lifecycleGeneration,
        runtimeId: binding.workspace.runtimeId,
      });
    }
    const report = reconcileSandboxCapacityInventory({
      inventoryRuntimeIds: inventory.map((record) => record.id),
      liveBindings,
      pendingCreationIntents: resolvedIntents,
    });
    input.capacity.reconcile(report.reservations);
    return report;
  });
}

export function makeWorkspaceRuntimeLive(
  config: RailwaySandboxRuntimeConfig,
  options: WorkspaceRuntimeOptions = {},
) {
  return Layer.effect(
    WorkspaceRuntime,
    Effect.gen(function* () {
      const client = yield* RailwaySandboxClient;
      const intents = yield* WorkspaceCreationIntentRepository;
      const runtimes = options.capacity?.snapshot().reconciled === false
        ? yield* ProviderSessionRuntimeRepository
        : undefined;
      const ownedOperationIds = new Set<string>();
      const capacityLeaseByOperationId = new Map<string, SandboxCapacityLease>();
      const reconcileIntervalMs =
        options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;

      const reconcileLoop = (delayMs: number): Effect.Effect<void> =>
        reconcileWorkspaceCreationIntents({
          client,
          intents,
          ownedOperationIds,
          ...(options.capacity === undefined
            ? {}
            : {
                onIntentCleaned: (operationId: string) =>
                  Effect.sync(() => {
                    const lease = capacityLeaseByOperationId.get(operationId);
                    if (lease) {
                      lease.release();
                      capacityLeaseByOperationId.delete(operationId);
                    } else {
                      options.capacity!.release(`create-intent:${operationId}`);
                    }
                  }),
              }),
        }).pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              Effect.logWarning("workspace creation intent reconciliation failed", {
                cause: String(cause),
              }).pipe(
                Effect.andThen(Effect.sleep(delayMs)),
                Effect.andThen(
                  reconcileLoop(Math.min(delayMs * 2, MAX_RECONCILE_BACKOFF_MS)),
                ),
              ),
            onSuccess: () =>
              Effect.sleep(reconcileIntervalMs).pipe(
                Effect.andThen(reconcileLoop(reconcileIntervalMs)),
              ),
          }),
        );

      const reconcileCapacityLoop = (delayMs: number): Effect.Effect<void> =>
        runtimes === undefined || options.capacity === undefined
          ? Effect.void
          : reconcileSandboxCapacityAtStartup({
              client,
              intents,
              runtimes,
              capacity: options.capacity,
            }).pipe(
              Effect.tap((report) =>
                report.orphanRuntimeIds.length === 0
                  ? Effect.void
                  : Effect.logWarning("unowned Railway sandbox inventory detected", {
                      runtimeIds: report.orphanRuntimeIds,
                    }),
              ),
              Effect.matchEffect({
                onFailure: (cause) =>
                  Effect.logWarning("sandbox capacity reconciliation failed", {
                    cause: String(cause),
                  }).pipe(
                    Effect.andThen(Effect.sleep(delayMs)),
                    Effect.andThen(
                      reconcileCapacityLoop(Math.min(delayMs * 2, MAX_RECONCILE_BACKOFF_MS)),
                    ),
                  ),
                onSuccess: () => Effect.void,
              }),
            );

      yield* Effect.forkScoped(
        runtimes === undefined
          ? Effect.sleep(reconcileIntervalMs).pipe(
              Effect.andThen(reconcileLoop(reconcileIntervalMs)),
            )
          : reconcileCapacityLoop(reconcileIntervalMs).pipe(
              Effect.andThen(reconcileLoop(reconcileIntervalMs)),
            ),
      );

      const removeIntent = (operationId: string) =>
        intents.remove(operationId).pipe(
          Effect.mapError(toRuntimeError("creation-intent.remove")),
          Effect.tap(() => Effect.sync(() => ownedOperationIds.delete(operationId))),
        );

      const releaseCapacity = (input: {
        readonly operationId?: string;
        readonly capacityKey?: string;
      }) =>
        Effect.sync(() => {
          const lease =
            input.operationId === undefined
              ? undefined
              : capacityLeaseByOperationId.get(input.operationId);
          lease?.release();
          if (input.operationId !== undefined) {
            capacityLeaseByOperationId.delete(input.operationId);
          }
          if (!lease && input.capacityKey !== undefined) {
            options.capacity?.release(input.capacityKey);
          }
        });

      const destroyCreated = (runtimeId: string, operationId: string) =>
        client.destroy(runtimeId).pipe(
          Effect.catchTag("RailwaySandboxNotFoundError", () => Effect.void),
          Effect.mapError(toRuntimeError("cleanup", runtimeId)),
          Effect.andThen(removeIntent(operationId)),
        );

      const create: WorkspaceRuntimeShape["create"] = (input) => {
        const capacityKey = `${input.threadId ?? input.lifecycleGeneration}:${input.lifecycleGeneration}`;
        const acquire =
          options.capacity === undefined
            ? Effect.succeed(undefined)
            : Effect.tryPromise({
                try: (signal) =>
                  options.capacity!.acquire({
                    key: capacityKey,
                    threadId: input.threadId ?? input.lifecycleGeneration,
                    lifecycleGeneration: input.lifecycleGeneration,
                    signal,
                  }),
                catch: (cause) =>
                  new WorkspaceRuntimeError({
                    operation: "capacity.acquire",
                    detail: "Railway workspace capacity acquisition failed.",
                    cause,
                  }),
              });
        return acquire.pipe(
          Effect.flatMap((capacityLease) =>
            Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            input.onCapacityAdmitted?.();
            const enabled = yield* requireEnabled(config, "create");
            const operationId = (options.createOperationId ?? randomUUID)();
            if (ownedOperationIds.has(operationId)) {
              capacityLease?.release();
              return yield* new WorkspaceRuntimeError({
                operation: "create.reserve",
                detail: `Workspace create operation '${operationId}' is already active.`,
              });
            }
            ownedOperationIds.add(operationId);
            if (capacityLease !== undefined) {
              capacityLeaseByOperationId.set(operationId, capacityLease);
            }
            const putExit = yield* Effect.exit(
              intents
                .put({ operationId, createdAt: new Date().toISOString() })
                .pipe(Effect.mapError(toRuntimeError("creation-intent.put"))),
            );
            if (Exit.isFailure(putExit)) {
              const cleanupExit = yield* Effect.exit(removeIntent(operationId));
              if (Exit.isFailure(cleanupExit)) {
                ownedOperationIds.delete(operationId);
                return yield* Effect.failCause(cleanupExit.cause);
              }
              yield* releaseCapacity({ operationId, capacityKey });
              return yield* Effect.failCause(putExit.cause);
            }

            let createStarted = false;
            const createExit = yield* Effect.exit(
              restore(
                Effect.sync(() => {
                  createStarted = true;
                }).pipe(
                  Effect.andThen(
                    client
                      .create({
                        operationId,
                        networkIsolation: input.networkIsolation ?? "ISOLATED",
                        idleTimeoutMinutes: enabled.idleTimeoutMinutes,
                        ...(enabled.region === undefined ? {} : { region: enabled.region }),
                        environment: input.environment,
                      })
                      .pipe(Effect.mapError(toRuntimeError("create"))),
                  ),
                ),
              ),
            );
            if (Exit.isFailure(createExit)) {
              ownedOperationIds.delete(operationId);
              if (!createStarted) {
                const cleanupExit = yield* Effect.exit(removeIntent(operationId));
                if (Exit.isFailure(cleanupExit)) {
                  return yield* Effect.failCause(cleanupExit.cause);
                }
                yield* releaseCapacity({ operationId, capacityKey });
              }
              return yield* Effect.failCause(createExit.cause);
            }
            const record = createExit.value;
            const bindExit = yield* Effect.exit(
              restore(
                intents
                  .bindRuntime({ operationId, runtimeId: record.id })
                  .pipe(Effect.mapError(toRuntimeError("creation-intent.bind", record.id))),
              ),
            );
            if (Exit.isFailure(bindExit)) {
              ownedOperationIds.delete(operationId);
              const cleanupExit = yield* Effect.exit(
                client.destroy(record.id).pipe(
                  Effect.catchTag("RailwaySandboxNotFoundError", () => Effect.void),
                  Effect.mapError(toRuntimeError("cleanup", record.id)),
                  Effect.andThen(removeIntent(operationId)),
                ),
              );
              if (Exit.isSuccess(cleanupExit)) {
                yield* releaseCapacity({ operationId, capacityKey });
              }
              return yield* Effect.failCause(
                Exit.isFailure(cleanupExit) ? cleanupExit.cause : bindExit.cause,
              );
            }

            if (record.status !== "RUNNING") {
              const cleanupExit = yield* Effect.exit(destroyCreated(record.id, operationId));
              ownedOperationIds.delete(operationId);
              if (Exit.isFailure(cleanupExit)) return yield* Effect.failCause(cleanupExit.cause);
              yield* releaseCapacity({ operationId, capacityKey });
              return yield* new WorkspaceRuntimeError({
                operation: "create",
                detail: `Created Railway Sandbox entered unexpected status ${record.status}.`,
                runtimeId: record.id,
              });
            }

            return {
              runtimeKind: "railway-sandbox",
              runtimeId: record.id,
              creationOperationId: operationId,
              ...(capacityLease === undefined ? {} : { capacityKey }),
              lifecycleGeneration: input.lifecycleGeneration,
              status: "running",
              region: record.region,
            } satisfies WorkspaceRuntimeBinding;
          }),
            ),
          ),
        );
      };

      const connect: WorkspaceRuntimeShape["connect"] = (binding) =>
        Effect.gen(function* () {
          yield* requireEnabled(config, "connect");
          const record = yield* client
            .connect(binding.runtimeId)
            .pipe(Effect.mapError(toRuntimeError("connect", binding.runtimeId)));
          if (record.status !== "RUNNING") {
            return yield* new WorkspaceRuntimeError({
              operation: "connect",
              detail: `Railway Sandbox is ${record.status}, not RUNNING.`,
              runtimeId: binding.runtimeId,
            });
          }
          return {
            ...binding,
            status: "running",
            region: record.region,
          };
        });

      const adopt: WorkspaceRuntimeShape["adopt"] = (binding) =>
        binding.creationOperationId === undefined
          ? Effect.void
          : removeIntent(binding.creationOperationId).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  capacityLeaseByOperationId.delete(binding.creationOperationId!);
                }),
              ),
            );

      const exec: WorkspaceRuntimeShape["exec"] = (binding, input) =>
        requireEnabled(config, "exec").pipe(
          Effect.flatMap(() => client.exec(binding.runtimeId, input)),
          Effect.mapError(toRuntimeError("exec", binding.runtimeId)),
        );

      const keepAlive: WorkspaceRuntimeShape["keepAlive"] = (binding) =>
        exec(binding, { command: "true", timeoutSeconds: 10 }).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(
                  new WorkspaceRuntimeError({
                    operation: "keepAlive",
                    detail: `Railway Sandbox keepalive exited with ${String(result.exitCode)}.`,
                    runtimeId: binding.runtimeId,
                  }),
                ),
          ),
        );

      const writeFile: WorkspaceRuntimeShape["writeFile"] = (binding, input) =>
        requireEnabled(config, "writeFile").pipe(
          Effect.flatMap(() => client.writeFile(binding.runtimeId, input)),
          Effect.mapError(toRuntimeError("writeFile", binding.runtimeId)),
        );

      const readFile: NonNullable<WorkspaceRuntimeShape["readFile"]> = (binding, path) =>
        requireEnabled(config, "readFile").pipe(
          Effect.flatMap(() => {
            if (!client.readFile) {
              return Effect.fail(
                new WorkspaceRuntimeError({
                  operation: "readFile",
                  detail: "Railway file reads are unavailable.",
                  runtimeId: binding.runtimeId,
                }),
              );
            }
            return client
              .readFile(binding.runtimeId, path)
              .pipe(Effect.mapError(toRuntimeError("readFile", binding.runtimeId)));
          }),
        );

      const listFiles: NonNullable<WorkspaceRuntimeShape["listFiles"]> = (binding, path) =>
        requireEnabled(config, "listFiles").pipe(
          Effect.flatMap(() => {
            if (!client.listFiles) {
              return Effect.fail(
                new WorkspaceRuntimeError({
                  operation: "listFiles",
                  detail: "Railway directory listing is unavailable.",
                  runtimeId: binding.runtimeId,
                }),
              );
            }
            return client
              .listFiles(binding.runtimeId, path)
              .pipe(Effect.mapError(toRuntimeError("listFiles", binding.runtimeId)));
          }),
        );

      const statFile: NonNullable<WorkspaceRuntimeShape["statFile"]> = (binding, path) =>
        requireEnabled(config, "statFile").pipe(
          Effect.flatMap(() => {
            if (!client.statFile) {
              return Effect.fail(
                new WorkspaceRuntimeError({
                  operation: "statFile",
                  detail: "Railway file stat is unavailable.",
                  runtimeId: binding.runtimeId,
                }),
              );
            }
            return client
              .statFile(binding.runtimeId, path)
              .pipe(Effect.mapError(toRuntimeError("statFile", binding.runtimeId)));
          }),
        );

      const startDurableProcess: WorkspaceRuntimeShape["startDurableProcess"] = (
        binding,
        input,
      ) =>
        requireEnabled(config, "startDurableProcess").pipe(
          Effect.flatMap(() => client.startDurableProcess(binding.runtimeId, input)),
          Effect.mapError(toRuntimeError("startDurableProcess", binding.runtimeId)),
        );

      const stopDurableProcess: WorkspaceRuntimeShape["stopDurableProcess"] = (
        binding,
        sessionName,
      ) =>
        requireEnabled(config, "stopDurableProcess").pipe(
          Effect.flatMap(() => client.stopDurableProcess(binding.runtimeId, sessionName)),
          Effect.mapError(toRuntimeError("stopDurableProcess", binding.runtimeId)),
        );

      const destroy: WorkspaceRuntimeShape["destroy"] = (binding) =>
        Effect.uninterruptible(
          requireEnabled(config, "destroy").pipe(
            Effect.flatMap(() => client.destroy(binding.runtimeId)),
            Effect.catchTag("RailwaySandboxNotFoundError", () => Effect.void),
            Effect.mapError(toRuntimeError("destroy", binding.runtimeId)),
            Effect.andThen(
              binding.creationOperationId === undefined
                ? Effect.void
                : removeIntent(binding.creationOperationId),
            ),
            Effect.andThen(
              releaseCapacity({
                ...(binding.creationOperationId === undefined
                  ? {}
                  : { operationId: binding.creationOperationId }),
                ...(binding.capacityKey === undefined ? {} : { capacityKey: binding.capacityKey }),
              }),
            ),
            Effect.onError(() =>
              Effect.sync(() => {
                if (binding.creationOperationId !== undefined) {
                  ownedOperationIds.delete(binding.creationOperationId);
                }
              }),
            ),
          ),
        );

      const list: WorkspaceRuntimeShape["list"] = requireEnabled(config, "list").pipe(
        Effect.flatMap(() => client.list),
        Effect.map((records) =>
          records.map(
            (record): WorkspaceRuntimeInventoryRecord => ({
              runtimeKind: "railway-sandbox",
              runtimeId: record.id,
              status: runtimeStatus(record.status),
              region: record.region,
            }),
          ),
        ),
        Effect.mapError(toRuntimeError("list")),
      );

      return {
        create,
        connect,
        adopt,
        exec,
        writeFile,
        readFile,
        listFiles,
        statFile,
        startDurableProcess,
        stopDurableProcess,
        keepAlive,
        destroy,
        list,
      } satisfies WorkspaceRuntimeShape;
    }),
  );
}
