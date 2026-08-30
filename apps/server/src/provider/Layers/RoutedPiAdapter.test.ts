import type { ProviderSessionStartInput } from "@synara/contracts";
import { it as effectIt } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";

import { ProviderWorkerProvisioner } from "../../providerWorker/Services/ProviderWorkerProvisioner";
import { ProviderWorkerBroker } from "../../providerWorker/Services/ProviderWorkerBroker";
import type { ProviderWorkerRuntimeBinding } from "../../providerWorker/runtimeBinding";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter";
import { makeRoutedPiAdapter, makeRoutedPiAdapterWithCapacity } from "./RoutedPiAdapter";
import { SandboxCapacity } from "../../workspaceRuntime/SandboxCapacity";
import type { SandboxCapacityLease } from "../../workspaceRuntime/SandboxCapacity";
import type { ProviderWorkerProvisionInput } from "../../providerWorker/Services/ProviderWorkerProvisioner";

const threadId = "11111111-1111-4111-8111-111111111111" as never;
const repositoryBinding = {
  kind: "git-subdirectory" as const,
  origin: "https://git.example.com",
  owner: "acme",
  repository: "portfolio",
  ref: "main",
  path: "companies/acme",
};
const runtimeBinding: ProviderWorkerRuntimeBinding = {
  schemaVersion: 1,
  runtimeKind: "railway-sandbox-pi",
  workspace: {
    runtimeKind: "railway-sandbox",
    runtimeId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
    lifecycleGeneration: "generation-1",
    status: "running",
    region: "us-west2",
  },
  fence: {
    sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
    workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
    lifecycleGeneration: "generation-1",
  },
  durableSessionName: "provider-worker-1",
  cwd: "/workspace",
  homeDir: "/workspace/.synara-provider-worker",
};

function startInput(options?: { readonly repositoryBound?: boolean }): ProviderSessionStartInput {
  return {
    threadId,
    provider: "pi",
    lifecycleGeneration: "generation-1",
    runtimeMode: "full-access",
    cwd: "/local/project",
    ...(options?.repositoryBound ? { repositoryBinding } : {}),
  };
}

function makeHarness(
  persistedBinding: ProviderWorkerRuntimeBinding | undefined = undefined,
) {
  const localStart = vi.fn(() =>
    Effect.succeed({
      provider: "pi" as const,
      threadId,
      status: "ready" as const,
      runtimeMode: "full-access" as const,
      cwd: "/local/project",
      createdAt: "2026-08-05T01:00:00.000Z",
      updatedAt: "2026-08-05T01:00:00.000Z",
    }),
  );
  const local = {
    provider: "pi",
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: localStart,
    sendTurn: vi.fn(() => Effect.fail(new Error("local session unavailable"))),
    listSessions: vi.fn(() =>
      Effect.succeed([
        {
          provider: "pi" as const,
          threadId: "22222222-2222-4222-8222-222222222222" as never,
          status: "ready" as const,
          runtimeMode: "full-access" as const,
          createdAt: "2026-08-05T01:00:00.000Z",
          updatedAt: "2026-08-05T01:00:00.000Z",
        },
      ]),
    ),
    stopSession: vi.fn(() => Effect.void),
    stopAll: vi.fn(() => Effect.void),
    streamEvents: Stream.empty,
  } as unknown as PiAdapterShape;
  const provisioner = {
    start: vi.fn(() => Effect.succeed(runtimeBinding)),
    restart: vi.fn(() => Effect.succeed(runtimeBinding)),
    adopt: vi.fn(() => Effect.void),
    stop: vi.fn(() => Effect.void),
  };
  const request = vi.fn((_fence, method: string) =>
    method === "session.start" ? localStart(startInput()) : Effect.succeed(null),
  );
  const broker = {
    request,
    streamEvents: Stream.empty,
  };
  const upsert = vi.fn(() => Effect.void);
  const directory = {
    getBinding: vi.fn(() =>
      Effect.succeed(
        persistedBinding === undefined
          ? Option.none()
          : Option.some({ runtimePayload: { distributedPiRuntime: persistedBinding } } as never),
      ),
    ),
    listBindings: vi.fn(() =>
      Effect.succeed(
        persistedBinding === undefined
          ? []
          : [
              {
                threadId,
                provider: "pi" as const,
                adapterKey: "pi:railway-sandbox",
                runtimePayload: { distributedPiRuntime: persistedBinding },
              },
            ],
      ),
    ),
    upsert,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(PiAdapter, local),
    Layer.succeed(ProviderWorkerProvisioner, provisioner as never),
    Layer.succeed(ProviderWorkerBroker, broker as never),
    Layer.succeed(ProviderSessionDirectory, directory as never),
  );
  return { layer, local, localStart, provisioner, request, upsert };
}

