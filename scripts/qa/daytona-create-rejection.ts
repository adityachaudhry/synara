/** Uses the real configured dev API and a disposable SQLite intent store. No mocks or sandbox deletion. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../../apps/server/src/persistence/NodeSqliteClient.ts";
import { WorkspaceCreationIntentRepositoryLive } from "../../apps/server/src/persistence/Layers/WorkspaceCreationIntents.ts";
import { WorkspaceCreationIntentRepository } from "../../apps/server/src/persistence/Services/WorkspaceCreationIntents.ts";
import { makeDaytonaSandboxClientLive } from "../../apps/server/src/workspaceRuntime/Layers/DaytonaSandboxClient.ts";
import { makeWorkspaceRuntimeLive } from "../../apps/server/src/workspaceRuntime/Layers/WorkspaceRuntime.ts";
import { WorkspaceRuntime } from "../../apps/server/src/workspaceRuntime/Services/WorkspaceRuntime.ts";
import { SandboxCapacity } from "../../apps/server/src/workspaceRuntime/SandboxCapacity.ts";
import { resolveDaytonaSandboxRuntimeConfig } from "../../apps/server/src/workspaceRuntime/daytonaSandboxConfig.ts";
import { verifyDaytonaWorkerRegion } from "../../apps/server/src/providerWorker/prepareDaytonaTemplate.ts";

assert(process.argv.includes("--expect-dev-region-rejection"), "Only run while dev US access is authoritatively denied");
const env = JSON.parse(execFileSync("railway", ["variable", "list", "--json", "-p", "2fb578c6-304e-4a97-abd4-38b3897d9030", "-e", "dev", "-s", "synara-gitea-dev"], { encoding: "utf8" }));
const config = resolveDaytonaSandboxRuntimeConfig(env);
assert(config.enabled && config.target === "us");
await assert.rejects(verifyDaytonaWorkerRegion(config), /container access is unavailable in us/);
const capacity = new SandboxCapacity(1);
const sqlite = NodeSqliteClient.layerMemory();
const intents = WorkspaceCreationIntentRepositoryLive.pipe(Layer.provide(sqlite));
const runtime = makeWorkspaceRuntimeLive({ ...config, region: config.target }, { capacity, runtimeKind: "daytona-sandbox" }).pipe(
  Layer.provideMerge(makeDaytonaSandboxClientLive(config)), Layer.provideMerge(intents), Layer.provideMerge(sqlite),
);
await Effect.runPromise(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workspace_creation_intents (operation_id TEXT PRIMARY KEY, runtime_id TEXT, created_at TEXT NOT NULL)`;
  const workspace = yield* WorkspaceRuntime;
  const intentStore = yield* WorkspaceCreationIntentRepository;
  for (let trial = 0; trial < 4; trial++) {
    const result = yield* Effect.exit(workspace.create({ threadId: "qa-rejection-" + randomUUID(), lifecycleGeneration: randomUUID(), environment: {} }));
    assert(Exit.isFailure(result), "Region denial changed; do not claim a rejected-create check passed");
    const failure = Cause.squash(result.cause) as { cause?: { cause?: { statusCode?: number } } };
    assert.equal(failure.cause?.cause?.statusCode, 403, "Expected the actual provider entitlement rejection");
    assert.equal(capacity.snapshot().activeKeys.length, 0, "Rejected create leaked its admission slot");
    assert.equal((yield* intentStore.list()).length, 0, "Rejected create retained an unresolved creation intent");
  }
  console.log("PASS: real US rejection repeated beyond the one-slot limit; all capacity and SQLite intents released. CI region preflight rejected the inaccessible region.");
}).pipe(Effect.provide(runtime), Effect.scoped));
