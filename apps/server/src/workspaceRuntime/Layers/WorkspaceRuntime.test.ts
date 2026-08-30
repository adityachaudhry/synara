import { Deferred, Effect, Fiber, Layer } from "effect";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import {
  RailwaySandboxClientError,
  RailwaySandboxNotFoundError,
  WorkspaceRuntimeError,
} from "../Errors";
import {
  RailwaySandboxClient,
  type RailwaySandboxClientShape,
  type RailwaySandboxRecord,
} from "../Services/RailwaySandboxClient";
import { WorkspaceRuntime } from "../Services/WorkspaceRuntime";
import {
  WorkspaceCreationIntentRepository,
  type WorkspaceCreationIntent,
  type WorkspaceCreationIntentRepositoryShape,
} from "../../persistence/Services/WorkspaceCreationIntents";
import {
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntimeRepositoryShape,
} from "../../persistence/Services/ProviderSessionRuntime";
import {
  makeWorkspaceRuntimeLive,
  reconcileWorkspaceCreationIntents,
} from "./WorkspaceRuntime";
import { SandboxCapacity } from "../SandboxCapacity";

function makeFakeRailwayClient(options?: { readonly createdStatus?: RailwaySandboxRecord["status"] }) {
  const sandboxes = new Map<string, RailwaySandboxRecord>();
  let creates = 0;
  const writes: unknown[] = [];
  const durableProcesses: unknown[] = [];
  const createInputs: unknown[] = [];

  const client: RailwaySandboxClientShape = {
    create: (input) =>
      Effect.gen(function* () {
        createInputs.push(input);
        if (
          (input.networkIsolation !== "ISOLATED" && input.networkIsolation !== "PRIVATE") ||
          input.idleTimeoutMinutes !== 30 ||
          input.region !== "us-east4-eqdc4a"
        ) {
          return yield* new RailwaySandboxClientError({
            operation: "create",
            detail: "unexpected create policy",
          });
        }
        creates += 1;
        const record: RailwaySandboxRecord = {
          id: `sandbox-${creates}`,
          status: options?.createdStatus ?? "RUNNING",
          region: input.region,
        };
        sandboxes.set(record.id, record);
        return record;
      }),
    connect: (runtimeId) => {
      const record = sandboxes.get(runtimeId);
      return record
        ? Effect.succeed(record)
        : Effect.fail(
            new RailwaySandboxNotFoundError({ operation: "connect", runtimeId }),
          );
    },
    exec: (runtimeId, input) => {
      if (!sandboxes.has(runtimeId)) {
        return Effect.fail(
          new RailwaySandboxNotFoundError({ operation: "exec", runtimeId }),
        );
      }
      return Effect.succeed({
        exitCode: input.command === "true" ? 0 : 2,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
      });
    },
    writeFile: (runtimeId, input) =>
      Effect.sync(() => {
        writes.push({ runtimeId, input });
      }),
    startDurableProcess: (runtimeId, input) =>
      Effect.sync(() => {
        durableProcesses.push({ operation: "start", runtimeId, input });
        return { sessionName: "worker-session-1", supervision: "durable" };
      }),
    stopDurableProcess: (runtimeId, sessionName) =>
      Effect.sync(() => {
        durableProcesses.push({ operation: "stop", runtimeId, sessionName });
      }),
    destroy: (runtimeId) => {
      if (!sandboxes.delete(runtimeId)) {
        return Effect.fail(
          new RailwaySandboxNotFoundError({ operation: "destroy", runtimeId }),
        );
      }
      return Effect.void;
    },
    findByCreateOperationId: () => Effect.succeed(null),
    list: Effect.sync(() => Array.from(sandboxes.values())),
  };

  return { client, sandboxes, writes, durableProcesses, createInputs, get creates() { return creates; } };
}

const enabledConfig = {
  enabled: true as const,
  token: "not-observable-by-runtime",
  authType: "bearer" as const,
  environmentId: "environment-1",
  region: "us-east4-eqdc4a",
  idleTimeoutMinutes: 30,
};

