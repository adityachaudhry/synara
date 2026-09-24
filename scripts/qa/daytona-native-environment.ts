/** Real US dev lifecycle check; creates and deletes one sandbox, with no mocks. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import { makeDaytonaSandboxClientLive } from "../../apps/server/src/workspaceRuntime/Layers/DaytonaSandboxClient.ts";
import { RailwaySandboxClient } from "../../apps/server/src/workspaceRuntime/Services/RailwaySandboxClient.ts";
import { resolveDaytonaSandboxRuntimeConfig } from "../../apps/server/src/workspaceRuntime/daytonaSandboxConfig.ts";

assert(process.argv.includes("--run-daytona-dev"), "Pass --run-daytona-dev to run the disposable US trial");
const environment = JSON.parse(execFileSync("railway", ["variable", "list", "--json",
  "-p", "2fb578c6-304e-4a97-abd4-38b3897d9030", "-e", "dev", "-s", "synara-gitea-dev",
], { encoding: "utf8" }));
const config = resolveDaytonaSandboxRuntimeConfig(environment);
assert(config.enabled && config.target === "us", "Expected the configured US Daytona dev runtime");
await Effect.runPromise(Effect.gen(function* () {
  const client = yield* RailwaySandboxClient;
  const marker = { SYNARA_QA_ENV_MARKER: "present" };
  const sandbox = yield* client.create({ operationId: randomUUID(), environment: marker,
    networkIsolation: "ISOLATED", idleTimeoutMinutes: 5 });
  const probe = () => client.exec(sandbox.id, {
    command: "test \"$SYNARA_QA_ENV_MARKER\" = present", timeoutSeconds: 10,
  });
  yield* Effect.gen(function* () {
    assert.equal((yield* probe()).exitCode, 0);
    yield* client.stop!(sandbox.id);
    yield* client.start!(sandbox.id);
    assert.equal((yield* probe()).exitCode, 1, "Daemon environment must not be mistaken for persistent configuration");
    yield* client.stop!(sandbox.id);
    yield* client.start!(sandbox.id, marker);
    assert.equal((yield* probe()).exitCode, 0, "Production resume must restore the current environment");
    console.log("PASS: native stop/start reapplies current environment; no credentials were printed");
  }).pipe(Effect.ensuring(client.destroy(sandbox.id)));
}).pipe(Effect.provide(makeDaytonaSandboxClientLive(config)), Effect.scoped));
