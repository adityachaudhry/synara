import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Cause, Duration, Effect, Exit, FileSystem, Layer, Schedule } from "effect";

import { WorkspaceRuntime } from "../../workspaceRuntime/Services/WorkspaceRuntime";
import { ServerConfig } from "../../config.ts";
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
import { makeWorkspaceCheckpointStore } from "../workspaceCheckpointStore.ts";
import { publishOutboxArtifacts } from "../artifactPublisher.ts";
import { WORKER_TOOLCHAIN_CHECK_COMMAND, WORKER_TOOLCHAIN_INSTALL_COMMAND } from "../workerToolchain.ts";
import {
  listProviderPersistenceCandidates,
  readProviderPersistenceCandidate,
} from "../persistenceCandidates";
import {
  makeOutboxCheckpointStore,
  listUnpromotedOutboxCandidates,
} from "../outboxCheckpointStore.ts";
import { PROVIDER_PERSISTENCE_OUTBOX_ROOT } from "../../providerPersistence.ts";
import { attachmentRelativePath } from "../../attachmentStore";
import {
  makeRepositoryCredentialConfig,
  makeRepositoryCheckoutPlan,
  makeRepositoryReconcilePlan,
  makeRepositoryRefreshPlan,
  parseRepositoryCheckoutResult,
  parseRepositoryReconcileResult,
  parseRepositoryRefreshResult,
  REPOSITORY_CREDENTIAL_CONFIG_PATH,
} from "../repositoryCheckout";

const WORKER_ARTIFACT_PATH = "/opt/synara/provider-worker.mjs";
const WORKER_ARTIFACT_ARCHIVE_PATH = `${WORKER_ARTIFACT_PATH}.gz`;
const WORKER_CONFIG_PATH = "/opt/synara/provider-worker.json";
const DEFAULT_CWD = "/workspace";
const DEFAULT_HOME_DIR = "/workspace/.synara-provider-worker";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function workerLaunchCommand(homeDir: string, artifactDigest: string) {
  const logsDir = `${homeDir}/state/logs`;
  const workerLogPath = `${logsDir}/worker.log`;
  const extractArtifact = [
    'const fs=require("node:fs")',
    'const zlib=require("node:zlib")',
    `const source=${JSON.stringify(WORKER_ARTIFACT_ARCHIVE_PATH)}`,
    `const target=${JSON.stringify(WORKER_ARTIFACT_PATH)}`,
    "if(fs.existsSync(source))fs.writeFileSync(target,zlib.gunzipSync(fs.readFileSync(source)),{mode:0o500})",
    "fs.rmSync(source,{force:true})",
    `if(require("node:crypto").createHash("sha256").update(fs.readFileSync(target)).digest("hex")!==${JSON.stringify(artifactDigest)})throw Error("Worker artifact digest mismatch")`,
  ].join(";");
  return `mkdir -p ${shellQuote(logsDir)} && node -e ${shellQuote(extractArtifact)} && exec node ${shellQuote(WORKER_ARTIFACT_PATH)} >> ${shellQuote(workerLogPath)} 2>&1`;
}

