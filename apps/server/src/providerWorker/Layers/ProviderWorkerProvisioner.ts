import { randomUUID } from "node:crypto";
import { Effect, FileSystem, Layer } from "effect";

import { WorkspaceRuntime } from "../../workspaceRuntime/Services/WorkspaceRuntime";
import { ProviderWorkerProvisioningError } from "../Errors";
import type { ProviderWorkerFence } from "../fence";
import {
  ProviderWorkerProvisioner,
  type ProviderWorkerProvisionerShape,
} from "../Services/ProviderWorkerProvisioner";
import { ProviderWorkerBootstrapAuthority } from "../Services/ProviderWorkerBootstrapAuthority";
import { ProviderWorkerBroker } from "../Services/ProviderWorkerBroker";
import type { ProviderWorkerRuntimeBinding } from "../runtimeBinding";

const WORKER_ARTIFACT_PATH = "/opt/synara/provider-worker.mjs";
const WORKER_CONFIG_PATH = "/opt/synara/provider-worker.json";
const DEFAULT_CWD = "/workspace";
const DEFAULT_HOME_DIR = "/workspace/.synara-provider-worker";

export interface ProviderWorkerProvisionerOptions {
  readonly artifact: Uint8Array;
  readonly controlUrl: string;
  readonly environment?: Readonly<Record<string, string>>;
}

function provisionError(operation: string, detail: string, cause: unknown, sandboxId?: string) {
  return new ProviderWorkerProvisioningError({
    operation,
    detail,
    ...(sandboxId === undefined ? {} : { sandboxId }),
    cause,
  });
}

export const makeProviderWorkerProvisioner = (options: ProviderWorkerProvisionerOptions) =>
  Effect.gen(function* () {
    const workspaceRuntime = yield* WorkspaceRuntime;
    const broker = yield* ProviderWorkerBroker;
    const authority = yield* ProviderWorkerBootstrapAuthority;

    const provisionConnectedWorker = Effect.fn(function* (input: {
      readonly workspace: ProviderWorkerRuntimeBinding["workspace"];
      readonly lifecycleGeneration: string;
      readonly cwd: string;
      readonly homeDir: string;
    }) {
      const fence: ProviderWorkerFence = {
        sandboxId: input.workspace.runtimeId,
        workerId: randomUUID(),
        lifecycleGeneration: input.lifecycleGeneration,
      };
      const credential = yield* authority.issue(fence);
      yield* broker.expectWorker(fence);
      yield* Effect.logInfo("provider worker reserved", {
        sandboxId: fence.sandboxId,
        workerId: fence.workerId,
        lifecycleGeneration: fence.lifecycleGeneration,
      });
      let durableSessionName: string | undefined;

      const launch = Effect.gen(function* () {
        yield* Effect.logInfo("provider worker artifact upload starting", {
          sandboxId: fence.sandboxId,
          bytes: options.artifact.byteLength,
        });
        yield* workspaceRuntime.writeFile(input.workspace, {
          path: WORKER_ARTIFACT_PATH,
          data: options.artifact,
          mode: 0o500,
        });
        yield* Effect.logInfo("provider worker artifact upload completed", {
          sandboxId: fence.sandboxId,
        });
        yield* workspaceRuntime.writeFile(input.workspace, {
          path: WORKER_CONFIG_PATH,
          data: JSON.stringify({
            controlUrl: options.controlUrl,
            bootstrapCredential: credential,
            sandboxId: fence.sandboxId,
            workerId: fence.workerId,
            lifecycleGeneration: fence.lifecycleGeneration,
            cwd: input.cwd,
            homeDir: input.homeDir,
          }),
          mode: 0o600,
        });
        yield* Effect.logInfo("provider worker config upload completed", {
          sandboxId: fence.sandboxId,
        });
        const durable = yield* workspaceRuntime.startDurableProcess(input.workspace, {
          command: `node ${WORKER_ARTIFACT_PATH}`,
        });
        durableSessionName = durable.sessionName;
        yield* Effect.logInfo("provider worker process started", {
          sandboxId: fence.sandboxId,
          supervision: durable.supervision,
        });
        yield* broker.waitForConnection(fence);
        yield* Effect.logInfo("provider worker connected", {
          sandboxId: fence.sandboxId,
          workerId: fence.workerId,
        });
        return {
          schemaVersion: 1,
          runtimeKind: "railway-sandbox-pi",
          workspace: input.workspace,
          fence,
          durableSessionName: durable.sessionName,
          processSupervision: durable.supervision,
          cwd: input.cwd,
          homeDir: input.homeDir,
        } satisfies ProviderWorkerRuntimeBinding;
      });

      return yield* launch.pipe(
        Effect.mapError((cause) =>
          provisionError(
            "launch",
            "Failed to launch and connect the Railway provider worker.",
            cause,
            input.workspace.runtimeId,
          ),
        ),
        Effect.onError(() =>
          broker.retire(fence, "worker startup failed").pipe(
            Effect.catch(() => Effect.void),
            Effect.andThen(
              durableSessionName === undefined
                ? Effect.void
                : workspaceRuntime
                    .stopDurableProcess(input.workspace, durableSessionName)
                    .pipe(Effect.catch(() => Effect.void)),
            ),
            Effect.andThen(authority.revoke(fence)),
          ),
        ),
      );
    });

    const start: ProviderWorkerProvisionerShape["start"] = (input) =>
      Effect.gen(function* () {
        const workspace = yield* workspaceRuntime.create({
          lifecycleGeneration: input.lifecycleGeneration,
          environment: { ...(options.environment ?? {}) },
        });
        return yield* provisionConnectedWorker({
          workspace,
          lifecycleGeneration: input.lifecycleGeneration,
          cwd: input.cwd?.trim() || DEFAULT_CWD,
          homeDir: DEFAULT_HOME_DIR,
        }).pipe(
          Effect.onError(() => workspaceRuntime.destroy(workspace).pipe(Effect.catch(() => Effect.void))),
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError
            ? cause
            : provisionError("start", "Failed to create the Railway provider workspace.", cause),
        ),
      );

    const restart: ProviderWorkerProvisionerShape["restart"] = (binding, input) =>
      workspaceRuntime.connect(binding.workspace).pipe(
        Effect.flatMap((workspace) =>
          workspaceRuntime
            .stopDurableProcess(workspace, binding.durableSessionName)
            .pipe(Effect.catch(() => Effect.void))
            .pipe(
              Effect.andThen(authority.revoke(binding.fence)),
              Effect.andThen(broker.retire(binding.fence, "worker generation replaced").pipe(Effect.catch(() => Effect.void))),
              Effect.andThen(
                provisionConnectedWorker({
                  workspace: { ...workspace, lifecycleGeneration: input.lifecycleGeneration },
                  lifecycleGeneration: input.lifecycleGeneration,
                  cwd: input.cwd?.trim() || binding.cwd,
                  homeDir: binding.homeDir,
                }),
              ),
            ),
        ),
        Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError
            ? cause
            : provisionError(
                "restart",
                "Failed to reconnect the Railway provider workspace.",
                cause,
                binding.workspace.runtimeId,
              ),
        ),
      );

    const stop: ProviderWorkerProvisionerShape["stop"] = (binding) =>
      broker.retire(binding.fence, "provider session stopped").pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(
          workspaceRuntime
            .stopDurableProcess(binding.workspace, binding.durableSessionName)
            .pipe(Effect.catch(() => Effect.void)),
        ),
        Effect.andThen(authority.revoke(binding.fence)),
        Effect.andThen(workspaceRuntime.destroy(binding.workspace)),
        Effect.mapError((cause) =>
          provisionError(
            "stop",
            "Failed to destroy the Railway provider workspace.",
            cause,
            binding.workspace.runtimeId,
          ),
        ),
      );

    return { start, restart, stop } satisfies ProviderWorkerProvisionerShape;
  });

