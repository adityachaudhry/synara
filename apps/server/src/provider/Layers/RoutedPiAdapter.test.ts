import type { ProjectRepositoryBinding, ProviderSessionStartInput } from "@synara/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ProviderWorkerProvisioner } from "../../providerWorker/Services/ProviderWorkerProvisioner";
import { ProviderWorkerBroker } from "../../providerWorker/Services/ProviderWorkerBroker";
import type { ProviderWorkerRuntimeBinding } from "../../providerWorker/runtimeBinding";
import { ServerSettingsService } from "../../serverSettings";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter";
import { makeRoutedPiAdapter } from "./RoutedPiAdapter";

const threadId = "11111111-1111-4111-8111-111111111111" as never;
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

const repositoryBinding: ProjectRepositoryBinding = {
  kind: "gitea-subdirectory",
  origin: "https://glasswing-gitea-dev.up.railway.app",
  owner: "glasswing-admin",
  repository: "glasswing-company-data",
  ref: "main",
  path: "companies/cue-cloud",
};

const repositoryRuntimeBinding: ProviderWorkerRuntimeBinding = {
  ...runtimeBinding,
  cwd: "/workspace/repository/companies/cue-cloud",
  repositoryCheckout: {
    binding: repositoryBinding,
    commit: "0123456789abcdef0123456789abcdef01234567",
  },
};

function startInput(): ProviderSessionStartInput {
  return {
    threadId,
    provider: "pi",
    lifecycleGeneration: "generation-1",
    runtimeMode: "full-access",
    cwd: "/workspace",
  };
}

function makeHarness(
  target: "local" | "railway-sandbox",
  persistedBinding: ProviderWorkerRuntimeBinding | undefined = undefined,
) {
  const localStart = vi.fn(() =>
    Effect.succeed({
      provider: "pi" as const,
      threadId,
      status: "ready" as const,
      runtimeMode: "full-access" as const,
      cwd: "/workspace",
      createdAt: "2026-08-05T01:00:00.000Z",
      updatedAt: "2026-08-05T01:00:00.000Z",
    }),
  );
  const local = {
    provider: "pi",
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: localStart,
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
    upsert,
  };
  const settings = {
    getSettings: Effect.succeed({ providers: { pi: { executionTarget: target } } }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(PiAdapter, local),
    Layer.succeed(ProviderWorkerProvisioner, provisioner as never),
    Layer.succeed(ProviderWorkerBroker, broker as never),
    Layer.succeed(ProviderSessionDirectory, directory as never),
    Layer.succeed(ServerSettingsService, settings as never),
  );
  return { layer, localStart, provisioner, request, upsert };
}

describe("RoutedPiAdapter", () => {
  it("preserves the existing local Pi adapter as the default", async () => {
    const harness = makeHarness("local");
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await Effect.runPromise(adapter.startSession(startInput()));

    expect(harness.localStart).toHaveBeenCalledOnce();
    expect(harness.provisioner.start).not.toHaveBeenCalled();
  });

  it("starts remote Pi through the worker protocol and persists its additive binding", async () => {
    const harness = makeHarness("railway-sandbox");
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await Effect.runPromise(adapter.startSession(startInput()));

    expect(harness.provisioner.start).toHaveBeenCalledWith({
      lifecycleGeneration: "generation-1",
      cwd: "/workspace",
    });
    expect(harness.request).toHaveBeenCalledWith(
      runtimeBinding.fence,
      "session.start",
      startInput(),
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

  it("hydrates a Gitea-bound project remotely and starts Pi in the sandbox checkout", async () => {
    const harness = makeHarness("railway-sandbox");
    harness.provisioner.start.mockReturnValue(Effect.succeed(repositoryRuntimeBinding));
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));
    const input = {
      ...startInput(),
      cwd: "/data/gitea-company-projects/cue-cloud",
      repositoryBinding,
    };

    await Effect.runPromise(adapter.startSession(input));

    expect(harness.provisioner.start).toHaveBeenCalledWith({
      lifecycleGeneration: "generation-1",
      cwd: "/data/gitea-company-projects/cue-cloud",
      repositoryBinding,
    });
    const remoteStartInput = harness.request.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(remoteStartInput).toMatchObject({
      threadId,
      cwd: "/workspace/repository/companies/cue-cloud",
      lifecycleGeneration: "generation-1",
    });
    expect(remoteStartInput).not.toHaveProperty("repositoryBinding");
  });

  it("fails closed instead of running a Gitea-bound project on the controller", async () => {
    const harness = makeHarness("local");
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await expect(
      Effect.runPromise(adapter.startSession({ ...startInput(), repositoryBinding })),
    ).rejects.toMatchObject({ method: "session.start" });
    expect(harness.localStart).not.toHaveBeenCalled();
    expect(harness.provisioner.start).not.toHaveBeenCalled();
  });

  it("rehydrates a persisted remote binding through the existing restart seam", async () => {
    const harness = makeHarness("railway-sandbox", runtimeBinding);
    const adapter = await Effect.runPromise(makeRoutedPiAdapter.pipe(Effect.provide(harness.layer)));

    await Effect.runPromise(adapter.startSession(startInput()));

    expect(harness.provisioner.start).not.toHaveBeenCalled();
    expect(harness.provisioner.restart).toHaveBeenCalledWith(runtimeBinding, {
      lifecycleGeneration: "generation-1",
      cwd: "/workspace",
    });
    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        adapterKey: "pi:railway-sandbox",
        runtimePayload: { distributedPiRuntime: runtimeBinding },
      }),
    );
  });
});