function agentGatewayUrl(controlUrl: string): string {
  const url = new URL("/mcp", controlUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.toString();
}

export interface ProviderWorkerProvisionerOptions {
  readonly artifact: Uint8Array;
  readonly controlUrl: string;
  readonly checkpointRoot?: string;
  readonly templateCheckpointName?: string;
  readonly repositoryOriginOverride?: { readonly sourceOrigin: string; readonly origin: string };
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
    const fileSystem = yield* FileSystem.FileSystem;
    const broker = yield* ProviderWorkerBroker;
    const authority = yield* ProviderWorkerBootstrapAuthority;
    const lifecycleLock = makeKeyedLock<string>();
    const checkpointLock = makeKeyedLock<string>();
    const checkpointStore = options.checkpointRoot
      ? makeOutboxCheckpointStore(options.checkpointRoot)
      : undefined;
    const workspaceCheckpointStore = options.checkpointRoot && workspaceRuntime.checkpoint
      ? makeWorkspaceCheckpointStore(path.join(options.checkpointRoot, "workspaces"))
      : undefined;
    const artifactArchive = gzipSync(options.artifact, { level: 6 });
    const artifactDigest = createHash("sha256").update(options.artifact).digest("hex");
    const activeByThread = new Map<string, ProviderWorkerRuntimeBinding>();
    const retiredGenerations = new Map<string, Set<string>>();
    const repositoryOrigin = (binding: { readonly origin: string }) =>
      options.repositoryOriginOverride && binding.origin === options.repositoryOriginOverride.sourceOrigin
        ? options.repositoryOriginOverride.origin : binding.origin;
    const isWorkspaceUnavailable: NonNullable<ProviderWorkerProvisionerShape["isWorkspaceUnavailable"]> = (binding) =>
      workspaceRuntime.connect(binding.workspace).pipe(
        Effect.as(false),
        Effect.catch((cause) => Effect.succeed(cause.unavailable === true)),
      );

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

    const readWorkspaceCheckpoint = (threadId: string) => workspaceCheckpointStore
      ? Effect.tryPromise({
          try: () => workspaceCheckpointStore.read(threadId),
          catch: (cause) => provisionError("workspace.checkpoint.read", "Could not read the saved worker disk checkpoint.", cause),
        })
      : Effect.succeed(undefined);

    const checkpointWorkspaceUnlocked = Effect.fn(function* (binding: ProviderWorkerRuntimeBinding) {
      if (!workspaceCheckpointStore || !workspaceRuntime.checkpoint || !binding.threadId) return;
      const active = activeByThread.get(binding.threadId);
      if (active && active.fence.lifecycleGeneration !== binding.fence.lifecycleGeneration) {
        return yield* staleGeneration(binding.threadId, binding.fence.lifecycleGeneration);
      }
      // Bootstrap credentials are consumed before connect; repository credentials are erased after each fetch.
      // A disk snapshot never contains a process or a reusable bootstrap configuration.
      const flush = yield* workspaceRuntime.exec(binding.workspace, {
        command: `test ! -e ${shellQuote(WORKER_CONFIG_PATH)} && test ! -e ${shellQuote(REPOSITORY_CREDENTIAL_CONFIG_PATH)} && sync`,
        timeoutSeconds: 30,
      });
      if (flush.exitCode !== 0 || flush.timedOut) {
        return yield* provisionError("workspace.checkpoint.flush", "Worker disk could not be flushed without transient credentials.", undefined, binding.workspace.runtimeId);
      }
      const previous = yield* readWorkspaceCheckpoint(binding.threadId);
      const checkpoint = yield* workspaceRuntime.checkpoint(binding.workspace,
        `synara-thread-${createHash("sha256").update(binding.threadId).digest("hex").slice(0, 16)}-${randomUUID()}`);
      yield* Effect.tryPromise({
        try: () => workspaceCheckpointStore.write(binding.threadId!, { binding, checkpoint }),
        catch: (cause) => provisionError("workspace.checkpoint.write", "Could not persist the worker disk checkpoint pointer.", cause, binding.workspace.runtimeId),
      });
      if (previous && workspaceRuntime.deleteCheckpoint) {
        yield* workspaceRuntime.deleteCheckpoint(previous.checkpoint.id).pipe(
          Effect.catch((cause) => Effect.logWarning("old provider disk checkpoint cleanup deferred", { checkpointId: previous.checkpoint.id, cause })),
        );
      }
      yield* Effect.logInfo("provider worker disk checkpoint saved", {
        threadId: binding.threadId, sandboxId: binding.workspace.runtimeId,
        checkpointId: checkpoint.id, sourceCommit: binding.repositoryCheckout?.commit,
      });
    });

    const checkpointWorkspace: NonNullable<ProviderWorkerProvisionerShape["checkpointWorkspace"]> = (binding) =>
      (binding.threadId
        ? lifecycleLock.withLock(binding.threadId, checkpointWorkspaceUnlocked(binding))
        : Effect.void).pipe(Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError ? cause : provisionError("workspace.checkpoint", "Could not checkpoint the provider worker disk.", cause, binding.workspace.runtimeId)));

    const storedCandidates = Effect.fn(function* (binding: ProviderWorkerRuntimeBinding) {
      if (!checkpointStore || !binding.threadId) return null;
      const manifest = yield* Effect.tryPromise({
        try: () => checkpointStore.list(binding.threadId!),
        catch: (cause) =>
          provisionError(
            "persistence.checkpoint.read",
            "Failed to read the durable Outbox checkpoint.",
            cause,
            binding.workspace.runtimeId,
          ),
      });
      if (!manifest) return null;
      return {
        runtimeId: binding.workspace.runtimeId,
        lifecycleGeneration: binding.fence.lifecycleGeneration,
        entries: listUnpromotedOutboxCandidates(manifest),
      };
    });

    const checkpointOutboxUnlocked = Effect.fn(function* (binding: ProviderWorkerRuntimeBinding, turnId?: string) {
      const liveExit = yield* Effect.exit(
        listProviderPersistenceCandidates({ workspaceRuntime, binding }),
      );
      if (Exit.isFailure(liveExit)) {
        const stored = yield* storedCandidates(binding);
        if (stored) return stored;
        return yield* Effect.failCause(liveExit.cause);
      }
      const published = yield* Effect.exit(publishOutboxArtifacts({ binding, entries: liveExit.value.entries, broker, ...(turnId ? { turnId } : {}) }));
      if (Exit.isSuccess(published) && published.value !== undefined) {
        return { ...liveExit.value, entries: published.value };
      }
      if (Exit.isFailure(published)) {
        yield* Effect.logWarning("direct artifact upload deferred; preserving Outbox locally", { threadId: binding.threadId });
      }
      if (!checkpointStore || !binding.threadId) return liveExit.value;
      const outbox = yield* Effect.forEach(
        liveExit.value.entries.filter((entry) => entry.source === "outbox"),
        (selection) => readProviderPersistenceCandidate({ workspaceRuntime, binding, selection }),
        { concurrency: 4 },
      );
      const manifest = yield* Effect.tryPromise({
        try: () =>
          checkpointStore.checkpoint({
            threadId: binding.threadId!,
            lifecycleGeneration: binding.fence.lifecycleGeneration,
            files: outbox,
          }),
        catch: (cause) =>
          provisionError(
            "persistence.checkpoint.write",
            "Failed to persist the durable Outbox checkpoint.",
            cause,
            binding.workspace.runtimeId,
          ),
      });
      return {
        runtimeId: binding.workspace.runtimeId,
        lifecycleGeneration: binding.fence.lifecycleGeneration,
        entries: [
          ...listUnpromotedOutboxCandidates(manifest),
          ...liveExit.value.entries.filter((entry) => entry.source === "checkout"),
        ],
      };
    });

    const checkpointOutbox: ProviderWorkerProvisionerShape["checkpointOutbox"] = (binding, turnId) =>
      binding.threadId
        ? checkpointLock.withLock(binding.threadId, checkpointOutboxUnlocked(binding, turnId))
        : checkpointOutboxUnlocked(binding, turnId);

    const restoreOutbox = Effect.fn(function* (binding: ProviderWorkerRuntimeBinding) {
      if (!checkpointStore || !binding.threadId) return;
      const files = yield* Effect.tryPromise({
        try: () => checkpointStore.restore(binding.threadId!),
        catch: (cause) =>
          provisionError(
            "persistence.checkpoint.restore",
            "Failed to read the durable Outbox checkpoint for restoration.",
            cause,
            binding.workspace.runtimeId,
          ),
      });
      yield* Effect.forEach(
        files,
        (file) =>
          workspaceRuntime.writeFile(binding.workspace, {
            path: path.posix.join(PROVIDER_PERSISTENCE_OUTBOX_ROOT, file.path),
            data: file.bytes,
            mode: 0o600,
          }),
        { concurrency: 2, discard: true },
      );
    });

    const markOutboxPromoted: ProviderWorkerProvisionerShape["markOutboxPromoted"] = (
      binding,
      selections,
    ) => {
      if (!checkpointStore || !binding.threadId) return Effect.void;
      return Effect.tryPromise({
        try: () => checkpointStore.markPromoted(binding.threadId!, selections),
        catch: (cause) =>
          provisionError(
            "persistence.checkpoint.promote",
            "Failed to record the promoted Outbox checkpoint files.",
            cause,
            binding.workspace.runtimeId,
          ),
      });
    };

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
      readonly agentGatewayConnection?: NonNullable<
        Parameters<ProviderWorkerProvisionerShape["start"]>[0]["agentGatewayConnection"]
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
        const artifactProbe = yield* workspaceRuntime.exec(input.workspace, {
          command: `test -f ${shellQuote(WORKER_ARTIFACT_PATH)} && printf '%s  %s\\n' ${shellQuote(artifactDigest)} ${shellQuote(WORKER_ARTIFACT_PATH)} | sha256sum --check --status`,
          timeoutSeconds: 15,
        });
        if (artifactProbe.exitCode !== 0 || artifactProbe.timedOut) {
          yield* workspaceRuntime.writeFile(input.workspace, {
            path: WORKER_ARTIFACT_ARCHIVE_PATH,
            data: artifactArchive,
            mode: 0o400,
          });
        }
        yield* Effect.logInfo("provider worker artifact ready", {
          sandboxId: fence.sandboxId,
          sha256: artifactDigest,
          reused: artifactProbe.exitCode === 0 && !artifactProbe.timedOut,
          uploadBytes: artifactProbe.exitCode === 0 && !artifactProbe.timedOut ? 0 : artifactArchive.byteLength,
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
            ...(input.agentGatewayConnection === undefined
              ? {}
              : {
                  agentGatewayUrl: agentGatewayUrl(options.controlUrl),
                  agentGatewayBearerToken: input.agentGatewayConnection.bearerToken,
                }),
          }),
          mode: 0o600,
        });
        yield* Effect.logInfo("provider worker config upload completed", {
          sandboxId: fence.sandboxId,
        });
        const durable = yield* workspaceRuntime.startDurableProcess(input.workspace, {
          command: workerLaunchCommand(input.homeDir, artifactDigest),
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
          runtimeKind:
            input.workspace.runtimeKind === "docker-container" ? "docker-pi" : "railway-sandbox-pi",
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

    const checkedToolchains = new Set<string>();
    const prepareWorkerToolchain = Effect.fn(function* (workspace: ProviderWorkerRuntimeBinding["workspace"]) {
      if (checkedToolchains.has(workspace.runtimeId)) return;
      const probe = yield* workspaceRuntime.exec(workspace, { command: WORKER_TOOLCHAIN_CHECK_COMMAND, timeoutSeconds: 15 });
      if (probe.exitCode === 0 && !probe.timedOut) {
        checkedToolchains.add(workspace.runtimeId);
        return;
      }
      const installed = yield* workspaceRuntime.exec(workspace, { command: WORKER_TOOLCHAIN_INSTALL_COMMAND, timeoutSeconds: 180 });
      const verified = yield* workspaceRuntime.exec(workspace, { command: WORKER_TOOLCHAIN_CHECK_COMMAND, timeoutSeconds: 15 });
      if (installed.exitCode !== 0 || installed.timedOut || verified.exitCode !== 0 || verified.timedOut) {
        return yield* provisionError("workspace.restore.tools", "Could not prepare the worker's document, LFS, and process tools.", undefined, workspace.runtimeId);
      }
      checkedToolchains.add(workspace.runtimeId);
      yield* Effect.logInfo("legacy provider disk toolchain upgraded", { sandboxId: workspace.runtimeId });
    });

    const createBinding: ProviderWorkerProvisionerShape["start"] = (input) =>
      Effect.gen(function* () {
        const stored = yield* readWorkspaceCheckpoint(input.threadId);
        const previousRepository = stored?.binding.repositoryCheckout?.binding;
        const sameRepository = input.repositoryBinding && previousRepository &&
          (["origin", "owner", "repository", "ref", "path"] as const).every((key) => input.repositoryBinding![key] === previousRepository[key]);
        const saved = stored && (sameRepository || (!input.repositoryBinding && !previousRepository)) ? stored : undefined;
        const checkpointName = saved?.checkpoint.key ?? options.templateCheckpointName;
        const checkout = input.repositoryBinding
          ? (saved ? makeRepositoryRefreshPlan : makeRepositoryCheckoutPlan)({
              binding: input.repositoryBinding,
              repositoryOrigin: repositoryOrigin(input.repositoryBinding),
              ...(options.repositoryAuthorization
                ? { credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH }
                : {}),
            })
          : undefined;
        const workspace = yield* workspaceRuntime.create({
          threadId: input.threadId,
          lifecycleGeneration: input.lifecycleGeneration,
          ...(checkpointName ? { checkpointName } : {}),
          environment: {
            ...(options.environment ?? {}),
          },
          networkIsolation: options.networkIsolation ?? "ISOLATED",
          ...(input.onCapacityAdmitted === undefined
            ? {}
            : { onCapacityAdmitted: input.onCapacityAdmitted }),
        });
        return yield* withWorkspaceCleanup(
          workspace,
          (saved ? prepareWorkerToolchain(workspace) : Effect.void).pipe(Effect.andThen(provisionConnectedWorker({
            workspace,
            threadId: input.threadId,
            lifecycleGeneration: input.lifecycleGeneration,
            cwd: checkout?.cwd ?? input.cwd?.trim() ?? DEFAULT_CWD,
            homeDir: saved?.binding.homeDir ?? DEFAULT_HOME_DIR,
            ...(input.repositoryBinding === undefined
              ? {}
              : { repositoryBinding: input.repositoryBinding }),
            ...(input.agentGatewayConnection === undefined
              ? {}
              : { agentGatewayConnection: input.agentGatewayConnection }),
            ...(checkout === undefined ? {} : { checkoutCommand: checkout.command }),
            ...(input.repositoryBinding === undefined ||
            options.repositoryAuthorization === undefined
              ? {}
              : {
                  repositoryCredential: makeRepositoryCredentialConfig(
                    input.repositoryBinding,
                    options.repositoryAuthorization,
                    repositoryOrigin(input.repositoryBinding),
                  ),
                }),
          })), Effect.tap((binding) => saved ? Effect.void : restoreOutbox(binding))),
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError
            ? cause
            : provisionError("start", "Failed to create the Railway provider workspace.", cause),
        ),
      );

    const stopWorkerProcess = (binding: ProviderWorkerRuntimeBinding) => Effect.gen(function* () {
      yield* workspaceRuntime.stopDurableProcess(binding.workspace, binding.durableSessionName)
        .pipe(Effect.catch(() => Effect.void));
      if (!workspaceCheckpointStore) return;
      const stopped = yield* workspaceRuntime.exec(binding.workspace, {
        command: "for i in $(seq 1 100); do if ! pgrep -f '^node /opt/synara/provider-worker.mjs$' >/dev/null; then exit 0; fi; sleep 0.1; done; exit 1",
        timeoutSeconds: 15,
      });
      if (stopped.exitCode !== 0 || stopped.timedOut) {
        return yield* provisionError("workspace.stop", "Worker did not stop before its disk checkpoint.", undefined, binding.workspace.runtimeId);
      }
    });

    const retireWorkspace = (binding: ProviderWorkerRuntimeBinding, reason: string) => Effect.gen(function* () {
      const connection = yield* Effect.exit(workspaceRuntime.connect(binding.workspace));
      if (Exit.isSuccess(connection) && workspaceCheckpointStore && binding.threadId) {
        // Let Pi dispose its native session and child processes before the process/disk barrier.
        yield* broker.request(binding.fence, "session.stop", { threadId: binding.threadId }).pipe(
          Effect.timeout(Duration.seconds(10)),
          Effect.catch(() => Effect.void),
        );
      }
      yield* broker.retire(binding.fence, reason).pipe(Effect.catch(() => Effect.void));
      yield* authority.revoke(binding.fence);
      if (Exit.isSuccess(connection)) {
        yield* stopWorkerProcess(binding);
        yield* checkpointOutbox(binding);
        yield* checkpointWorkspaceUnlocked(binding);
      } else if (workspaceCheckpointStore) {
        const saved = binding.threadId ? yield* readWorkspaceCheckpoint(binding.threadId) : undefined;
        if (!saved) {
          return yield* provisionError("workspace.restore", "The worker is unavailable and has no completed disk checkpoint; refusing to lose its native session.", Cause.squash(connection.cause), binding.workspace.runtimeId);
        }
        yield* Effect.logWarning("restoring last completed provider disk checkpoint", { threadId: binding.threadId, checkpointId: saved.checkpoint.id });
      }
      // Destruction is the authoritative generation barrier, including after a lost control connection.
      yield* workspaceRuntime.destroy(binding.workspace);
      checkedToolchains.delete(binding.workspace.runtimeId);
    });

    const replaceBinding: ProviderWorkerProvisionerShape["restart"] = (binding, input) =>
      Effect.gen(function* () {
        if (binding.threadId && binding.threadId !== input.threadId) {
          return yield* provisionError("workspace.restore", "Cannot restore another thread's writable worker disk.", undefined, binding.workspace.runtimeId);
        }
        yield* retireWorkspace(binding, "worker generation replaced");
        const repositoryBinding = input.repositoryBinding ?? binding.repositoryCheckout?.binding;
        return yield* createBinding({ ...input, ...(repositoryBinding ? { repositoryBinding } : {}) });
      }).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError
        ? cause : provisionError("restart", "Failed to restore the provider worker disk.", cause, binding.workspace.runtimeId)));

    const stopBinding: ProviderWorkerProvisionerShape["stop"] = (binding) =>
      retireWorkspace(binding, "provider session stopped").pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError
        ? cause : provisionError("stop", "Failed to checkpoint and destroy the provider worker.", cause, binding.workspace.runtimeId)));

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
            const replacement = yield* replaceBinding(active, input);
            markRetired(input.threadId, active.fence.lifecycleGeneration);
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
          activeByThread.set(input.threadId, previous);
          const replacement = yield* replaceBinding(previous, input);
          if (previous.fence.lifecycleGeneration !== input.lifecycleGeneration) {
            markRetired(input.threadId, previous.fence.lifecycleGeneration);
          }
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
      workspaceRuntime
        .adopt(binding.workspace)
        .pipe(
          Effect.mapError((cause) =>
            provisionError(
              "adopt",
              "Failed to commit the durable Railway provider workspace binding.",
              cause,
              binding.workspace.runtimeId,
            ),
          ),
        );

    const stageAttachments: NonNullable<ProviderWorkerProvisionerShape["stageAttachments"]> = (
      binding,
      attachments,
    ) =>
      Effect.forEach(
        attachments,
        ({ attachment, sourcePath }) =>
          fileSystem.readFile(sourcePath).pipe(
            Effect.mapError((cause) =>
              provisionError(
                "attachment.read",
                `Failed to read attachment '${attachment.id}' before sandbox staging.`,
                cause,
                binding.workspace.runtimeId,
              ),
            ),
            Effect.flatMap((data) =>
              workspaceRuntime.writeFile(binding.workspace, {
                path: path.posix.join(
                  binding.homeDir,
                  "state",
                  "attachments",
                  attachmentRelativePath(attachment),
                ),
                data,
                mode: 0o600,
              }),
            ),
            Effect.mapError((cause) =>
              cause instanceof ProviderWorkerProvisioningError
                ? cause
                : provisionError(
                    "attachment.write",
                    `Failed to stage attachment '${attachment.id}' in the provider sandbox.`,
                    cause,
                    binding.workspace.runtimeId,
                  ),
            ),
          ),
        { concurrency: 1, discard: true },
      );

    const refreshRepository: NonNullable<ProviderWorkerProvisionerShape["refreshRepository"]> = (binding) =>
      lifecycleLock.withLock(binding.threadId ?? binding.workspace.runtimeId, Effect.gen(function* () {
        const repository = binding.repositoryCheckout?.binding;
        if (!repository) return yield* provisionError("repository.refresh", "Worker has no company source binding.", undefined, binding.workspace.runtimeId);
        const active = binding.threadId ? activeByThread.get(binding.threadId) : undefined;
        if (active && active.fence.lifecycleGeneration !== binding.fence.lifecycleGeneration) {
          return yield* staleGeneration(binding.threadId!, binding.fence.lifecycleGeneration);
        }
        yield* prepareWorkerToolchain(binding.workspace);
        const plan = makeRepositoryRefreshPlan({
          binding: repository,
          repositoryOrigin: repositoryOrigin(repository),
          ...(options.repositoryAuthorization ? { credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH } : {}),
        });
        if (options.repositoryAuthorization) {
          yield* workspaceRuntime.writeFile(binding.workspace, {
            path: REPOSITORY_CREDENTIAL_CONFIG_PATH,
            data: makeRepositoryCredentialConfig(repository, options.repositoryAuthorization, repositoryOrigin(repository)),
            mode: 0o600,
          });
        }
        const result = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
          const refreshed = yield* Effect.exit(restore(workspaceRuntime.exec(binding.workspace, { command: plan.command, timeoutSeconds: 300 })));
          const cleanup = yield* workspaceRuntime.exec(binding.workspace, { command: `rm -f ${shellQuote(REPOSITORY_CREDENTIAL_CONFIG_PATH)}`, timeoutSeconds: 10 });
          if (cleanup.exitCode !== 0 || cleanup.timedOut) return yield* provisionError("repository.refresh.cleanup", "Repository credential erasure could not be confirmed.", undefined, binding.workspace.runtimeId);
          if (Exit.isFailure(refreshed)) return yield* Effect.failCause(refreshed.cause);
          return refreshed.value;
        }));
        if (result.exitCode !== 0 || result.timedOut) return yield* provisionError("repository.refresh", "Company sources could not be refreshed and verified. Conflicting local work is preserved; move edited evidence to a draft before retrying.", new Error(result.stderr || result.stdout || "refresh failed"), binding.workspace.runtimeId);
        const refreshed = yield* Effect.try({
          try: () => parseRepositoryRefreshResult(result.stdout),
          catch: (cause) => provisionError("repository.refresh.verify", "Company refresh did not report its source commit.", cause, binding.workspace.runtimeId),
        });
        const updated = { ...binding, repositoryCheckout: { ...binding.repositoryCheckout!, commit: refreshed.commit } };
        if (binding.threadId) activeByThread.set(binding.threadId, updated);
        yield* Effect.logInfo("provider company sources refreshed", { threadId: binding.threadId, sandboxId: binding.workspace.runtimeId, ...refreshed });
        return { binding: updated, ...refreshed };
      })).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError
        ? cause : provisionError("repository.refresh", "Failed to refresh company sources.", cause, binding.workspace.runtimeId)));

    const reconcileRepository: ProviderWorkerProvisionerShape["reconcileRepository"] = (
      binding,
      commit,
      persistedFiles = [],
    ) =>
      Effect.gen(function* () {
        const repositoryBinding = binding.repositoryCheckout?.binding;
        if (!repositoryBinding || !options.repositoryAuthorization) {
          return yield* provisionError(
            "repository.reconcile",
            "The provider sandbox does not have a repository binding.",
            undefined,
            binding.workspace.runtimeId,
          );
        }
        yield* Effect.forEach(
          persistedFiles,
          (selection) => readProviderPersistenceCandidate({ workspaceRuntime, binding, selection }),
          { concurrency: 1, discard: true },
        );
        const plan = yield* Effect.try({
          try: () =>
            makeRepositoryReconcilePlan({
              binding: repositoryBinding,
              repositoryOrigin: repositoryOrigin(repositoryBinding),
              commit,
              persistedFiles,
              credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH,
            }),
          catch: (cause) =>
            provisionError(
              "repository.reconcile.plan",
              "The requested repository commit is invalid.",
              cause,
              binding.workspace.runtimeId,
            ),
        });
        yield* workspaceRuntime.writeFile(binding.workspace, {
          path: REPOSITORY_CREDENTIAL_CONFIG_PATH,
          data: makeRepositoryCredentialConfig(repositoryBinding, options.repositoryAuthorization, repositoryOrigin(repositoryBinding)),
          mode: 0o600,
        });
        const cleanupCredential = workspaceRuntime
          .exec(binding.workspace, {
            command: `rm -f '${REPOSITORY_CREDENTIAL_CONFIG_PATH}'`,
            timeoutSeconds: 10,
          })
          .pipe(
            Effect.flatMap((cleanup) =>
              cleanup.exitCode === 0 && !cleanup.timedOut
                ? Effect.void
                : Effect.fail(
                    provisionError(
                      "repository.reconcile.cleanup",
                      "Repository credential erasure could not be confirmed.",
                      new Error(cleanup.stderr || cleanup.stdout || "cleanup failed"),
                      binding.workspace.runtimeId,
                    ),
                  ),
            ),
          );
        const result = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const reconcileExit = yield* Effect.exit(
              restore(
                workspaceRuntime.exec(binding.workspace, {
                  command: plan.command,
                  timeoutSeconds: 120,
                }),
              ),
            );
            const cleanupExit = yield* Effect.exit(cleanupCredential);
            if (Exit.isFailure(cleanupExit)) return yield* Effect.failCause(cleanupExit.cause);
            if (Exit.isFailure(reconcileExit)) return yield* Effect.failCause(reconcileExit.cause);
            return reconcileExit.value;
          }),
        );
        if (result.exitCode !== 0 || result.timedOut) {
          return yield* provisionError(
            "repository.reconcile.exec",
            "The sandbox checkout could not fast-forward without overwriting local work.",
            new Error(result.stderr || result.stdout || "reconciliation failed"),
            binding.workspace.runtimeId,
          );
        }
        const reconciled = yield* Effect.try({
          try: () => parseRepositoryReconcileResult(result.stdout),
          catch: (cause) =>
            provisionError(
              "repository.reconcile.verify",
              "The sandbox did not report its reconciled commit.",
              cause,
              binding.workspace.runtimeId,
            ),
        });
        const updated = {
          ...binding,
          repositoryCheckout: {
            ...binding.repositoryCheckout,
            commit: reconciled.commit,
          },
        };
        if (binding.threadId) activeByThread.set(binding.threadId, updated);
        return updated;
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("provider worker repository reconciliation deferred", {
            sandboxId: binding.workspace.runtimeId,
            cause,
          }),
        ),
        Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError
            ? cause
            : provisionError(
                "repository.reconcile",
                "Failed to reconcile the provider sandbox repository.",
                cause,
                binding.workspace.runtimeId,
              ),
        ),
      );

    const listPersistenceCandidates: ProviderWorkerProvisionerShape["listPersistenceCandidates"] =
      checkpointOutbox;

    const readPersistenceCandidate: ProviderWorkerProvisionerShape["readPersistenceCandidate"] = (
      binding,
      selection,
    ) =>
      (checkpointStore && binding.threadId && selection.source === "outbox"
        ? Effect.tryPromise({
            try: () => checkpointStore.read(binding.threadId!, selection),
            catch: (cause) =>
              provisionError(
                "persistence.checkpoint.read",
                "Failed to read the selected durable Outbox file.",
                cause,
                binding.workspace.runtimeId,
              ),
          })
        : readProviderPersistenceCandidate({ workspaceRuntime, binding, selection })
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError
            ? cause
            : provisionError(
                "persistence.read",
                "Failed to read the selected sandbox file.",
                cause,
                binding.workspace.runtimeId,
              ),
        ),
      );

    const readOutboxCheckpoint: ProviderWorkerProvisionerShape["readOutboxCheckpoint"] = (
      threadId,
      candidatePath,
    ) =>
      checkpointStore
        ? Effect.tryPromise({
            try: () => checkpointStore.readPath(threadId, candidatePath),
            catch: (cause) =>
              provisionError(
                "persistence.checkpoint.read",
                "Failed to read the durable Outbox file.",
                cause,
              ),
          })
        : Effect.fail(
            provisionError(
              "persistence.checkpoint.read",
              "Durable Outbox checkpoints are not configured.",
              undefined,
            ),
          );

    if (checkpointStore) {
      yield* Effect.forkScoped(
        Effect.suspend(() =>
          Effect.forEach(
            Array.from(activeByThread.values()),
            (binding) =>
              checkpointOutbox(binding).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("provider Outbox periodic checkpoint deferred", {
                    threadId: binding.threadId,
                    sandboxId: binding.workspace.runtimeId,
                    cause,
                  }),
                ),
              ),
            { concurrency: 2, discard: true },
          ),
        ).pipe(Effect.repeat(Schedule.spaced(Duration.minutes(1)))),
      );
    }

    return {
      isWorkspaceUnavailable,
      start,
      restart,
      adopt,
      stageAttachments,
      checkpointOutbox,
      checkpointWorkspace,
      refreshRepository,
      markOutboxPromoted,
      reconcileRepository,
      listPersistenceCandidates,
      readPersistenceCandidate,
      readOutboxCheckpoint,
      stop,
    } satisfies ProviderWorkerProvisionerShape;
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
      const serverConfig = yield* ServerConfig;
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
      const artifact = yield* fileSystem
        .readFile(artifactPath)
        .pipe(
          Effect.mapError((cause) =>
            provisionError("artifact.read", "Failed to read the provider worker artifact.", cause),
          ),
        );
      return yield* makeProviderWorkerProvisioner({
        artifact,
        controlUrl: options.controlUrl,
        ...(options.templateCheckpointName ? { templateCheckpointName: options.templateCheckpointName } : {}),
        ...(options.repositoryOriginOverride ? { repositoryOriginOverride: options.repositoryOriginOverride } : {}),
        checkpointRoot:
          options.checkpointRoot ?? path.join(serverConfig.baseDir, "provider-outbox-checkpoints"),
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
  stageAttachments: () =>
    Effect.fail(
      provisionError(
        "attachment.write",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  checkpointOutbox: () =>
    Effect.fail(
      provisionError(
        "persistence.checkpoint",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  markOutboxPromoted: () => Effect.void,
  reconcileRepository: () =>
    Effect.fail(
      provisionError(
        "repository.reconcile",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  listPersistenceCandidates: () =>
    Effect.fail(
      provisionError(
        "persistence.list",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  readPersistenceCandidate: () =>
    Effect.fail(
      provisionError(
        "persistence.read",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  readOutboxCheckpoint: () =>
    Effect.fail(
      provisionError(
        "persistence.checkpoint.read",
        "Railway distributed Pi is selected but durable Outbox checkpoints are not configured.",
        undefined,
      ),
    ),
  stop: () => Effect.void,
} satisfies ProviderWorkerProvisionerShape);