export function makeProviderWorkerProvisionerLive(options: ProviderWorkerProvisionerOptions) {
  return Layer.effect(ProviderWorkerProvisioner, makeProviderWorkerProvisioner(options));
}

export function makeProviderWorkerProvisionerFromArtifactLive(
  options: Omit<ProviderWorkerProvisionerOptions, "artifact"> & {
    readonly artifactPath?: string;
  },
) {
  return Layer.effect(
    ProviderWorkerProvisioner,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const candidates = options.artifactPath
        ? [options.artifactPath]
        : [
            new URL("./provider-worker/workerMain.mjs", import.meta.url).pathname,
            new URL("../../../dist/provider-worker/workerMain.mjs", import.meta.url).pathname,
          ];
      let artifactPath: string | undefined;
      for (const candidate of candidates) {
        if (yield* fileSystem.exists(candidate)) {
          artifactPath = candidate;
          break;
        }
      }
      if (artifactPath === undefined) {
        return yield* provisionError(
          "artifact.read",
          "Provider worker artifact is missing; run the server build before enabling Railway distributed Pi.",
          undefined,
        );
      }
      const artifact = yield* fileSystem.readFile(artifactPath).pipe(
        Effect.mapError((cause) =>
          provisionError("artifact.read", "Failed to read the provider worker artifact.", cause),
        ),
      );
      return yield* makeProviderWorkerProvisioner({
        artifact,
        controlUrl: options.controlUrl,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
    }),
  );
}

export const ProviderWorkerProvisionerDisabled = Layer.succeed(ProviderWorkerProvisioner, {
  start: () =>
    Effect.fail(
      provisionError(
        "start",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  restart: () =>
    Effect.fail(
      provisionError(
        "restart",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  stop: () => Effect.void,
} satisfies ProviderWorkerProvisionerShape);
