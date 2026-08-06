import { randomUUID } from "node:crypto";
import type { ProjectRepositoryBinding } from "@synara/contracts";
import { Effect, FileSystem, Layer } from "effect";

import { WorkspaceRuntime } from "../../workspaceRuntime/Services/WorkspaceRuntime";
import { ProviderWorkerProvisioningError } from "../Errors";
import type { ProviderWorkerFence } from "../fence";
import {
  makeGiteaCheckoutPlan,
  parseGiteaCheckoutCommit,
  type GiteaCheckoutPlan,
  type GiteaCheckoutRepositoryConfig,
} from "../giteaCheckout";
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

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function workerLaunchCommand(homeDir: string) {
  const logsDir = `${homeDir}/state/logs`;
  const workerLogPath = `${logsDir}/worker.log`;
  return `mkdir -p ${shellQuote(logsDir)} && exec node ${shellQuote(WORKER_ARTIFACT_PATH)} >> ${shellQuote(workerLogPath)} 2>&1`;
}

export interface ProviderWorkerProvisionerOptions {
  readonly artifact: Uint8Array;
  readonly controlUrl: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly giteaCheckout?: GiteaCheckoutRepositoryConfig;
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

    const resolveCheckoutPlan = Effect.fn(function* (
      provision: Parameters<ProviderWorkerProvisionerShape["start"]>[0],
    ) {
      if (provision.repositoryBinding === undefined) return undefined;
      if (options.giteaCheckout === undefined) {
        return yield* provisionError(
          "checkout.configure",
          "A Gitea-bound project requires configured sandbox checkout credentials.",
          undefined,
        );
      }
      const plan = yield* Effect.try({
        try: () =>
          makeGiteaCheckoutPlan({
            binding: provision.repositoryBinding!,
            repository: options.giteaCheckout!,
          }),
        catch: (cause) =>
          provisionError(
            "checkout.validate",
            "The project repository binding is not allowed by the sandbox checkout configuration.",
            cause,
          ),
      });
      return { binding: provision.repositoryBinding, plan } as const;
    });

    const prepareWorkspace = Effect.fn(function* (input: {
      readonly workspace: ProviderWorkerRuntimeBinding["workspace"];
      readonly provision: Parameters<ProviderWorkerProvisionerShape["start"]>[0];
      readonly checkout:
        | { readonly binding: ProjectRepositoryBinding; readonly plan: GiteaCheckoutPlan }
        | undefined;
      readonly fallbackCwd: string;
    }) {
      if (input.checkout === undefined) {
        return {
          cwd: input.provision.cwd?.trim() || input.fallbackCwd,
          repositoryCheckout: undefined,
        } as const;
      }
      const result = yield* workspaceRuntime.exec(input.workspace, {
        command: input.checkout.plan.command,
        timeoutSeconds: 120,
      }).pipe(
        Effect.mapError((cause) =>
          provisionError(
            "checkout.exec",
            "Failed to execute the Gitea company checkout.",
            cause,
            input.workspace.runtimeId,
          ),
        ),
      );
      if (result.exitCode !== 0 || result.timedOut) {
        return yield* provisionError(
          "checkout.exec",
          `Gitea company checkout exited with ${String(result.exitCode)}${result.timedOut ? " after timing out" : ""}.`,
          result.stderr,
          input.workspace.runtimeId,
        );
      }
      const commit = yield* Effect.try({
        try: () => parseGiteaCheckoutCommit(result.stdout),
        catch: (cause) =>
          provisionError(
            "checkout.verify",
            "The Gitea checkout did not report an immutable commit.",
            cause,
            input.workspace.runtimeId,
          ),
      });
      return {
        cwd: input.checkout.plan.cwd,
        repositoryCheckout: {
          binding: input.checkout.binding,
          commit,
        },
      } as const;
    });

    const provisionConnectedWorker = Effect.fn(function* (input: {
      readonly workspace: ProviderWorkerRuntimeBinding["workspace"];
      readonly lifecycleGeneration: string;
      readonly cwd: string;
      readonly homeDir: string;
      readonly repositoryCheckout?: ProviderWorkerRuntimeBinding["repositoryCheckout"];
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
          command: workerLaunchCommand(input.homeDir),
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
          ...(input.repositoryCheckout === undefined
            ? {}
            : { repositoryCheckout: input.repositoryCheckout }),
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
        const checkout = yield* resolveCheckoutPlan(input);
        const workspace = yield* workspaceRuntime.create({
          lifecycleGeneration: input.lifecycleGeneration,
          environment: {
            ...(options.environment ?? {}),
            ...(checkout?.plan.environment ?? {}),
          },
        });
        return yield* Effect.gen(function* () {
          const prepared = yield* prepareWorkspace({
            workspace,
            provision: input,
            checkout,
            fallbackCwd: DEFAULT_CWD,
          });
          return yield* provisionConnectedWorker({
            workspace,
            lifecycleGeneration: input.lifecycleGeneration,
            cwd: prepared.cwd,
            homeDir: DEFAULT_HOME_DIR,
            ...(prepared.repositoryCheckout === undefined
              ? {}
              : { repositoryCheckout: prepared.repositoryCheckout }),
          });
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
      Effect.gen(function* () {
        yield* broker
          .retire(binding.fence, "worker generation replaced")
          .pipe(Effect.catch(() => Effect.void));
        yield* authority.revoke(binding.fence);
        const previousWorkspace = yield* workspaceRuntime.connect(binding.workspace).pipe(
          Effect.catch(() =>
            Effect.logWarning("provider worker workspace reconnect failed during replacement", {
              sandboxId: binding.workspace.runtimeId,
            }).pipe(Effect.as(binding.workspace)),
          ),
        );
        yield* workspaceRuntime
          .stopDurableProcess(previousWorkspace, binding.durableSessionName)
          .pipe(Effect.catch(() => Effect.void));
        // Destruction is the authoritative barrier. A durable-session handle can
        // be stale after a control-plane restart, and must not leave an older
        // worker reconnecting alongside the replacement generation.
        yield* workspaceRuntime.destroy(previousWorkspace);
        const checkout = yield* resolveCheckoutPlan(input);
        const replacementWorkspace = yield* workspaceRuntime.create({
          lifecycleGeneration: input.lifecycleGeneration,
          environment: {
            ...(options.environment ?? {}),
            ...(checkout?.plan.environment ?? {}),
          },
        });
        return yield* Effect.gen(function* () {
          const prepared = yield* prepareWorkspace({
            workspace: replacementWorkspace,
            provision: input,
            checkout,
            fallbackCwd: binding.cwd,
          });
          return yield* provisionConnectedWorker({
            workspace: replacementWorkspace,
            lifecycleGeneration: input.lifecycleGeneration,
            cwd: prepared.cwd,
            homeDir: binding.homeDir,
            ...(prepared.repositoryCheckout === undefined
              ? {}
              : { repositoryCheckout: prepared.repositoryCheckout }),
          });
        }).pipe(
          Effect.onError(() =>
            workspaceRuntime.destroy(replacementWorkspace).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      }).pipe(
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
        ...(options.giteaCheckout === undefined ? {} : { giteaCheckout: options.giteaCheckout }),
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
