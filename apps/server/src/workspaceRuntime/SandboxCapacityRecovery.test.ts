import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderSessionRuntimeRepositoryShape } from "../persistence/Services/ProviderSessionRuntime";
import type { WorkspaceCreationIntentRepositoryShape } from "../persistence/Services/WorkspaceCreationIntents";
import type { RailwaySandboxClientShape } from "./Services/RailwaySandboxClient";
import { SandboxCapacity } from "./SandboxCapacity";
import { reconcileSandboxCapacityAtStartup } from "./Layers/WorkspaceRuntime";
import { decodeProviderWorkerRuntimeBinding } from "../providerWorker/runtimeBinding";

const runtimeBinding = {
  schemaVersion: 1,
  runtimeKind: "railway-sandbox-pi",
  threadId: "11111111-1111-4111-8111-111111111111",
  workspace: {
    runtimeKind: "railway-sandbox",
    runtimeId: "runtime-live",
    lifecycleGeneration: "generation-live",
    status: "running",
    region: "us-west2",
  },
  fence: {
    sandboxId: "11111111-1111-4111-8111-111111111111",
    workerId: "22222222-2222-4222-8222-222222222222",
    lifecycleGeneration: "generation-live",
  },
  durableSessionName: "worker",
  cwd: "/workspace",
  homeDir: "/workspace/.synara",
};

function repositories() {
  const intents = {
    list: () =>
      Effect.succeed([
        {
          operationId: "operation-pending",
          runtimeId: null,
          createdAt: "2026-08-29T00:00:00.000Z",
        },
      ]),
  } as WorkspaceCreationIntentRepositoryShape;
  const runtimes = {
    list: () =>
      Effect.succeed([
        {
          threadId: "11111111-1111-4111-8111-111111111111" as never,
          providerName: "pi",
          adapterKey: "pi:railway-sandbox",
          runtimeMode: "full-access" as const,
          status: "running" as const,
          lifecycleGeneration: "generation-live",
          lastSeenAt: "2026-08-29T00:00:00.000Z" as never,
          resumeCursor: null,
          runtimePayload: { distributedPiRuntime: runtimeBinding },
        },
      ]),
  } as ProviderSessionRuntimeRepositoryShape;
  return { intents, runtimes };
}

describe("sandbox capacity startup recovery", () => {
  it("reconciles live bindings and pending intents before admitting new creates and reports orphans", async () => {
    const capacity = new SandboxCapacity(3, { reconcileBeforeAdmission: true });
    const { intents, runtimes } = repositories();
    const client = {
      list: Effect.succeed([
        { id: "runtime-live", status: "RUNNING", region: "us-west2" },
        { id: "runtime-pending", status: "RUNNING", region: "us-west2" },
        { id: "runtime-orphan", status: "RUNNING", region: "us-west2" },
      ]),
      findByCreateOperationId: () => Effect.succeed("runtime-pending"),
    } as RailwaySandboxClientShape;

    const report = await Effect.runPromise(
      reconcileSandboxCapacityAtStartup({ client, intents, runtimes, capacity }),
    );

    expect(capacity.snapshot().activeKeys).toEqual([
      "11111111-1111-4111-8111-111111111111:generation-live",
      "create-intent:operation-pending",
    ]);
    expect(report.orphanRuntimeIds).toEqual(["runtime-orphan"]);
  });

  it("keeps admission closed when Railway inventory fails transiently", async () => {
    const capacity = new SandboxCapacity(1, { reconcileBeforeAdmission: true });
    const { intents, runtimes } = repositories();
    const client = {
      list: Effect.fail(new Error("inventory unavailable")),
    } as RailwaySandboxClientShape;

    await expect(
      Effect.runPromise(reconcileSandboxCapacityAtStartup({ client, intents, runtimes, capacity })),
    ).rejects.toBeDefined();
    expect(capacity.snapshot()).toMatchObject({ reconciled: false, activeKeys: [] });
    let admitted = false;
    void capacity.acquire({
      key: "thread-new:generation-new",
      threadId: "thread-new",
      lifecycleGeneration: "generation-new",
    }).then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
  });

  it("restores the capacity key on legacy durable bindings so stop can release it", () => {
    const binding = decodeProviderWorkerRuntimeBinding(runtimeBinding);

    expect(binding?.workspace.capacityKey).toBe(
      "11111111-1111-4111-8111-111111111111:generation-live",
    );
  });

  it("fails closed when a persisted capacity key disagrees with its thread generation", async () => {
    const capacity = new SandboxCapacity(1, { reconcileBeforeAdmission: true });
    const { intents } = repositories();
    const mismatchedBinding = {
      ...runtimeBinding,
      workspace: { ...runtimeBinding.workspace, capacityKey: "another-thread:generation-live" },
    };
    const runtimes = {
      list: () =>
        Effect.succeed([
          {
            threadId: "11111111-1111-4111-8111-111111111111" as never,
            providerName: "pi",
            adapterKey: "pi:railway-sandbox",
            runtimeMode: "full-access" as const,
            status: "running" as const,
            lifecycleGeneration: "generation-live",
            lastSeenAt: "2026-08-29T00:00:00.000Z" as never,
            resumeCursor: null,
            runtimePayload: { distributedPiRuntime: mismatchedBinding },
          },
        ]),
    } as ProviderSessionRuntimeRepositoryShape;
    const client = {
      list: Effect.succeed([{ id: "runtime-live", status: "RUNNING", region: "us-west2" }]),
      findByCreateOperationId: () => Effect.succeed(null),
    } as RailwaySandboxClientShape;

    await expect(
      Effect.runPromise(reconcileSandboxCapacityAtStartup({ client, intents, runtimes, capacity })),
    ).rejects.toMatchObject({ operation: "capacity.reconcile" });
    expect(capacity.snapshot()).toEqual({ activeKeys: [], queued: [], reconciled: false });
  });
});