function runWorkspace<A>(
  client: RailwaySandboxClientShape,
  effect: Effect.Effect<A, WorkspaceRuntimeError, WorkspaceRuntime>,
  config = enabledConfig,
  intents = makeIntentRepository(),
) {
  const layer = makeWorkspaceRuntimeLive(config, {
    createOperationId: () => "11111111-1111-4111-8111-111111111111",
    reconcileIntervalMs: 60_000,
  }).pipe(
    Layer.provide(Layer.succeed(RailwaySandboxClient, client)),
    Layer.provide(Layer.succeed(WorkspaceCreationIntentRepository, intents.repository)),
  );
  return Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
}

function makeIntentRepository(initial: ReadonlyArray<WorkspaceCreationIntent> = []) {
  const records = new Map(initial.map((intent) => [intent.operationId, intent]));
  const calls: string[] = [];
  const repository: WorkspaceCreationIntentRepositoryShape = {
    put: (input) =>
      Effect.sync(() => {
        calls.push(`put:${input.operationId}`);
        if (!records.has(input.operationId)) records.set(input.operationId, { ...input, runtimeId: null });
      }),
    bindRuntime: (input) =>
      Effect.sync(() => {
        calls.push(`bind:${input.runtimeId}`);
        const current = records.get(input.operationId);
        if (current) records.set(input.operationId, { ...current, runtimeId: input.runtimeId });
      }),
    remove: (operationId) =>
      Effect.sync(() => {
        calls.push(`remove:${operationId}`);
        records.delete(operationId);
      }),
    list: () => Effect.sync(() => Array.from(records.values())),
  };
  return { repository, records, calls };
}

