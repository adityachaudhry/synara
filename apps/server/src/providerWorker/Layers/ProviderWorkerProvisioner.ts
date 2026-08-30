import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, FileSystem, Layer } from "effect";

import { WorkspaceRuntime } from "../../workspaceRuntime/Services/WorkspaceRuntime";
import { makeKeyedLock } from "../../provider/keyedLock";
import { ProviderWorkerProvisioningError } from "../Errors";
import type { ProviderWorkerFence } from "../fence";
import {
  ProviderWorkerProvisioner,
  type ProviderWorkerProvisionerShape,
} from "../Services/ProviderWorkerProvisioner";
import { ProviderWorkerBootstrapAuthority } from "../Services/ProviderWorkerBootstrapAuthority";
import { ProviderWorkerBroker } from "../Services/ProviderWorkerBroker";
import type { ProviderWorkerRuntimeBinding } from "../runtimeBinding";
import {
  makeRepositoryCredentialConfig,
  makeRepositoryCheckoutPlan,
  parseRepositoryCheckoutResult,
  REPOSITORY_CREDENTIAL_CONFIG_PATH,
} from "../repositoryCheckout";

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
  readonly repositoryAuthorization?: string;
  readonly networkIsolation?: "ISOLATED" | "PRIVATE";
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
    const lifecycleLock = makeKeyedLock<string>();
    const activeByThread = new Map<string, ProviderWorkerRuntimeBinding>();
    const retiredGenerations = new Map<string, Set<string>>();

    const markRetired = (threadId: string, lifecycleGeneration: string) => {
      const retired = retiredGenerations.get(threadId) ?? new Set<string>();
      retired.add(lifecycleGeneration);
      retiredGenerations.set(threadId, retired);
    };

    const staleGeneration = (threadId: string, lifecycleGeneration: string) =>
      provisionError(
        "stale-generation",
        `Provider worker generation '${lifecycleGeneration}' for thread '${threadId}' is retired.`,
        undefined,
      );

    const withWorkspaceCleanup = <A, E, R>(
      workspace: ProviderWorkerRuntimeBinding["workspace"],
      use: Effect.Effect<A, E, R>,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const useExit = yield* Effect.exit(restore(use));
          if (Exit.isSuccess(useExit)) return useExit.value;
          const cleanupExit = yield* Effect.exit(workspaceRuntime.destroy(workspace));
          if (Exit.isFailure(cleanupExit)) {
            return yield* provisionError(
              "workspace.cleanup",
              "Failed to destroy the Railway provider workspace after provisioning failed.",
              Cause.squash(cleanupExit.cause),
              workspace.runtimeId,
            );
          }
          return yield* Effect.failCause(useExit.cause);
        }),
      );

    const provisionConnectedWorker = Effect.fn(function* (input: {
      readonly workspace: ProviderWorkerRuntimeBinding["workspace"];
      readonly threadId: string;
      readonly lifecycleGeneration: string;
      readonly cwd: string;
      readonly homeDir: string;
      readonly repositoryBinding?: NonNullable<
        Parameters<ProviderWorkerProvisionerShape["start"]>[0]["repositoryBinding"]
      >;
      readonly checkoutCommand?: string;
      readonly repositoryCredential?: string;
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
        const repositoryCheckout =
          input.repositoryBinding === undefined || input.checkoutCommand === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                if (input.repositoryCredential !== undefined) {
                  yield* workspaceRuntime.writeFile(input.workspace, {
                    path: REPOSITORY_CREDENTIAL_CONFIG_PATH,
                    data: input.repositoryCredential,
                    mode: 0o600,
                  });
                }
                const cleanupCredential =
                  input.repositoryCredential === undefined
                    ? Effect.void
                    : workspaceRuntime
                        .exec(input.workspace, {
                          command: `rm -f '${REPOSITORY_CREDENTIAL_CONFIG_PATH}'`,
                          timeoutSeconds: 10,
                        })
                        .pipe(
                          Effect.flatMap((cleanup) =>
                            cleanup.exitCode === 0 && !cleanup.timedOut
                              ? Effect.void
                              : Effect.fail(
                                  provisionError(
                                    "checkout.cleanup",
                                    "Repository credential erasure could not be confirmed.",
                                    new Error(cleanup.stderr || cleanup.stdout || "cleanup failed"),
                                    input.workspace.runtimeId,
                                  ),
                                ),
                          ),
                        );
                return yield* Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const checkoutExit = yield* Effect.exit(
                      restore(
                        workspaceRuntime.exec(input.workspace, {
                          command: input.checkoutCommand,
                          timeoutSeconds: 120,
                        }),
                      ),
                    );
                    const cleanupExit = yield* Effect.exit(cleanupCredential);
                    if (Exit.isFailure(cleanupExit)) {
                      return yield* Effect.failCause(cleanupExit.cause);
                    }
                    if (Exit.isFailure(checkoutExit)) {
                      return yield* Effect.failCause(checkoutExit.cause);
                    }
                    return checkoutExit.value;
                  }),
                );
              }).pipe(
                  Effect.flatMap((result) =>
                    result.exitCode === 0 && !result.timedOut
                      ? Effect.try({
                          try: () => parseRepositoryCheckoutResult(result.stdout),
                          catch: (cause) =>
                            provisionError(
                              "checkout.verify",
                              "Repository checkout did not report a verified commit.",
                              cause,
                              input.workspace.runtimeId,
                            ),
                        })
                      : Effect.fail(
                          provisionError(
                            "checkout.exec",
                            "Repository checkout failed before worker startup.",
                            new Error(result.stderr || result.stdout || "checkout failed"),
                            input.workspace.runtimeId,
                          ),
                        ),
                  ),
                );
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
          threadId: input.threadId,
          workspace: input.workspace,
          fence,
          durableSessionName: durable.sessionName,
          processSupervision: durable.supervision,
          cwd: input.cwd,
          homeDir: input.homeDir,
          ...(input.repositoryBinding === undefined || repositoryCheckout === undefined
            ? {}
            : {
                repositoryCheckout: {
                  binding: input.repositoryBinding,
                  ...repositoryCheckout,
                },
              }),
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

    const createBinding: ProviderWorkerProvisionerShape["start"] = (input) =>
      Effect.gen(function* () {
        const checkout = input.repositoryBinding
          ? makeRepositoryCheckoutPlan({
              binding: input.repositoryBinding,
              ...(options.repositoryAuthorization
                ? { credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH }
                : {}),
            })
          : undefined;
        const workspace = yield* workspaceRuntime.create({
          lifecycleGeneration: input.lifecycleGeneration,
          environment: {
            ...(options.environment ?? {}),
          },
          networkIsolation: options.networkIsolation ?? "ISOLATED",
        });
        return yield* withWorkspaceCleanup(workspace, provisionConnectedWorker({
          workspace,
          threadId: input.threadId,
          lifecycleGeneration: input.lifecycleGeneration,
          cwd: checkout?.cwd ?? input.cwd?.trim() ?? DEFAULT_CWD,
          homeDir: DEFAULT_HOME_DIR,
          ...(input.repositoryBinding === undefined
            ? {}
            : { repositoryBinding: input.repositoryBinding }),
          ...(checkout === undefined ? {} : { checkoutCommand: checkout.command }),
          ...(input.repositoryBinding === undefined || options.repositoryAuthorization === undefined
            ? {}
            : {
                repositoryCredential: makeRepositoryCredentialConfig(
                  input.repositoryBinding,
                  options.repositoryAuthorization,
                ),
              }),
        }));
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError
            ? cause
            : provisionError("start", "Failed to create the Railway provider workspace.", cause),
        ),
      );

    const replaceBinding: ProviderWorkerProvisionerShape["restart"] = (binding, input) =>
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
        const repositoryBinding = input.repositoryBinding ?? binding.repositoryCheckout?.binding;
        const checkout = repositoryBinding
          ? makeRepositoryCheckoutPlan({
              binding: repositoryBinding,
              ...(options.repositoryAuthorization
                ? { credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH }
                : {}),
            })
          : undefined;
        const replacementWorkspace = yield* workspaceRuntime.create({
          lifecycleGeneration: input.lifecycleGeneration,
          environment: {
            ...(options.environment ?? {}),
          },
          networkIsolation: options.networkIsolation ?? "ISOLATED",
        });
        return yield* withWorkspaceCleanup(replacementWorkspace, provisionConnectedWorker({
          workspace: replacementWorkspace,
          threadId: input.threadId,
          lifecycleGeneration: input.lifecycleGeneration,
          cwd: checkout?.cwd ?? input.cwd?.trim() ?? binding.cwd,
          homeDir: binding.homeDir,
          ...(repositoryBinding === undefined ? {} : { repositoryBinding }),
          ...(checkout === undefined ? {} : { checkoutCommand: checkout.command }),
          ...(repositoryBinding === undefined || options.repositoryAuthorization === undefined
            ? {}
            : {
                repositoryCredential: makeRepositoryCredentialConfig(
                  repositoryBinding,
                  options.repositoryAuthorization,
                ),
              }),
        }));
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

    const stopBinding: ProviderWorkerProvisionerShape["stop"] = (binding) =>
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

    const start: ProviderWorkerProvisionerShape["start"] = (input) =>
      lifecycleLock.withLock(
        input.threadId,
        Effect.gen(function* () {
          if (retiredGenerations.get(input.threadId)?.has(input.lifecycleGeneration)) {
            return yield* staleGeneration(input.threadId, input.lifecycleGeneration);
          }
          const active = activeByThread.get(input.threadId);
          if (active?.fence.lifecycleGeneration === input.lifecycleGeneration) return active;
          if (active) {
            markRetired(input.threadId, active.fence.lifecycleGeneration);
            activeByThread.delete(input.threadId);
            const replacement = yield* replaceBinding(active, input);
            activeByThread.set(input.threadId, replacement);
            return replacement;
          }
          const created = yield* createBinding(input);
          activeByThread.set(input.threadId, created);
          return created;
        }),
      );

    const restart: ProviderWorkerProvisionerShape["restart"] = (binding, input) =>
      lifecycleLock.withLock(
        input.threadId,
        Effect.gen(function* () {
          if (retiredGenerations.get(input.threadId)?.has(input.lifecycleGeneration)) {
            return yield* staleGeneration(input.threadId, input.lifecycleGeneration);
          }
          const active = activeByThread.get(input.threadId);
          if (active?.fence.lifecycleGeneration === input.lifecycleGeneration) return active;
          const previous = active ?? binding;
          if (previous.fence.lifecycleGeneration !== input.lifecycleGeneration) {
            markRetired(input.threadId, previous.fence.lifecycleGeneration);
          }
          activeByThread.delete(input.threadId);
          const replacement = yield* replaceBinding(previous, input);
          activeByThread.set(input.threadId, replacement);
          return replacement;
        }),
      );

    const stop: ProviderWorkerProvisionerShape["stop"] = (binding) => {
      const threadId = binding.threadId;
      if (!threadId) return stopBinding(binding);
      return lifecycleLock.withLock(
        threadId,
        Effect.gen(function* () {
          const active = activeByThread.get(threadId);
          if (active && active.fence.lifecycleGeneration !== binding.fence.lifecycleGeneration) {
            return;
          }
          if (!active && retiredGenerations.get(threadId)?.has(binding.fence.lifecycleGeneration)) {
            return;
          }
          yield* stopBinding(binding);
          activeByThread.delete(threadId);
          markRetired(threadId, binding.fence.lifecycleGeneration);
        }),
      );
    };

    const adopt: ProviderWorkerProvisionerShape["adopt"] = (binding) =>
      workspaceRuntime.adopt(binding.workspace).pipe(
        Effect.mapError((cause) =>
          provisionError(
            "adopt",
            "Failed to commit the durable Railway provider workspace binding.",
            cause,
            binding.workspace.runtimeId,
          ),
        ),
      );

    return { start, restart, adopt, stop } satisfies ProviderWorkerProvisionerShape;
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
        ...(options.repositoryAuthorization === undefined
          ? {}
          : { repositoryAuthorization: options.repositoryAuthorization }),
        ...(options.networkIsolation === undefined
          ? {}
          : { networkIsolation: options.networkIsolation }),
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
  adopt: () => Effect.void,
  stop: () => Effect.void,
} satisfies ProviderWorkerProvisionerShape);
