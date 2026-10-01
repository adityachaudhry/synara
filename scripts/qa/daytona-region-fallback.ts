/** Real entitlement, allocation, private bytes, and intent checks. No application upload or production access. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../../apps/server/src/persistence/NodeSqliteClient.ts";
import { WorkspaceCreationIntentRepositoryLive } from "../../apps/server/src/persistence/Layers/WorkspaceCreationIntents.ts";
import { WorkspaceCreationIntentRepository } from "../../apps/server/src/persistence/Services/WorkspaceCreationIntents.ts";
import { makeDaytonaSandboxClientLive } from "../../apps/server/src/workspaceRuntime/Layers/DaytonaSandboxClient.ts";
import { makeWorkspaceRuntimeLive } from "../../apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.ts";
import { WorkspaceRuntime } from "../../apps/server/src/workspaceRuntime/Services/WorkspaceRuntime.ts";
import { SandboxCapacity } from "../../apps/server/src/workspaceRuntime/SandboxCapacity.ts";
import { resolveDaytonaSandboxRuntimeConfig } from "../../apps/server/src/workspaceRuntime/daytonaSandboxConfig.ts";
import { availableDaytonaContainerTargets } from "../../apps/server/src/workspaceRuntime/daytonaRegions.ts";

assert(process.argv.includes("--run-dev"), "Pass --run-dev to allocate disposable empty EU disks");
const env = JSON.parse(execFileSync("railway", ["variable", "list", "--json", "-p", "2fb578c6-304e-4a97-abd4-38b3897d9030", "-e", "2e924ee7-34be-449d-8ffd-1da0458d482a", "-s", "d3582330-7988-4cd9-a4ce-0607b5e14b7e"], { encoding: "utf8" }));
const configured = resolveDaytonaSandboxRuntimeConfig(env);
assert(configured.enabled && configured.target === "us");
const available = await availableDaytonaContainerTargets(configured);
assert(!available.has("us") && available.has("eu"), "This check requires the observed US outage and EU entitlement");
const config = { ...configured, fallbackTarget: "eu", fallbackSnapshot: "daytona-small", warmPoolSize: 0 };
const capacity = new SandboxCapacity(4);
const sqlite = NodeSqliteClient.layerMemory();
const runtime = makeWorkspaceRuntimeLive({ ...config, region: config.target }, { capacity, runtimeKind: "daytona-sandbox" }).pipe(
  Layer.provideMerge(makeDaytonaSandboxClientLive(config)),
  Layer.provideMerge(WorkspaceCreationIntentRepositoryLive.pipe(Layer.provide(sqlite))), Layer.provideMerge(sqlite),
);
const evidence = { checkedAt: new Date().toISOString(), available: [...available], trials: [] as unknown[], cleanup: [] as unknown[] };
mkdirSync("output/daytona-failover", { recursive: true });
const save = () => writeFileSync("output/daytona-failover/real-region-fallback.json", JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
await Effect.runPromise(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workspace_creation_intents (operation_id TEXT PRIMARY KEY, runtime_id TEXT, created_at TEXT NOT NULL)`;
  const workspace = yield* WorkspaceRuntime;
  const intents = yield* WorkspaceCreationIntentRepository;
  for (let trial = 0; trial < 3; trial++) {
    const start = Date.now();
    const handle = yield* workspace.create({ threadId: "qa-region-" + randomUUID(), lifecycleGeneration: randomUUID(), environment: {}, networkIsolation: "ISOLATED" });
    evidence.trials.push({ trial, region: handle.region, runtimeId: handle.runtimeId, allocationMs: Date.now() - start }); save();
    yield* Effect.gen(function* () {
      assert.equal(handle.region, "eu");
      const marker = randomUUID();
      yield* workspace.writeFile(handle, { path: "/tmp/region-qa-private.txt", data: new TextEncoder().encode(marker), mode: 0o600 });
      assert.equal(new TextDecoder().decode(yield* workspace.readFile(handle, "/tmp/region-qa-private.txt")), marker);
      yield* workspace.adopt(handle);
      assert.equal((yield* intents.list()).length, 0);
      evidence.trials.push({ trial, region: handle.region, runtimeId: handle.runtimeId, readyAndVerifiedMs: Date.now() - start }); save();
    }).pipe(Effect.ensuring(workspace.destroy(handle).pipe(Effect.tap(() => Effect.sync(() => {
      evidence.cleanup.push({ runtimeId: handle.runtimeId, deleted: true }); save();
    })))));
  }
  assert.equal(capacity.snapshot().activeKeys.length, 0);
  console.log("PASS: three real EU fallback allocations preserved private bytes and released all intents/capacity.");
}).pipe(Effect.provide(runtime), Effect.scoped));