describe("WorkspaceRuntime", () => {
  effectIt.effect("signals admission before Railway create and retains uncertain create ownership", () =>
    Effect.gen(function* () {
      const capacity = new SandboxCapacity(1);
      const occupied = yield* Effect.promise(() =>
        capacity.acquire({
          key: "occupied:generation",
          threadId: "occupied",
          lifecycleGeneration: "generation",
        }),
      );
      const createStarted = yield* Deferred.make<void>();
      let admitted = false;
      const fake = makeFakeRailwayClient();
      const client = {
        ...fake.client,
        create: () => Deferred.succeed(createStarted, undefined).pipe(Effect.andThen(Effect.never)),
      } as RailwaySandboxClientShape;
      const intents = makeIntentRepository();
      const layer = makeWorkspaceRuntimeLive(enabledConfig, {
        createOperationId: () => "operation-timeout",
        reconcileIntervalMs: 60_000,
        capacity,
      }).pipe(
        Layer.provide(Layer.succeed(RailwaySandboxClient, client)),
        Layer.provide(
          Layer.succeed(WorkspaceCreationIntentRepository, intents.repository),
        ),
      );

      yield* Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        const createFiber = yield* runtime
          .create({
            threadId: "thread-timeout",
            lifecycleGeneration: "generation-timeout",
            environment: {},
            onCapacityAdmitted: () => {
              admitted = true;
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("61 seconds");
        expect(createFiber.pollUnsafe()).toBeUndefined();
        expect(admitted).toBe(false);

        occupied.release();
        yield* Deferred.await(createStarted);
        expect(admitted).toBe(true);
        yield* Fiber.interrupt(createFiber);
        expect(capacity.snapshot().activeKeys).toEqual([
          "thread-timeout:generation-timeout",
        ]);
        expect(intents.records.has("operation-timeout")).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it("installs recovered intent capacity before cleanup can release it", async () => {
    const capacity = new SandboxCapacity(1, { reconcileBeforeAdmission: true });
    const inventoryStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseInventory = await Effect.runPromise(Deferred.make<void>());
    const intents = makeIntentRepository([
      {
        operationId: "operation-pending",
        runtimeId: "runtime-pending",
        createdAt: "2026-08-29T00:00:00.000Z",
      },
    ]);
    const fake = makeFakeRailwayClient();
    const client = {
      ...fake.client,
      list: Deferred.succeed(inventoryStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseInventory)),
        Effect.as([{ id: "runtime-pending", status: "RUNNING", region: "us-west2" }] as const),
      ),
      destroy: () => Effect.void,
    } as RailwaySandboxClientShape;
    const runtimes = {
      list: () => Effect.succeed([]),
    } as ProviderSessionRuntimeRepositoryShape;
    const layer = makeWorkspaceRuntimeLive(enabledConfig, {
      reconcileIntervalMs: 1,
      capacity,
    }).pipe(
      Layer.provide(Layer.succeed(RailwaySandboxClient, client)),
      Layer.provide(Layer.succeed(WorkspaceCreationIntentRepository, intents.repository)),
      Layer.provide(Layer.succeed(ProviderSessionRuntimeRepository, runtimes)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* WorkspaceRuntime;
        yield* Deferred.await(inventoryStarted);
        const waiting = capacity.acquire({
          key: "thread-new:generation-new",
          threadId: "thread-new",
          lifecycleGeneration: "generation-new",
        });
        yield* Effect.sleep("20 millis");
        expect(intents.records.has("operation-pending")).toBe(true);

        yield* Deferred.succeed(releaseInventory, undefined);
        const lease = yield* Effect.promise(() => waiting).pipe(Effect.timeout("1 second"));
        expect(capacity.snapshot().activeKeys).toEqual(["thread-new:generation-new"]);
        expect(intents.records.has("operation-pending")).toBe(false);
        lease.release();
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
  });

  it("bounds workspace creation until an authoritative destroy releases capacity", async () => {
    const fake = makeFakeRailwayClient();
    const capacity = new SandboxCapacity(1);
    let operation = 0;
    const layer = makeWorkspaceRuntimeLive(enabledConfig, {
      createOperationId: () => `operation-${++operation}`,
      reconcileIntervalMs: 60_000,
      capacity,
    }).pipe(
      Layer.provide(Layer.succeed(RailwaySandboxClient, fake.client)),
      Layer.provide(
        Layer.succeed(WorkspaceCreationIntentRepository, makeIntentRepository().repository),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        const first = yield* runtime.create({
          threadId: "thread-first",
          lifecycleGeneration: "generation-first",
          environment: {},
        });
        const secondFiber = yield* runtime
          .create({
            threadId: "thread-second",
            lifecycleGeneration: "generation-second",
            environment: {},
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(fake.creates).toBe(1);

        yield* runtime.destroy(first);
        const second = yield* Fiber.join(secondFiber);
        expect(fake.creates).toBe(2);
        yield* runtime.destroy(second);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
  });

  it("releases capacity after terminal create cleanup", async () => {
    const fake = makeFakeRailwayClient({ createdStatus: "FAILED" });
    const capacity = new SandboxCapacity(1);
    let operation = 0;
    const layer = makeWorkspaceRuntimeLive(enabledConfig, {
      createOperationId: () => `operation-${++operation}`,
      reconcileIntervalMs: 60_000,
      capacity,
    }).pipe(
      Layer.provide(Layer.succeed(RailwaySandboxClient, fake.client)),
      Layer.provide(
        Layer.succeed(WorkspaceCreationIntentRepository, makeIntentRepository().repository),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        const failed = yield* runtime
          .create({
            threadId: "thread-failed",
            lifecycleGeneration: "generation-failed",
            environment: {},
          })
          .pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        expect(capacity.snapshot().activeKeys).toEqual([]);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
  });

  effectIt.effect("destroys and releases when durable runtime binding is interrupted", () =>
    Effect.gen(function* () {
      const fake = makeFakeRailwayClient();
      const capacity = new SandboxCapacity(1);
      const bindStarted = yield* Deferred.make<void>();
      const intents = makeIntentRepository();
      intents.repository.bindRuntime = () =>
        Deferred.succeed(bindStarted, undefined).pipe(Effect.andThen(Effect.never));
      const layer = makeWorkspaceRuntimeLive(enabledConfig, {
        createOperationId: () => "operation-bind-timeout",
        reconcileIntervalMs: 60_000,
        capacity,
      }).pipe(
        Layer.provide(Layer.succeed(RailwaySandboxClient, fake.client)),
        Layer.provide(Layer.succeed(WorkspaceCreationIntentRepository, intents.repository)),
      );

      yield* Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        const createFiber = yield* runtime
          .create({
            threadId: "thread-bind-timeout",
            lifecycleGeneration: "generation-bind-timeout",
            environment: {},
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(bindStarted);
        yield* Fiber.interrupt(createFiber);
        expect(fake.sandboxes.size).toBe(0);
        expect(intents.records.has("operation-bind-timeout")).toBe(false);
        expect(capacity.snapshot().activeKeys).toEqual([]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  effectIt.effect("lets timeout cleanup retry an interrupted intent adoption", () =>
    Effect.gen(function* () {
      const fake = makeFakeRailwayClient();
      const capacity = new SandboxCapacity(1);
      const adoptStarted = yield* Deferred.make<void>();
      const intents = makeIntentRepository();
      const remove = intents.repository.remove;
      let removeCalls = 0;
      intents.repository.remove = (operationId) => {
        removeCalls += 1;
        return removeCalls === 1
          ? Deferred.succeed(adoptStarted, undefined).pipe(Effect.andThen(Effect.never))
          : remove(operationId);
      };
      const layer = makeWorkspaceRuntimeLive(enabledConfig, {
        createOperationId: () => "operation-adopt-timeout",
        reconcileIntervalMs: 60_000,
        capacity,
      }).pipe(
        Layer.provide(Layer.succeed(RailwaySandboxClient, fake.client)),
        Layer.provide(Layer.succeed(WorkspaceCreationIntentRepository, intents.repository)),
      );

      yield* Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        const binding = yield* runtime.create({
          threadId: "thread-adopt-timeout",
          lifecycleGeneration: "generation-adopt-timeout",
          environment: {},
        });
        const adoptFiber = yield* runtime
          .adopt(binding)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(adoptStarted);
        yield* Fiber.interrupt(adoptFiber);
        expect(capacity.snapshot().activeKeys).toEqual([
          "thread-adopt-timeout:generation-adopt-timeout",
        ]);
        expect(intents.records.has("operation-adopt-timeout")).toBe(true);

        yield* runtime.destroy(binding);
        expect(removeCalls).toBe(2);
        expect(intents.records.has("operation-adopt-timeout")).toBe(false);
        expect(capacity.snapshot().activeKeys).toEqual([]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it("creates an isolated sandbox by default", async () => {
    const fake = makeFakeRailwayClient();

    const binding = await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        return yield* runtime.create({
          lifecycleGeneration: "generation-1",
          environment: { WORKER_TOKEN: "scoped" },
        });
      }),
    );

    expect(binding).toEqual({
      runtimeKind: "railway-sandbox",
      runtimeId: "sandbox-1",
      lifecycleGeneration: "generation-1",
      status: "running",
      region: "us-east4-eqdc4a",
      creationOperationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(fake.createInputs[0]).toMatchObject({ networkIsolation: "ISOLATED" });
  });

  it("uses private networking only when the caller explicitly requests it", async () => {
    const fake = makeFakeRailwayClient();

    await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        yield* runtime.create({
          lifecycleGeneration: "generation-private",
          environment: {},
          networkIsolation: "PRIVATE",
        });
      }),
    );

    expect(fake.createInputs[0]).toMatchObject({ networkIsolation: "PRIVATE" });
  });

  it("persists create ownership before SDK create and clears it only after adoption", async () => {
    const order: string[] = [];
    const fake = makeFakeRailwayClient();
    const originalCreate = fake.client.create;
    fake.client.create = (input) =>
      Effect.sync(() => order.push("create")).pipe(Effect.andThen(originalCreate(input)));
    const intents = makeIntentRepository();
    const originalPut = intents.repository.put;
    intents.repository.put = (input) =>
      Effect.sync(() => order.push("intent")).pipe(Effect.andThen(originalPut(input)));

    await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        const binding = yield* runtime.create({
          lifecycleGeneration: "generation-1",
          environment: {},
        });
        expect(intents.records.has(binding.creationOperationId)).toBe(true);
        yield* runtime.adopt(binding);
        expect(intents.records.has(binding.creationOperationId)).toBe(false);
      }),
      enabledConfig,
      intents,
    );

    expect(order).toEqual(["intent", "create"]);
  });

  it("a duplicate create cannot release the first active create's reservation", async () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    const insertStarted = await Effect.runPromise(Deferred.make<void>());
    const releasePublish = await Effect.runPromise(Deferred.make<void>());
    const secondPreInsertList = await Effect.runPromise(Deferred.make<void>());
    const intentPublished = await Effect.runPromise(Deferred.make<void>());
    const releaseInsert = await Effect.runPromise(Deferred.make<void>());
    const secondPublishedList = await Effect.runPromise(Deferred.make<void>());
    const discoveryStarted = await Effect.runPromise(Deferred.make<void>());
    const intents = makeIntentRepository();
    let putCalls = 0;
    intents.repository.put = (input) =>
      Effect.gen(function* () {
        putCalls += 1;
        if (putCalls > 1) return yield* Effect.fail(new Error("duplicate insert") as never);
        yield* Deferred.succeed(insertStarted, undefined);
        yield* Deferred.await(releasePublish);
        intents.records.set(input.operationId, { ...input, runtimeId: null });
        yield* Deferred.succeed(intentPublished, undefined);
        yield* Deferred.await(releaseInsert);
      });
    let preInsertLists = 0;
    let publishedLists = 0;
    let observeAfterDuplicate = false;
    intents.repository.list = () =>
      Effect.gen(function* () {
        if (intents.records.has(operationId) && observeAfterDuplicate) {
          publishedLists += 1;
          if (publishedLists === 2) yield* Deferred.succeed(secondPublishedList, undefined);
        } else {
          preInsertLists += 1;
          if (preInsertLists === 2) yield* Deferred.succeed(secondPreInsertList, undefined);
        }
        return Array.from(intents.records.values());
      });
    const client = {
      ...makeFakeRailwayClient().client,
      findByCreateOperationId: () =>
        Deferred.succeed(discoveryStarted, undefined).pipe(Effect.as("sandbox-active")),
      destroy: () => Effect.void,
    } satisfies RailwaySandboxClientShape;
    const layer = makeWorkspaceRuntimeLive(enabledConfig, {
      createOperationId: () => operationId,
      reconcileIntervalMs: 1,
    }).pipe(
      Layer.provide(Layer.succeed(RailwaySandboxClient, client)),
      Layer.provide(Layer.succeed(WorkspaceCreationIntentRepository, intents.repository)),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        const createFiber = yield* runtime
          .create({ lifecycleGeneration: "generation-1", environment: {} })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(insertStarted);
        yield* Deferred.await(secondPreInsertList);
        yield* Deferred.succeed(releasePublish, undefined);
        yield* Deferred.await(intentPublished);
        const duplicate = yield* runtime
          .create({ lifecycleGeneration: "generation-2", environment: {} })
          .pipe(Effect.result);
        observeAfterDuplicate = true;
        const observed = yield* Effect.raceFirst(
          Deferred.await(secondPublishedList).pipe(Effect.as("second-list" as const)),
          Deferred.await(discoveryStarted).pipe(Effect.as("discovery" as const)),
        );
        yield* Deferred.succeed(releaseInsert, undefined);
        const binding = yield* Fiber.join(createFiber);
        yield* runtime.adopt(binding);
        return { duplicate, observed };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(result.duplicate._tag).toBe("Failure");
    expect(result.observed).toBe("second-list");
    expect(putCalls).toBe(1);
  });

  it.each(["failed", "duplicate"] as const)(
    "releases an active reservation after a %s intent insert",
    async (failure) => {
      const operationId = "66666666-6666-4666-8666-666666666666";
      const discovered = await Effect.runPromise(Deferred.make<void>());
      const intents = makeIntentRepository();
      intents.repository.put = () =>
        Effect.fail(new Error(`${failure} insert`) as never);
      const client = {
        ...makeFakeRailwayClient().client,
        findByCreateOperationId: () =>
          Deferred.succeed(discovered, undefined).pipe(Effect.as("sandbox-abandoned")),
        destroy: () => Effect.void,
      } satisfies RailwaySandboxClientShape;
      const layer = makeWorkspaceRuntimeLive(enabledConfig, {
        createOperationId: () => operationId,
        reconcileIntervalMs: 1,
      }).pipe(
        Layer.provide(Layer.succeed(RailwaySandboxClient, client)),
        Layer.provide(Layer.succeed(WorkspaceCreationIntentRepository, intents.repository)),
      );

      const reconciled = await Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* WorkspaceRuntime;
          const result = yield* runtime
            .create({ lifecycleGeneration: "generation-1", environment: {} })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          intents.records.set(operationId, {
            operationId,
            runtimeId: null,
            createdAt: "2026-08-29T00:00:00.000Z",
          });
          return yield* Effect.raceFirst(
            Deferred.await(discovered).pipe(Effect.as(true)),
            Effect.sleep(50).pipe(Effect.as(false)),
          );
        }).pipe(Effect.provide(layer), Effect.scoped),
      );

      expect(reconciled).toBe(true);
    },
  );

  it("keeps an interrupted create owned across restart until a late sandbox is discovered and destroyed", async () => {
    const createStarted = await Effect.runPromise(Deferred.make<void>());
    const intents = makeIntentRepository();
    const fake = makeFakeRailwayClient();
    fake.client.create = () =>
      Deferred.succeed(createStarted, undefined).pipe(Effect.andThen(Effect.never));

    await Effect.runPromise(
      Effect.gen(function* () {
        const layer = makeWorkspaceRuntimeLive(enabledConfig, {
          createOperationId: () => "22222222-2222-4222-8222-222222222222",
          reconcileIntervalMs: 60_000,
        }).pipe(
          Layer.provide(Layer.succeed(RailwaySandboxClient, fake.client)),
          Layer.provide(Layer.succeed(WorkspaceCreationIntentRepository, intents.repository)),
        );
        const fiber = yield* Effect.gen(function* () {
          const runtime = yield* WorkspaceRuntime;
          return yield* runtime.create({ lifecycleGeneration: "generation-1", environment: {} });
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(createStarted);
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(intents.records.has("22222222-2222-4222-8222-222222222222")).toBe(true);
    let cleanupPass = 0;
    const restartedClient = {
      ...fake.client,
      findByCreateOperationId: () =>
        Effect.sync(() => ++cleanupPass > 31 ? "sandbox-late" : null),
      destroy: (runtimeId: string) => {
        expect(runtimeId).toBe("sandbox-late");
        return Effect.void;
      },
    } satisfies RailwaySandboxClientShape;
    for (let pass = 0; pass < 31; pass += 1) {
      await Effect.runPromise(
        reconcileWorkspaceCreationIntents({
          client: restartedClient,
          intents: intents.repository,
          ownedOperationIds: new Set(),
        }),
      );
    }
    expect(intents.records.has("22222222-2222-4222-8222-222222222222")).toBe(true);

    await Effect.runPromise(
      reconcileWorkspaceCreationIntents({
        client: restartedClient,
        intents: intents.repository,
        ownedOperationIds: new Set(),
      }),
    );
    expect(intents.records.has("22222222-2222-4222-8222-222222222222")).toBe(false);
  });

  it("converges after crashes at every marker-discovery cleanup boundary", async () => {
    const operationId = "55555555-5555-4555-8555-555555555555";
    const runtimeId = "sandbox-late";
    const makePending = () =>
      makeIntentRepository([{ operationId, runtimeId: null, createdAt: "2026-08-29T00:00:00.000Z" }]);

    const afterDiscovery = makePending();
    const discoveryCrashRepository = {
      ...afterDiscovery.repository,
      bindRuntime: () => Effect.fail(new Error("controller crashed before bind") as never),
    } satisfies WorkspaceCreationIntentRepositoryShape;
    await expect(
      Effect.runPromise(
        reconcileWorkspaceCreationIntents({
          client: {
            ...makeFakeRailwayClient().client,
            findByCreateOperationId: () => Effect.succeed(runtimeId),
          },
          intents: discoveryCrashRepository,
          ownedOperationIds: new Set(),
        }),
      ),
    ).rejects.toBeDefined();
    expect(afterDiscovery.records.get(operationId)?.runtimeId).toBeNull();

    const destroyed: string[] = [];
    await Effect.runPromise(
      reconcileWorkspaceCreationIntents({
        client: {
          ...makeFakeRailwayClient().client,
          findByCreateOperationId: () => Effect.succeed(runtimeId),
          destroy: (id) => Effect.sync(() => destroyed.push(id)),
        },
        intents: afterDiscovery.repository,
        ownedOperationIds: new Set(),
      }),
    );
    expect(destroyed).toEqual([runtimeId]);
    expect(afterDiscovery.records.has(operationId)).toBe(false);

    const afterBind = makePending();
    let destroyAttempts = 0;
    await expect(
      Effect.runPromise(
        reconcileWorkspaceCreationIntents({
          client: {
            ...makeFakeRailwayClient().client,
            findByCreateOperationId: () => Effect.succeed(runtimeId),
            destroy: () =>
              Effect.sync(() => {
                destroyAttempts += 1;
                throw new Error("controller crashed before destroy");
              }),
          } as RailwaySandboxClientShape,
          intents: afterBind.repository,
          ownedOperationIds: new Set(),
        }),
      ),
    ).rejects.toBeDefined();
    expect(afterBind.records.get(operationId)?.runtimeId).toBe(runtimeId);

    await Effect.runPromise(
      reconcileWorkspaceCreationIntents({
        client: {
          ...makeFakeRailwayClient().client,
          findByCreateOperationId: () => Effect.die("bound intents must not be rediscovered"),
          destroy: () => Effect.sync(() => { destroyAttempts += 1; }),
        } as RailwaySandboxClientShape,
        intents: afterBind.repository,
        ownedOperationIds: new Set(),
      }),
    );
    expect(destroyAttempts).toBe(2);
    expect(afterBind.records.has(operationId)).toBe(false);

    const afterDestroy = makeIntentRepository([
      { operationId, runtimeId, createdAt: "2026-08-29T00:00:00.000Z" },
    ]);
    const removalCrashRepository = {
      ...afterDestroy.repository,
      remove: () => Effect.fail(new Error("controller crashed before clear") as never),
    } satisfies WorkspaceCreationIntentRepositoryShape;
    await expect(
      Effect.runPromise(
        reconcileWorkspaceCreationIntents({
          client: {
            ...makeFakeRailwayClient().client,
            destroy: () => Effect.void,
          },
          intents: removalCrashRepository,
          ownedOperationIds: new Set(),
        }),
      ),
    ).rejects.toBeDefined();
    expect(afterDestroy.records.get(operationId)?.runtimeId).toBe(runtimeId);

    await Effect.runPromise(
      reconcileWorkspaceCreationIntents({
        client: {
          ...makeFakeRailwayClient().client,
          destroy: () =>
            Effect.fail(new RailwaySandboxNotFoundError({ operation: "destroy", runtimeId })),
        },
        intents: afterDestroy.repository,
        ownedOperationIds: new Set(),
      }),
    );
    expect(afterDestroy.records.has(operationId)).toBe(false);
  });

  it("retains a bound intent through a transient destroy failure and clears it after terminal cleanup", async () => {
    const operationId = "33333333-3333-4333-8333-333333333333";
    const intents = makeIntentRepository([
      {
        operationId,
        runtimeId: "sandbox-late",
        createdAt: "2026-08-29T00:00:00.000Z",
      },
    ]);
    let attempts = 0;
    const client = {
      ...makeFakeRailwayClient().client,
      destroy: () =>
        Effect.sync(() => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient destroy failure");
        }),
    } as RailwaySandboxClientShape;

    await expect(
      Effect.runPromise(
        reconcileWorkspaceCreationIntents({
          client,
          intents: intents.repository,
          ownedOperationIds: new Set(),
        }),
      ),
    ).rejects.toBeDefined();
    expect(intents.records.has(operationId)).toBe(true);

    await Effect.runPromise(
      reconcileWorkspaceCreationIntents({
        client,
        intents: intents.repository,
        ownedOperationIds: new Set(),
      }),
    );
    expect(intents.records.has(operationId)).toBe(false);
  });

  it("retries pending intent cleanup in the background until the late sandbox appears", async () => {
    const operationId = "44444444-4444-4444-8444-444444444444";
    const removed = await Effect.runPromise(Deferred.make<void>());
    const intents = makeIntentRepository([
      {
        operationId,
        runtimeId: null,
        createdAt: "2026-08-29T00:00:00.000Z",
      },
    ]);
    const originalRemove = intents.repository.remove;
    intents.repository.remove = (id) =>
      originalRemove(id).pipe(Effect.andThen(Deferred.succeed(removed, undefined)));
    let passes = 0;
    const client = {
      ...makeFakeRailwayClient().client,
      findByCreateOperationId: () => Effect.sync(() => ++passes >= 3 ? "sandbox-late" : null),
      destroy: () => Effect.void,
    } satisfies RailwaySandboxClientShape;
    const layer = makeWorkspaceRuntimeLive(enabledConfig, {
      reconcileIntervalMs: 1,
    }).pipe(
      Layer.provide(Layer.succeed(RailwaySandboxClient, client)),
      Layer.provide(Layer.succeed(WorkspaceCreationIntentRepository, intents.repository)),
    );

    await Effect.runPromise(
      Deferred.await(removed).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(passes).toBe(3);
    expect(intents.records.has(operationId)).toBe(false);
  });

  it("connects only to a running sandbox", async () => {
    const fake = makeFakeRailwayClient();
    fake.sandboxes.set("sandbox-stopped", {
      id: "sandbox-stopped",
      status: "STOPPED",
      region: "us-east4-eqdc4a",
    });

    const result = await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        return yield* runtime
          .connect({
            runtimeKind: "railway-sandbox",
            runtimeId: "sandbox-stopped",
            lifecycleGeneration: "generation-1",
            status: "running",
            region: "us-east4-eqdc4a",
          })
          .pipe(Effect.result);
      }),
    );

    expect(result._tag).toBe("Failure");
  });

  it("keeps a sandbox alive with a side-effect-free command", async () => {
    const fake = makeFakeRailwayClient();
    fake.sandboxes.set("sandbox-1", {
      id: "sandbox-1",
      status: "RUNNING",
      region: "us-east4-eqdc4a",
    });

    await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        yield* runtime.keepAlive({
          runtimeKind: "railway-sandbox",
          runtimeId: "sandbox-1",
          lifecycleGeneration: "generation-1",
          status: "running",
          region: "us-east4-eqdc4a",
        });
      }),
    );
  });

  it("uploads artifacts and controls durable processes through the generic boundary", async () => {
    const fake = makeFakeRailwayClient();
    const binding = {
      runtimeKind: "railway-sandbox" as const,
      runtimeId: "sandbox-1",
      lifecycleGeneration: "generation-1",
      status: "running" as const,
      region: "us-east4-eqdc4a",
    };

    const process = await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        yield* runtime.writeFile(binding, {
          path: "/opt/synara/pi-worker.mjs",
          data: "worker",
        });
        const started = yield* runtime.startDurableProcess(binding, {
          command: "node /opt/synara/pi-worker.mjs",
        });
        yield* runtime.stopDurableProcess(binding, started.sessionName);
        return started;
      }),
    );

    expect(process.sessionName).toBe("worker-session-1");
    expect(fake.writes).toHaveLength(1);
    expect(fake.durableProcesses).toHaveLength(2);
  });

  it("treats destroy of an absent sandbox as success", async () => {
    const fake = makeFakeRailwayClient();

    await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        yield* runtime.destroy({
          runtimeKind: "railway-sandbox",
          runtimeId: "missing",
          lifecycleGeneration: "generation-1",
          status: "running",
          region: "us-east4-eqdc4a",
        });
      }),
    );
  });

  it("destroys a created sandbox when initialization is not running", async () => {
    const fake = makeFakeRailwayClient({ createdStatus: "FAILED" });

    const result = await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        return yield* runtime
          .create({ lifecycleGeneration: "generation-1", environment: {} })
          .pipe(Effect.result);
      }),
    );

    expect(result._tag).toBe("Failure");
    expect(fake.sandboxes.size).toBe(0);
  });

  it("refuses lifecycle calls when Railway configuration is disabled", async () => {
    const fake = makeFakeRailwayClient();

    const result = await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        return yield* runtime
          .create({ lifecycleGeneration: "generation-1", environment: {} })
          .pipe(Effect.result);
      }),
      { enabled: false },
    );

    expect(result._tag).toBe("Failure");
    expect(fake.creates).toBe(0);
  });
});
