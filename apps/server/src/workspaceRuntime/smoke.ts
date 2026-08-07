import { Data, Effect, Layer } from "effect";

import { WorkspaceRuntimeError } from "./Errors";
import { makeRailwaySandboxClientLive } from "./Layers/RailwaySandboxClient";
import { makeWorkspaceRuntimeLive } from "./Layers/WorkspaceRuntime";
import { WorkspaceRuntime, type WorkspaceRuntimeShape } from "./Services/WorkspaceRuntime";
import { resolveRailwaySandboxRuntimeConfig } from "./railwaySandboxConfig";

export class RailwaySandboxSmokePolicyError extends Data.TaggedError(
  "RailwaySandboxSmokePolicyError",
)<{
  readonly detail: string;
}> {}

export interface RailwaySandboxSmokeSummary {
  readonly runtimeId: string;
  readonly region: string;
  readonly baselineSandboxCount: number;
  readonly commands: ReadonlyArray<{
    readonly name: "uname" | "node";
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly truncated: boolean;
  }>;
  readonly reconnectVerified: boolean;
  readonly keepAliveVerified: boolean;
  readonly teardownVerified: boolean;
}

const smokeCommands = [
  { name: "uname" as const, command: "uname -a" },
  { name: "node" as const, command: "node --version" },
];

const teardownPollAttempts = 30;
const teardownPollInterval = "500 millis";

const waitForTeardown = (runtime: WorkspaceRuntimeShape, runtimeId: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < teardownPollAttempts; attempt += 1) {
      const inventory = yield* runtime.list;
      const record = inventory.find((candidate) => candidate.runtimeId === runtimeId);
      if (record === undefined || record.status === "destroyed") return true;
      if (attempt + 1 < teardownPollAttempts) yield* Effect.sleep(teardownPollInterval);
    }
    return false;
  });

export function runRailwaySandboxSmoke(input: {
  readonly guard: string | undefined;
  readonly runtime: WorkspaceRuntimeShape;
}): Effect.Effect<
  RailwaySandboxSmokeSummary,
  RailwaySandboxSmokePolicyError | WorkspaceRuntimeError
> {
  if (input.guard !== "1") {
    return Effect.fail(
      new RailwaySandboxSmokePolicyError({
        detail: "Set SYNARA_RAILWAY_SANDBOX_SMOKE=1 to authorize one bounded smoke sandbox.",
      }),
    );
  }

  return Effect.gen(function* () {
    const baseline = yield* input.runtime.list;
    let createdRuntimeId: string | undefined;
    const trial = yield* Effect.acquireUseRelease(
      input.runtime.create({
        lifecycleGeneration: `smoke-${Date.now().toString(36)}`,
        environment: {},
      }).pipe(Effect.tap((binding) => Effect.sync(() => { createdRuntimeId = binding.runtimeId; }))),
      (binding) =>
        Effect.gen(function* () {
          const commands = [] as Array<RailwaySandboxSmokeSummary["commands"][number]>;
          for (const entry of smokeCommands) {
            const result = yield* input.runtime.exec(binding, {
              command: entry.command,
              timeoutSeconds: 30,
            });
            if (result.exitCode !== 0) {
              return yield* new WorkspaceRuntimeError({
                operation: "smoke",
                detail: `${entry.name} smoke command exited with ${String(result.exitCode)}.`,
                runtimeId: binding.runtimeId,
              });
            }
            commands.push({
              name: entry.name,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              truncated: result.truncated,
            });
          }

          const connected = yield* input.runtime.connect(binding);
          yield* input.runtime.keepAlive(connected);
          return {
            runtimeId: binding.runtimeId,
            region: binding.region,
            baselineSandboxCount: baseline.length,
            commands,
            reconnectVerified: true,
            keepAliveVerified: true,
          };
        }),
      (binding) => input.runtime.destroy(binding),
    );

    const teardownVerified =
      createdRuntimeId !== undefined &&
      (yield* waitForTeardown(input.runtime, createdRuntimeId));
    if (!teardownVerified) {
      return yield* new WorkspaceRuntimeError({
        operation: "smoke",
        detail: "Railway Sandbox smoke teardown could not be verified.",
        ...(createdRuntimeId === undefined ? {} : { runtimeId: createdRuntimeId }),
      });
    }

    return { ...trial, teardownVerified };
  });
}

function configFromEnvironment() {
  return resolveRailwaySandboxRuntimeConfig({
    token: process.env.SYNARA_RAILWAY_SANDBOX_TOKEN,
    environmentId: process.env.SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID,
    authType: process.env.SYNARA_RAILWAY_SANDBOX_AUTH_TYPE,
    region: process.env.SYNARA_RAILWAY_SANDBOX_REGION,
    idleTimeoutMinutes: process.env.SYNARA_RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES,
  });
}

async function main() {
  const config = configFromEnvironment();
  if (!config.enabled) {
    throw new RailwaySandboxSmokePolicyError({
      detail: "Railway Sandbox runtime configuration is disabled.",
    });
  }
  const runtimeLayer = makeWorkspaceRuntimeLive(config).pipe(
    Layer.provide(makeRailwaySandboxClientLive(config)),
  );
  const program = Effect.gen(function* () {
    const runtime = yield* WorkspaceRuntime;
    return yield* runRailwaySandboxSmoke({
      guard: process.env.SYNARA_RAILWAY_SANDBOX_SMOKE,
      runtime,
    });
  }).pipe(Effect.provide(runtimeLayer));

  const summary = await Effect.runPromise(program);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    const safeDetail =
      cause instanceof RailwaySandboxSmokePolicyError || cause instanceof WorkspaceRuntimeError
        ? cause.detail
        : "Railway Sandbox smoke failed with an unexpected error.";
    process.stderr.write(`${safeDetail}\n`);
    process.exitCode = 1;
  });
}
