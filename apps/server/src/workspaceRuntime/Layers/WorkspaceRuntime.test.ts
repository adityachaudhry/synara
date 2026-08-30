import { Deferred, Effect, Fiber, Layer } from "effect";
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
  makeWorkspaceRuntimeLive,
  reconcileWorkspaceCreationIntents,
} from "./WorkspaceRuntime";

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
    destroyByCreateOperationId: () => Effect.succeed(false),
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

  it("keeps an interrupted create owned across restart until a late sandbox is destroyed", async () => {
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
      destroyByCreateOperationId: () => Effect.sync(() => ++cleanupPass > 31),
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
      destroyByCreateOperationId: () => Effect.sync(() => ++passes >= 3),
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
