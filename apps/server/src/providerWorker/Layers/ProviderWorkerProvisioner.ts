import { randomUUID } from "node:crypto";
import type {
  ProjectRepositoryBinding,
  RuntimeStage,
  RuntimeStagePayload,
} from "@synara/contracts";
import { Effect, FileSystem, Layer } from "effect";

import { WorkspaceRuntime } from "../../workspaceRuntime/Services/WorkspaceRuntime";
import { ProviderWorkerProvisioningError } from "../Errors";
import type { ProviderWorkerFence } from "../fence";
import {
  makeGiteaCheckoutPlan,
  makeGiteaCheckoutRefreshPlan,
  parseGiteaCheckoutRefreshResult,
  parseGiteaCheckoutResult,
  type GiteaCheckoutPlan,
  type GiteaCheckoutRepositoryConfig,
} from "../giteaCheckout";
import {
  ProviderWorkerProvisioner,
  type ProviderWorkerRefreshInput,
  type ProviderWorkerProvisionerShape,
} from "../Services/ProviderWorkerProvisioner";
import { ProviderWorkerBootstrapAuthority } from "../Services/ProviderWorkerBootstrapAuthority";
import { ProviderWorkerBroker } from "../Services/ProviderWorkerBroker";
import type { ProviderWorkerRuntimeBinding } from "../runtimeBinding";
import { workerArtifactDigest, workerCheckpointName } from "../workerArtifactBase";
import {
  makeProviderWorkerNodeRuntimeCommand,
  PROVIDER_WORKER_NODE_BINARY_PATH,
} from "../workerNodeRuntime";

const WORKER_ARTIFACT_PATH = "/opt/synara/provider-worker.mjs";
const WORKER_CONFIG_PATH = "/opt/synara/provider-worker.json";
const DEFAULT_CWD = "/workspace";
const DEFAULT_HOME_DIR = "/workspace/.synara-provider-worker";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function workerLaunchCommand(homeDir: string) {
  const logsDir = `${homeDir}/state/logs`;
  const workerLogPath = `${logsDir}/worker.log`;
  return `mkdir -p ${shellQuote(logsDir)} && exec ${shellQuote(PROVIDER_WORKER_NODE_BINARY_PATH)} ${shellQuote(WORKER_ARTIFACT_PATH)} >> ${shellQuote(workerLogPath)} 2>&1`;
}

export interface ProviderWorkerProvisionerOptions {
  readonly artifact: Uint8Array;
  readonly controlUrl: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly giteaCheckout?: GiteaCheckoutRepositoryConfig;
  readonly workerCheckpoint?: "auto" | string;
}

function provisionError(operation: string, detail: string, cause: unknown, sandboxId?: string) {
  return new ProviderWorkerProvisioningError({
    operation,
    detail,
    ...(sandboxId === undefined ? {} : { sandboxId }),
    cause,
  });
}

type ProvisionInput = Parameters<ProviderWorkerProvisionerShape["start"]>[0];
type StageInput = ProvisionInput | ProviderWorkerRefreshInput;

function reportStage(input: StageInput, payload: RuntimeStagePayload) {
  return input.onStage?.(payload) ?? Effect.void;
}

function withStage<A, E, R>(input: {
  readonly provision: StageInput;
  readonly stage: RuntimeStage;
  readonly cold: boolean;
  readonly effect: Effect.Effect<A, E, R>;
  readonly detail?: Readonly<Record<string, unknown>>;
}) {
  return Effect.suspend(() => {
    const startedAt = Date.now();
    const completed = (state: "completed" | "failed") =>
      reportStage(input.provision, {
        stage: input.stage,
        state,
        cold: input.cold,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      });
    return reportStage(input.provision, {
      stage: input.stage,
      state: "started",
      cold: input.cold,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    }).pipe(
      Effect.andThen(input.effect),
      Effect.tap(() => completed("completed")),
      Effect.tapError(() => completed("failed")),
    );
  });
}