describe("RoutedPiAdapter", () => {
  for (const stage of [
    "checkout",
    "worker-connect",
    "remote-session-start",
    "binding-persistence",
    "intent-adoption",
  ] as const) {
    effectIt.effect(`times out a ${stage} hang 60 seconds after capacity admission`, () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const capacity = new SandboxCapacity(1);
        const occupied = yield* Effect.promise(() =>
          capacity.acquire({
            key: "occupied:generation",
            threadId: "occupied",
            lifecycleGeneration: "generation",
          }),
        );
        const stageStarted = yield* Deferred.make<void>();
        let lifecycleLease: SandboxCapacityLease | undefined;
        let intentOwned = false;
        const preBindingHang = stage === "checkout" || stage === "worker-connect";
        const startRemote = (input: ProviderWorkerProvisionInput & {
          readonly onCapacityAdmitted?: () => void;
        }) =>
          Effect.tryPromise({
            try: (signal) =>
              capacity.acquire({
                key: `${input.threadId}:${input.lifecycleGeneration}`,
                threadId: input.threadId,
                lifecycleGeneration: input.lifecycleGeneration,
                signal,
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.tap((lease) =>
              Effect.sync(() => {
                lifecycleLease = lease;
                intentOwned = true;
                input.onCapacityAdmitted?.();
              }),
            ),
            Effect.flatMap(() =>
              preBindingHang
                ? Deferred.succeed(stageStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(runtimeBinding),
            ),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                intentOwned = false;
                lifecycleLease?.release();
              }),
            ),
          );
        harness.provisioner.start.mockImplementation(startRemote as never);
        harness.provisioner.stop.mockImplementation(() =>
          Effect.sync(() => {
            intentOwned = false;
            lifecycleLease?.release();
          }),
        );
        if (stage === "remote-session-start") {
          harness.request.mockImplementation((_fence, method) =>
            method === "session.start"
              ? Deferred.succeed(stageStarted, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(null),
          );
        }
        if (stage === "binding-persistence") {
          harness.upsert.mockImplementation(() =>
            Deferred.succeed(stageStarted, undefined).pipe(Effect.andThen(Effect.never)),
          );
        }
        if (stage === "intent-adoption") {
          harness.provisioner.adopt.mockImplementation(() =>
            Deferred.succeed(stageStarted, undefined).pipe(Effect.andThen(Effect.never)),
          );
        }
        const adapter = yield* makeRoutedPiAdapterWithCapacity(capacity).pipe(
          Effect.provide(harness.layer),
        );
        const startFiber = yield* adapter
          .startSession(startInput({ repositoryBound: true }))
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

        yield* Effect.yieldNow;
        yield* TestClock.adjust("61 seconds");
        expect(startFiber.pollUnsafe()).toBeUndefined();

        occupied.release();
        yield* Deferred.await(stageStarted);
        yield* TestClock.adjust("59 seconds");
        expect(startFiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("2 seconds");
        expect(yield* Fiber.join(startFiber)).toMatchObject({
          _tag: "Failure",
          failure: {
            method: "session.start",
            detail: "Remote Pi launch timed out 60 seconds after Railway capacity admission.",
          },
        });
        expect(intentOwned).toBe(false);
        expect(capacity.snapshot().activeKeys).toEqual([]);
      }),
    );
  }

  effectIt.effect("times out an uncertain Railway create without releasing its cleanup owner", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const capacity = new SandboxCapacity(1);
      const occupied = yield* Effect.promise(() =>
        capacity.acquire({
          key: "occupied:generation",
          threadId: "occupied",
          lifecycleGeneration: "generation",
        }),
      );
      const createStarted = yield* Deferred.make<void>();
      let lease: SandboxCapacityLease | undefined;
      let intentOwned = false;
      harness.provisioner.start.mockImplementation((input: ProviderWorkerProvisionInput) =>
        Effect.tryPromise({
          try: (signal) =>
            capacity.acquire({
              key: `${input.threadId}:${input.lifecycleGeneration}`,
              threadId: input.threadId,
              lifecycleGeneration: input.lifecycleGeneration,
              signal,
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.tap((acquired) =>
            Effect.sync(() => {
              lease = acquired;
              intentOwned = true;
              input.onCapacityAdmitted?.();
            }),
          ),
          Effect.andThen(Deferred.succeed(createStarted, undefined)),
          Effect.andThen(Effect.never),
        ) as never,
      );
      const adapter = yield* makeRoutedPiAdapterWithCapacity(capacity).pipe(
        Effect.provide(harness.layer),
      );
      const startFiber = yield* adapter
        .startSession(startInput({ repositoryBound: true }))
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("61 seconds");
      expect(startFiber.pollUnsafe()).toBeUndefined();
      occupied.release();
      yield* Deferred.await(createStarted);
      yield* TestClock.adjust("61 seconds");
      expect(yield* Fiber.join(startFiber)).toMatchObject({
        _tag: "Failure",
        failure: {
          method: "session.start",
          detail: "Remote Pi launch timed out 60 seconds after Railway capacity admission.",
        },
      });
      expect(harness.provisioner.stop).not.toHaveBeenCalled();
      expect(intentOwned).toBe(true);
      expect(capacity.snapshot().activeKeys).toEqual([`${threadId}:generation-1`]);
      lease?.release();
    }),
  );

  effectIt.effect("returns success when launch wins after the timeout decision", () => {
    const completeLaunch = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const harness = makeHarness();
      const capacity = new SandboxCapacity(1);
      let lease: SandboxCapacityLease | undefined;
      harness.provisioner.start.mockImplementation((input: ProviderWorkerProvisionInput) =>
        Effect.tryPromise({
          try: (signal) =>
            capacity.acquire({
              key: `${input.threadId}:${input.lifecycleGeneration}`,
              threadId: input.threadId,
              lifecycleGeneration: input.lifecycleGeneration,
              signal,
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.tap((acquired) =>
            Effect.sync(() => {
              lease = acquired;
              input.onCapacityAdmitted?.();
            }),
          ),
          Effect.andThen(
            Effect.withFiber((fiber) =>
              Effect.sync(() => {
                const launchFiber = fiber as typeof fiber & {
                  interruptUnsafe: () => void;
                };
                launchFiber.interruptUnsafe = () => {
                  Effect.runSync(Deferred.succeed(completeLaunch, undefined));
                };
              }),
            ),
          ),
          Effect.andThen(Deferred.await(completeLaunch)),
          Effect.as(runtimeBinding),
        ) as never,
      );
      const adapter = yield* makeRoutedPiAdapterWithCapacity(capacity).pipe(
        Effect.provide(harness.layer),
      );
      const resultFiber = yield* adapter
        .startSession(startInput({ repositoryBound: true }))
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

      yield* Effect.yieldNow;
      yield* TestClock.adjust("61 seconds");
      expect(yield* Fiber.join(resultFiber)).toMatchObject({ _tag: "Success" });
      expect(harness.provisioner.stop).not.toHaveBeenCalled();
      expect(harness.upsert).toHaveBeenCalledOnce();
      expect(harness.provisioner.adopt).toHaveBeenCalledOnce();
      expect(capacity.snapshot().activeKeys).toEqual([`${threadId}:generation-1`]);
      lease?.release();
    });
  });

  effectIt.effect("surfaces failed authoritative teardown and retains uncertain ownership", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const capacity = new SandboxCapacity(1);
      const admitted = yield* Deferred.make<void>();
      let lease: SandboxCapacityLease | undefined;
      let intentOwned = false;
      harness.provisioner.start.mockImplementation((input: ProviderWorkerProvisionInput) =>
        Effect.tryPromise({
          try: (signal) =>
            capacity.acquire({
              key: `${input.threadId}:${input.lifecycleGeneration}`,
              threadId: input.threadId,
              lifecycleGeneration: input.lifecycleGeneration,
              signal,
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.tap((acquired) =>
            Effect.sync(() => {
              lease = acquired;
              intentOwned = true;
              input.onCapacityAdmitted?.();
            }),
          ),
          Effect.as(runtimeBinding),
        ) as never,
      );
      harness.request.mockImplementation((_fence, method) =>
        method === "session.start"
          ? Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(null),
      );
      harness.provisioner.stop.mockImplementation(() =>
        Effect.fail(new Error("authoritative destroy failed") as never),
      );
      const adapter = yield* makeRoutedPiAdapterWithCapacity(capacity).pipe(
        Effect.provide(harness.layer),
      );
      const resultFiber = yield* adapter
        .startSession(startInput({ repositoryBound: true }))
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(admitted);
      yield* TestClock.adjust("61 seconds");
      const result = yield* Fiber.join(resultFiber);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { method: "session.start.cleanup" },
      });
      expect(harness.provisioner.stop).toHaveBeenCalledOnce();
      expect(intentOwned).toBe(true);
      expect(capacity.snapshot().activeKeys).toEqual([`${threadId}:generation-1`]);
      lease?.release();
    }),
  );

  it("publishes queued positions and clears them when capacity starts", async () => {
    const harness = makeHarness();
    const capacity = new SandboxCapacity(1);
    const occupied = await capacity.acquire({
      key: "occupied:generation",
      threadId: "occupied" as never,
      lifecycleGeneration: "generation",
    });
    const adapter = await Effect.runPromise(
      makeRoutedPiAdapterWithCapacity(capacity).pipe(Effect.provide(harness.layer)),
    );
    const eventsFiber = Effect.runFork(
      Stream.runCollect(adapter.streamEvents.pipe(Stream.take(2))),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const waiting = capacity.acquire({
      key: `${threadId}:generation-1`,
      threadId,
      lifecycleGeneration: "generation-1",
    });
    await Promise.resolve();
    occupied.release();
    (await waiting).release();

    const events = Array.from(
      await Promise.race([
        Effect.runPromise(Fiber.join(eventsFiber)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("capacity event stream timed out")), 1_000),
        ),
      ]),
    );
    expect(events.map((event) => event.type)).toEqual([
      "runtime.capacity.changed",
      "runtime.capacity.changed",
    ]);
    expect(events.map((event) => event.payload)).toEqual([
      { state: "queued", queuePosition: 1 },
      { state: "acquired" },
    ]);
  });

  it("preserves the existing local Pi adapter as the default", async () => {
    const harness = makeHarness();
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await Effect.runPromise(adapter.startSession(startInput()));

    expect(harness.localStart).toHaveBeenCalledOnce();
    expect(harness.provisioner.start).not.toHaveBeenCalled();
    expect(adapter.managesStartSessionTimeout?.(startInput())).toBe(false);
  });

  it("moves only capacity-managed Railway launches to the post-admission timeout", async () => {
    const harness = makeHarness();
    const capacity = new SandboxCapacity(1);
    const adapter = await Effect.runPromise(
      makeRoutedPiAdapterWithCapacity(capacity).pipe(Effect.provide(harness.layer)),
    );

    expect(adapter.managesStartSessionTimeout?.(startInput())).toBe(false);
    expect(
      adapter.managesStartSessionTimeout?.(startInput({ repositoryBound: true })),
    ).toBe(true);
  });

  it("starts only an admitted repository-bound Pi session through the worker protocol", async () => {
    const harness = makeHarness();
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await Effect.runPromise(adapter.startSession(startInput({ repositoryBound: true })));

    expect(harness.provisioner.start).toHaveBeenCalledWith({
      threadId,
      lifecycleGeneration: "generation-1",
      cwd: "/local/project",
      repositoryBinding,
    });
    expect(harness.request).toHaveBeenCalledWith(
      runtimeBinding.fence,
      "session.start",
      {
        threadId,
        provider: "pi",
        lifecycleGeneration: "generation-1",
        runtimeMode: "full-access",
        cwd: "/workspace",
      },
    );
    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        provider: "pi",
        adapterKey: "pi:railway-sandbox",
        runtimePayload: { distributedPiRuntime: runtimeBinding },
      }),
    );
    expect(harness.provisioner.adopt).toHaveBeenCalledWith(runtimeBinding);
    expect(harness.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      harness.provisioner.adopt.mock.invocationCallOrder[0]!,
    );
  });

  it("rehydrates a persisted remote binding through the existing restart seam", async () => {
    const harness = makeHarness(runtimeBinding);
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await Effect.runPromise(adapter.startSession(startInput({ repositoryBound: true })));

    expect(harness.provisioner.start).not.toHaveBeenCalled();
    expect(harness.provisioner.restart).toHaveBeenCalledWith(runtimeBinding, {
      threadId,
      lifecycleGeneration: "generation-1",
      cwd: "/local/project",
      repositoryBinding,
    });
    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        adapterKey: "pi:railway-sandbox",
        runtimePayload: { distributedPiRuntime: runtimeBinding },
      }),
    );
  });

  it("stops a persisted remote sandbox after the controller adapter restarts", async () => {
    const harness = makeHarness(runtimeBinding);
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await Effect.runPromise(adapter.stopSession(threadId));

    expect(harness.request).toHaveBeenCalledWith(runtimeBinding.fence, "session.stop", { threadId });
    expect(harness.provisioner.stop).toHaveBeenCalledWith(runtimeBinding);
    expect(harness.local.stopSession).not.toHaveBeenCalled();
  });

  it("stops every persisted remote sandbox after the controller adapter restarts", async () => {
    const harness = makeHarness(runtimeBinding);
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await Effect.runPromise(adapter.stopAll());

    expect(harness.provisioner.stop).toHaveBeenCalledWith(runtimeBinding);
    expect(harness.local.stopAll).toHaveBeenCalledOnce();
  });

  it("treats sandbox destruction as authoritative when the remote stop response is lost", async () => {
    const harness = makeHarness(runtimeBinding);
    harness.request.mockImplementation((_fence, method: string) =>
      method === "session.stop"
        ? Effect.fail(new Error("worker disconnected"))
        : Effect.succeed(null),
    );
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await expect(Effect.runPromise(adapter.stopSession(threadId))).resolves.toBeUndefined();
    expect(harness.provisioner.stop).toHaveBeenCalledWith(runtimeBinding);
  });

  it("destroys the remote runtime when a sent turn becomes uncertain", async () => {
    const harness = makeHarness();
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));
    await Effect.runPromise(adapter.startSession(startInput({ repositoryBound: true })));
    harness.request.mockImplementation((_fence, method: string) =>
      method === "turn.send"
        ? Effect.fail(new Error("response lost after dispatch"))
        : Effect.succeed(null),
    );

    const result = await Effect.runPromise(
      adapter
        .sendTurn({ threadId, prompt: "ambiguous" } as never)
        .pipe(Effect.result),
    );

    expect(result._tag).toBe("Failure");
    expect(harness.provisioner.stop).toHaveBeenCalledWith(runtimeBinding);
  });

  it("keeps local session discovery available when a remote worker is down", async () => {
    const harness = makeHarness();
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));
    await Effect.runPromise(adapter.startSession(startInput({ repositoryBound: true })));
    harness.request.mockImplementation((_fence, method: string) =>
      method === "session.list"
        ? Effect.fail(new Error("worker unavailable"))
        : Effect.succeed(null),
    );

    const sessions = await Effect.runPromise(adapter.listSessions());

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.threadId).toBe("22222222-2222-4222-8222-222222222222");
  });
});
