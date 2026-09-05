import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Effect, Fiber, Layer } from "effect";
import { WorkspaceCreationIntentRepositoryLive } from "../persistence/Layers/WorkspaceCreationIntents";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime";
import { WorkspaceCreationIntentRepository } from "../persistence/Services/WorkspaceCreationIntents";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeDockerWorkspaceRuntimeLive } from "./Layers/DockerWorkspaceRuntime";
import { WorkspaceRuntime } from "./Services/WorkspaceRuntime";
import { resolveDistributedPiRuntimeConfig } from "../providerWorker/distributedRuntimeConfig";
import { createGlasswingCrunchbaseMcpExtension } from "../provider/piMcpExtension";

const config = resolveDistributedPiRuntimeConfig({
  environment: {
    SYNARA_WORKSPACE_RUNTIME: "docker",
    SYNARA_RAILWAY_SANDBOX_TOKEN: "must-not-be-used",
    SYNARA_PROVIDER_WORKER_CONTROL_URL:
      "http://host.docker.internal:13773/internal/provider-worker",
  },
});
assert(config.enabled && config.docker && !config.railway.enabled);
process.env.GLASSWING_CRUNCHBASE_MCP_URL = "http://host.docker.internal:18080/mcp/crunchbase/";
process.env.GLASSWING_CRUNCHBASE_MCP_TOKEN = "smoke-token-not-a-real-credential";
delete process.env.SYNARA_LOCAL_DOCKER;
await assert.rejects(createGlasswingCrunchbaseMcpExtension, /HTTPS/);
process.env.SYNARA_LOCAL_DOCKER = "1";
assert(await createGlasswingCrunchbaseMcpExtension());
process.env.GLASSWING_CRUNCHBASE_MCP_URL = "http://example.com/mcp";
await assert.rejects(createGlasswingCrunchbaseMcpExtension, /HTTPS/);
delete process.env.GLASSWING_CRUNCHBASE_MCP_URL;
delete process.env.GLASSWING_CRUNCHBASE_MCP_TOKEN;
delete process.env.SYNARA_LOCAL_DOCKER;
const instance = `smoke-${randomUUID().slice(0, 8)}`;
const dockerLayer = () =>
  makeDockerWorkspaceRuntimeLive({ image: "synara-local-worker:latest", instance });
const persistenceLayer = Layer.mergeAll(
  WorkspaceCreationIntentRepositoryLive,
  ProviderSessionRuntimeRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
await Effect.runPromise(
  Effect.gen(function* () {
    const runtime = yield* WorkspaceRuntime;
    const binding = yield* runtime.create({
      lifecycleGeneration: randomUUID(),
      environment: { LOCAL_CHECK: "works" },
      networkIsolation: "PRIVATE",
    });
    try {
      const large = randomBytes(25 * 1024 * 1024);
      yield* runtime.writeFile(binding, { path: "/workspace/25mb.bin", data: large });
      const returned = yield* runtime.readFile!(binding, "/workspace/25mb.bin");
      assert.equal(
        createHash("sha256").update(returned).digest("hex"),
        createHash("sha256").update(large).digest("hex"),
      );
      yield* runtime.writeFile(binding, {
        path: "/workspace/check.bin",
        data: new Uint8Array([0, 128, 255, 10]),
        mode: 0o600,
      });
      assert.deepEqual(
        Array.from(yield* runtime.readFile!(binding, "/workspace/check.bin")),
        [0, 128, 255, 10],
      );
      assert.equal((yield* runtime.statFile!(binding, "/workspace/check.bin")).mode & 0o777, 0o600);
      assert(
        (yield* runtime.listFiles!(binding, "/workspace")).some(
          (file) => file.name === "check.bin",
        ),
      );
      assert.equal(
        (yield* runtime.exec(binding, { command: 'printf "$LOCAL_CHECK"' })).stdout,
        "works",
      );
      assert.equal(
        (yield* runtime.exec(binding, { command: "sleep 10", timeoutSeconds: 1 })).timedOut,
        true,
      );
      const process = yield* runtime.startDurableProcess(binding, { command: "sleep 60" });
      assert.equal(process.supervision, "durable");
      yield* runtime.stopDurableProcess(binding, process.sessionName);
      yield* runtime.connect(binding);
      yield* runtime.keepAlive(binding);
      assert.equal((yield* runtime.list).length, 1);
      execFileSync("docker", ["rm", "-f", `synara-${instance}-${binding.runtimeId}`]);
      yield* runtime.destroy(binding);
      yield* runtime.destroy(binding);
      const replacement = yield* runtime.create({
        lifecycleGeneration: randomUUID(),
        environment: {},
        networkIsolation: "PRIVATE",
      });
      yield* runtime.destroy(replacement);
      let admitted!: () => void;
      const admission = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const pending = Effect.runFork(
        runtime.create({
          lifecycleGeneration: randomUUID(),
          environment: {},
          networkIsolation: "PRIVATE",
          onCapacityAdmitted: () => {
            admitted();
            Effect.runFork(Fiber.interrupt(pending));
          },
        }),
      );
      yield* Effect.promise(() => admission);
      yield* Fiber.await(pending);
      assert.equal((yield* runtime.list).length, 0, "Cancellation leaked a real Docker container");
      const intents = yield* WorkspaceCreationIntentRepository;
      assert.equal((yield* intents.list()).length, 0);
      // Leave a real container with a durable intent, as if the coordinator died before adoption.
      const abandoned = yield* runtime.create({
        lifecycleGeneration: randomUUID(),
        environment: {},
        networkIsolation: "PRIVATE",
      });
      assert.equal((yield* intents.list()).length, 1);
      yield* Effect.gen(function* () {
        const recovered = yield* WorkspaceRuntime;
        assert.equal(
          (yield* recovered.list).length,
          0,
          "Startup did not reap the interrupted creation",
        );
      }).pipe(Effect.provide(dockerLayer()));
      assert.equal((yield* intents.list()).length, 0);
      yield* runtime.destroy(abandoned);
      console.log(
        "Real Docker/SQLite smoke passed: 25 MiB SHA-256 round-trip, external removal, repeated destroy, replacement, cancellation, crash-intent recovery, timeouts, durable processes.",
      );
    } finally {
      yield* runtime.destroy(binding);
    }
  }).pipe(Effect.provide(dockerLayer()), Effect.provide(persistenceLayer)),
);
