import { Effect, Layer } from "effect";
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
import { makeWorkspaceRuntimeLive } from "./WorkspaceRuntime";

function makeFakeRailwayClient(options?: {
  readonly createdStatus?: RailwaySandboxRecord["status"];
  readonly expectedNetworkIsolation?: "PRIVATE" | "ISOLATED";
}) {
  const sandboxes = new Map<string, RailwaySandboxRecord>();
  let creates = 0;
  const writes: unknown[] = [];
  const durableProcesses: unknown[] = [];

  const client: RailwaySandboxClientShape = {
    create: (input) =>
      Effect.gen(function* () {
        if (
          input.networkIsolation !== (options?.expectedNetworkIsolation ?? "PRIVATE") ||
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
    list: Effect.sync(() => Array.from(sandboxes.values())),
  };

  return { client, sandboxes, writes, durableProcesses, get creates() { return creates; } };
}

const enabledConfig = {
  enabled: true as const,
  token: "not-observable-by-runtime",
  authType: "bearer" as const,
  environmentId: "environment-1",
  region: "us-east4-eqdc4a",
  idleTimeoutMinutes: 30,
  networkIsolation: "PRIVATE" as const,
};

function runWorkspace<A>(
  client: RailwaySandboxClientShape,
  effect: Effect.Effect<A, WorkspaceRuntimeError, WorkspaceRuntime>,
  config = enabledConfig,
) {
  const layer = makeWorkspaceRuntimeLive(config).pipe(
    Layer.provide(Layer.succeed(RailwaySandboxClient, client)),
  );
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

describe("WorkspaceRuntime", () => {
  it("creates a private sandbox with the configured idle timeout", async () => {
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
    });
  });

  it("creates an isolated sandbox when distributed checkout policy requests it", async () => {
    const fake = makeFakeRailwayClient({ expectedNetworkIsolation: "ISOLATED" });

    const binding = await runWorkspace(
      fake.client,
      Effect.gen(function* () {
        const runtime = yield* WorkspaceRuntime;
        return yield* runtime.create({ lifecycleGeneration: "generation-1", environment: {} });
      }),
      { ...enabledConfig, networkIsolation: "ISOLATED" as const },
    );

    expect(binding.runtimeId).toBe("sandbox-1");
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