export const makeProviderWorkerProvisioner = (options: ProviderWorkerProvisionerOptions) =>
  Effect.gen(function* () {
    const workspaceRuntime = yield* WorkspaceRuntime;
    const broker = yield* ProviderWorkerBroker;
    const authority = yield* ProviderWorkerBootstrapAuthority;
    const checkpointName =
      options.workerCheckpoint === undefined
        ? undefined
        : options.workerCheckpoint === "auto"
          ? workerCheckpointName(workerArtifactDigest(options.artifact))
          : options.workerCheckpoint;

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
      const checkoutResult = yield* Effect.try({
        try: () => parseGiteaCheckoutResult(result.stdout),
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
          commit: checkoutResult.commit,
          checkoutMode: checkoutResult.checkoutMode,
        },
      } as const;
    });

    const provisionConnectedWorker = Effect.fn(function* (input: {
      readonly workspace: ProviderWorkerRuntimeBinding["workspace"];
      readonly provision: ProvisionInput;
      readonly lifecycleGeneration: string;
      readonly cwd: string;
      readonly homeDir: string;
      readonly prepareWorkspace: ReturnType<typeof prepareWorkspace>;
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
        const artifactSource =
          input.workspace.baseSource === "checkpoint" ? "checkpoint" : "upload";
        const workerFiles = withStage({
          provision: input.provision,
          stage: "worker.files",
          cold: true,
          detail: { artifactSource },
          effect: Effect.gen(function* () {
            const runtime = yield* workspaceRuntime.exec(input.workspace, {
              command: makeProviderWorkerNodeRuntimeCommand(),
              timeoutSeconds: 90,
            });
            if (runtime.exitCode !== 0 || runtime.timedOut) {
              return yield* Effect.fail(
                provisionError(
                  "worker.runtime",
                  "Failed to prepare the pinned Node runtime for the provider worker.",
                  new Error(
                    runtime.stderr || runtime.stdout || "Node runtime preparation failed.",
                  ),
                  fence.sandboxId,
                ),
              );
            }
            if (artifactSource === "upload") {
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
            }
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
              artifactSource,
            });
          }),
        });
        const [prepared] = yield* Effect.all([input.prepareWorkspace, workerFiles], {
          concurrency: "unbounded",
        });
        const durable = yield* withStage({
          provision: input.provision,
          stage: "worker.start",
          cold: true,
          effect: workspaceRuntime.startDurableProcess(input.workspace, {
            command: workerLaunchCommand(input.homeDir),
          }),
        });
        durableSessionName = durable.sessionName;
        yield* Effect.logInfo("provider worker process started", {
          sandboxId: fence.sandboxId,
          supervision: durable.supervision,
        });
        yield* withStage({
          provision: input.provision,
          stage: "worker.connect",
          cold: true,
          effect: broker.waitForConnection(fence),
        });
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
          ...(prepared.repositoryCheckout === undefined
            ? {}
            : { repositoryCheckout: prepared.repositoryCheckout }),
        } satisfies ProviderWorkerRuntimeBinding;
      });

      return yield* launch.pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError
            ? cause
            : provisionError(
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
        const workspace = yield* withStage({
          provision: input,
          stage: "sandbox.create",
          cold: true,
          detail: { checkpoint: checkpointName ?? "none" },
          effect: workspaceRuntime.create({
            lifecycleGeneration: input.lifecycleGeneration,
            ...(checkpointName === undefined ? {} : { checkpointName }),
            environment: {
              ...(options.environment ?? {}),
              ...(checkout?.plan.environment ?? {}),
            },
          }),
        });
        return yield* Effect.gen(function* () {
          const cwd = checkout?.plan.cwd ?? (input.cwd?.trim() || DEFAULT_CWD);
          const workspacePreparation =
            checkout === undefined
              ? prepareWorkspace({
                  workspace,
                  provision: input,
                  checkout,
                  fallbackCwd: DEFAULT_CWD,
                })
              : withStage({
                  provision: input,
                  stage: "workspace.checkout",
                  cold: true,
                  effect: prepareWorkspace({
                    workspace,
                    provision: input,
                    checkout,
                    fallbackCwd: DEFAULT_CWD,
                  }),
                });
          return yield* provisionConnectedWorker({
            workspace,
            provision: input,
            lifecycleGeneration: input.lifecycleGeneration,
            cwd,
            homeDir: DEFAULT_HOME_DIR,
            prepareWorkspace: workspacePreparation,
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
        const replacementWorkspace = yield* withStage({
          provision: input,
          stage: "sandbox.create",
          cold: true,
          detail: { checkpoint: checkpointName ?? "none" },
          effect: workspaceRuntime.create({
            lifecycleGeneration: input.lifecycleGeneration,
            ...(checkpointName === undefined ? {} : { checkpointName }),
            environment: {
              ...(options.environment ?? {}),
              ...(checkout?.plan.environment ?? {}),
            },
          }),
        });
        return yield* Effect.gen(function* () {
          const cwd = checkout?.plan.cwd ?? (input.cwd?.trim() || binding.cwd);
          const workspacePreparation =
            checkout === undefined
              ? prepareWorkspace({
                  workspace: replacementWorkspace,
                  provision: input,
                  checkout,
                  fallbackCwd: binding.cwd,
                })
              : withStage({
                  provision: input,
                  stage: "workspace.checkout",
                  cold: true,
                  effect: prepareWorkspace({
                    workspace: replacementWorkspace,
                    provision: input,
                    checkout,
                    fallbackCwd: binding.cwd,
                  }),
                });
          return yield* provisionConnectedWorker({
            workspace: replacementWorkspace,
            provision: input,
            lifecycleGeneration: input.lifecycleGeneration,
            cwd,
            homeDir: binding.homeDir,
            prepareWorkspace: workspacePreparation,
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

    const refresh: ProviderWorkerProvisionerShape["refresh"] = (binding, input) => {
      const repositoryBinding = binding.repositoryCheckout?.binding;
      if (repositoryBinding === undefined) return Effect.succeed(binding);
      if (options.giteaCheckout === undefined) {
        return Effect.fail(
          provisionError(
            "checkout.configure",
            "A Gitea-bound project requires configured sandbox checkout credentials.",
            undefined,
            binding.workspace.runtimeId,
          ),
        );
      }

      const plan = Effect.try({
        try: () =>
          makeGiteaCheckoutRefreshPlan({
            binding: repositoryBinding,
            repository: options.giteaCheckout!,
          }),
        catch: (cause) =>
          provisionError(
            "checkout.validate",
            "The project repository binding is not allowed by the sandbox checkout configuration.",
            cause,
            binding.workspace.runtimeId,
          ),
      });

      return withStage({
        provision: input,
        stage: "workspace.checkout",
        cold: false,
        detail: { path: repositoryBinding.path },
        effect: Effect.gen(function* () {
          const refreshPlan = yield* plan;
          const workspace = yield* workspaceRuntime.connect(binding.workspace).pipe(
            Effect.mapError((cause) =>
              provisionError(
                "checkout.connect",
                "Failed to reconnect the Gitea company workspace before refresh.",
                cause,
                binding.workspace.runtimeId,
              ),
            ),
          );
          const result = yield* workspaceRuntime.exec(workspace, {
            command: refreshPlan.command,
            timeoutSeconds: 120,
          }).pipe(
            Effect.mapError((cause) =>
              provisionError(
                "checkout.refresh",
                "Failed to refresh the Gitea company checkout.",
                cause,
                workspace.runtimeId,
              ),
            ),
          );
          if (result.exitCode !== 0 || result.timedOut) {
            return yield* provisionError(
              "checkout.refresh",
              `Gitea company refresh exited with ${String(result.exitCode)}${result.timedOut ? " after timing out" : ""}.`,
              result.stderr,
              workspace.runtimeId,
            );
          }
          const refreshed = yield* Effect.try({
            try: () => parseGiteaCheckoutRefreshResult(result.stdout),
            catch: (cause) =>
              provisionError(
                "checkout.verify",
                "The Gitea refresh did not report a verified immutable commit.",
                cause,
                workspace.runtimeId,
              ),
          });
          return {
            ...binding,
            workspace,
            cwd: refreshPlan.cwd,
            repositoryCheckout: {
              binding: repositoryBinding,
              commit: refreshed.commit,
              ...(refreshed.outcome === "updated"
                ? { checkoutMode: refreshed.checkoutMode }
                : binding.repositoryCheckout?.checkoutMode === undefined
                  ? {}
                  : { checkoutMode: binding.repositoryCheckout.checkoutMode }),
            },
          } satisfies ProviderWorkerRuntimeBinding;
        }),
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError
            ? cause
            : provisionError(
                "checkout.refresh",
                "Failed to refresh the Gitea company checkout.",
                cause,
                binding.workspace.runtimeId,
              ),
        ),
      );
    };

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

    return { start, restart, refresh, stop } satisfies ProviderWorkerProvisionerShape;
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
        ...(options.workerCheckpoint === undefined
          ? {}
          : { workerCheckpoint: options.workerCheckpoint }),
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
  refresh: () =>
    Effect.fail(
      provisionError(
        "refresh",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  stop: () => Effect.void,
} satisfies ProviderWorkerProvisionerShape);
