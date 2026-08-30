import type { ProviderSessionStartInput } from "@synara/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ProviderWorkerProvisioner } from "../../providerWorker/Services/ProviderWorkerProvisioner";
import { ProviderWorkerBroker } from "../../providerWorker/Services/ProviderWorkerBroker";
import type { ProviderWorkerRuntimeBinding } from "../../providerWorker/runtimeBinding";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter";
import { makeRoutedPiAdapter } from "./RoutedPiAdapter";

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
    stopSession: vi.fn(() => Effect.void),
    stopAll: vi.fn(() => Effect.void),
    streamEvents: Stream.empty,
  } as unknown as PiAdapterShape;
  const provisioner = {
    start: vi.fn(() => Effect.succeed(runtimeBinding)),
    restart: vi.fn(() => Effect.succeed(runtimeBinding)),
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
  it("preserves the existing local Pi adapter as the default", async () => {
    const harness = makeHarness();
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await Effect.runPromise(adapter.startSession(startInput()));

    expect(harness.localStart).toHaveBeenCalledOnce();
    expect(harness.provisioner.start).not.toHaveBeenCalled();
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
});
