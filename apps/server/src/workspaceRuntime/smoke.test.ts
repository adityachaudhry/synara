import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { WorkspaceRuntimeError } from "./Errors";
import type {
  WorkspaceRuntimeBinding,
  WorkspaceRuntimeShape,
} from "./Services/WorkspaceRuntime";
import { RailwaySandboxSmokePolicyError, runRailwaySandboxSmoke } from "./smoke";

function makeFakeRuntime(options?: {
  readonly failCommand?: string;
  readonly destroyingListResponses?: number;
  readonly retainDestroyedRecord?: boolean;
}) {
  const active = new Set<string>();
  let createCount = 0;
  let destroyCount = 0;
  let destroyingListResponses = 0;
  let destroyed = false;
  const binding: WorkspaceRuntimeBinding = {
    runtimeKind: "railway-sandbox",
    runtimeId: "sandbox-1",
    lifecycleGeneration: "smoke-generation",
    status: "running",
    region: "us-east4-eqdc4a",
  };

  const runtime: WorkspaceRuntimeShape = {
    create: () =>
      Effect.sync(() => {
        createCount += 1;
        active.add(binding.runtimeId);
        return binding;
      }),
    connect: () => Effect.succeed(binding),
    exec: (_binding, input) =>
      input.command === options?.failCommand
        ? Effect.fail(
            new WorkspaceRuntimeError({
              operation: "exec",
              detail: "injected failure containing secret-output",
            }),
          )
        : Effect.succeed({
            exitCode: 0,
            stdout: "secret-output",
            stderr: "",
            timedOut: false,
            truncated: false,
          }),
    keepAlive: () => Effect.void,
    destroy: (value) =>
      Effect.sync(() => {
        destroyCount += 1;
        destroyed = true;
        destroyingListResponses = options?.destroyingListResponses ?? 0;
        if (destroyingListResponses === 0 && !options?.retainDestroyedRecord) {
          active.delete(value.runtimeId);
        }
      }),
    list: Effect.sync(() => {
      const result = Array.from(active, (runtimeId) => ({
        runtimeKind: "railway-sandbox" as const,
        runtimeId,
        status:
          destroyingListResponses > 0
            ? ("destroying" as const)
            : destroyed
              ? ("destroyed" as const)
              : ("running" as const),
        region: "us-east4-eqdc4a",
      }));
      if (destroyingListResponses > 0) {
        destroyingListResponses -= 1;
        if (destroyingListResponses === 0) active.clear();
      }
      return result;
    }),
  };

  return {
    runtime,
    get createCount() {
      return createCount;
    },
    get destroyCount() {
      return destroyCount;
    },
  };
}

describe("runRailwaySandboxSmoke", () => {
  it("refuses to run without the explicit smoke guard", async () => {
    const fake = makeFakeRuntime();

    const result = await Effect.runPromise(
      runRailwaySandboxSmoke({ guard: undefined, runtime: fake.runtime }).pipe(Effect.result),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(RailwaySandboxSmokePolicyError);
    }
    expect(fake.createCount).toBe(0);
  });

  it("creates one sandbox and verifies teardown", async () => {
    const fake = makeFakeRuntime();

    const summary = await Effect.runPromise(
      runRailwaySandboxSmoke({ guard: "1", runtime: fake.runtime }),
    );

    expect(fake.createCount).toBe(1);
    expect(fake.destroyCount).toBe(1);
    expect(summary.teardownVerified).toBe(true);
    expect(summary.commands.map((command) => command.exitCode)).toEqual([0, 0]);
    expect(JSON.stringify(summary)).not.toContain("secret-output");
  });

  it("waits for asynchronous Railway teardown to disappear from inventory", async () => {
    const fake = makeFakeRuntime({ destroyingListResponses: 1 });

    const summary = await Effect.runPromise(
      runRailwaySandboxSmoke({ guard: "1", runtime: fake.runtime }),
    );

    expect(summary.teardownVerified).toBe(true);
    expect(fake.destroyCount).toBe(1);
  });

  it("accepts a terminal destroyed record retained by project-token inventory", async () => {
    const fake = makeFakeRuntime({ retainDestroyedRecord: true });

    const summary = await Effect.runPromise(
      runRailwaySandboxSmoke({ guard: "1", runtime: fake.runtime }),
    );

    expect(summary.teardownVerified).toBe(true);
    expect(fake.destroyCount).toBe(1);
  });

  it("destroys the sandbox after an intermediate command failure", async () => {
    const fake = makeFakeRuntime({ failCommand: "node --version" });

    const result = await Effect.runPromise(
      runRailwaySandboxSmoke({ guard: "1", runtime: fake.runtime }).pipe(Effect.result),
    );

    expect(result._tag).toBe("Failure");
    expect(fake.createCount).toBe(1);
    expect(fake.destroyCount).toBe(1);
  });
});
