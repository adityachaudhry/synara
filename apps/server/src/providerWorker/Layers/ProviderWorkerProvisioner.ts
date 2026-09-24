import { makeRepositoryIsolationPlan, makeVerifiedRepositoryRefreshPlan } from "../repositoryIsolation";
import { observeProviderOperation } from "../../providerOperationDiagnostics";
import { sanitizeUnmappedProviderData } from "../../provider/unmappedProviderEvents";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Cause, Duration, Effect, Exit, FileSystem, Layer, Schedule, Semaphore } from "effect";

import { WorkspaceRuntime } from "../../workspaceRuntime/Services/WorkspaceRuntime";
import { WorkspaceRuntimeError } from "../../workspaceRuntime/Errors";
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
import { isWorkspaceFilePathAllowed, readProviderWorkspaceFile } from "../workspaceFiles.ts";
import { makeWorkspaceCheckpointStore, workspaceCheckpointRevision, type ProviderWorkspaceCheckpoint } from "../workspaceCheckpointStore.ts";
import { archiveWorkspace, archiveWorkspaceCheckpoint, restoreWorkspaceArchive } from "../workspaceArchive.ts";
import { importRailwayWorkspace } from "../importRailwayWorkspace.ts";
import { publishOutboxArtifacts, artifactApiClient } from "../artifactPublisher.ts";
import { WORKER_TOOLCHAIN_CHECK_COMMAND, WORKER_TOOLCHAIN_INSTALL_COMMAND } from "../workerToolchain.ts";
import { S3_LFS_AGENT_UID, S3_LFS_MOUNT_ROOT, S3_LFS_PASSWORD_PATH, s3LfsCredentialFile, s3LfsMountCommand, s3LfsMountConfig } from "../s3LfsMount.ts";
import {
  listProviderPersistenceCandidates,
  readProviderPersistenceCandidate,
} from "../persistenceCandidates";
import {
  makeOutboxCheckpointStore,
  listUnpromotedOutboxCandidates,
} from "../outboxCheckpointStore.ts";
import { PROVIDER_PERSISTENCE_OUTBOX_ROOT, type ProviderWorkspaceFile } from "../../providerPersistence.ts";
import { attachmentRelativePath } from "../../attachmentStore";
import {
  makeRepositoryCredentialConfig,
  hydrateLfs,
  makeRepositoryCheckoutPlan,
  makeRepositoryReconcilePlan,
  parseRepositoryCheckoutResult,
  parseRepositoryReconcileResult,
  parseRepositoryRefreshResult,
  REPOSITORY_CREDENTIAL_CONFIG_PATH,
} from "../repositoryCheckout";

const WORKER_ARTIFACT_PATH = "/opt/synara/provider-worker.mjs";
const WORKER_ARTIFACT_ARCHIVE_PATH = `${WORKER_ARTIFACT_PATH}.gz`;
const WORKER_PHOTON_WASM_PATH = "/opt/synara/photon_rs_bg.wasm";
const WORKER_CONFIG_PATH = "/opt/synara/provider-worker.json";
const DEFAULT_CWD = "/workspace";
const DEFAULT_HOME_DIR = "/workspace/.synara-provider-worker";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function workerLaunchCommand(homeDir: string, artifactDigest: string, photonDigest?: string) {
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
    ...(photonDigest ? [`if(require("node:crypto").createHash("sha256").update(fs.readFileSync(${JSON.stringify(WORKER_PHOTON_WASM_PATH)})).digest("hex")!==${JSON.stringify(photonDigest)})throw Error("Worker Photon WASM digest mismatch")`] : []),
  ].join(";");
  return `mkdir -p ${shellQuote(logsDir)} && { node -e ${shellQuote(extractArtifact)} && exec node ${shellQuote(WORKER_ARTIFACT_PATH)}; } >> ${shellQuote(workerLogPath)} 2>&1`;
}

function agentGatewayUrl(controlUrl: string): string {
  const url = new URL("/mcp", controlUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.toString();
}

export interface ProviderWorkerProvisionerOptions {
  readonly artifact: Uint8Array;
  readonly photonWasm?: Uint8Array;
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
    const importLock = makeKeyedLock<string>();
    const checkpointLock = makeKeyedLock<string>();
    // Immutable checkpoint files are shared by preview, download and conversion.
    // Bound both bytes and entries; live working copies always bypass this cache.
    const checkpointFiles = new Map<string, ProviderWorkspaceFile>();
    let checkpointFileBytes = 0;
    const checkpointStore = options.checkpointRoot
      ? makeOutboxCheckpointStore(options.checkpointRoot)
      : undefined;
    const nativeDaytona = process.env.SYNARA_WORKSPACE_RUNTIME === "daytona";
    const workspaceCheckpointStore = options.checkpointRoot && (workspaceRuntime.checkpoint || nativeDaytona)
      ? makeWorkspaceCheckpointStore(path.join(options.checkpointRoot, "workspaces"))
      : undefined;
    const archiveEnabled = artifactApiClient() !== undefined;
    if (nativeDaytona && (!workspaceCheckpointStore || !archiveEnabled)) throw new Error("Daytona requires durable workspace pointers and the portable archive API.");
    const maxCachedDisks = Number(process.env.SYNARA_PROVIDER_WORKER_MAX_CHECKPOINTS ?? "64");
    if (!Number.isInteger(maxCachedDisks) || maxCachedDisks < 1 || maxCachedDisks > 64) {
      throw new Error("SYNARA_PROVIDER_WORKER_MAX_CHECKPOINTS must be an integer from 1 through 64.");
    }
    const checkpointPool = makeKeyedLock<string>();
    const captureSlots = yield* Semaphore.make(4);
    const diskReaders = new Map<string, number>();
    const cachedDisks = new Map<string, ProviderWorkspaceCheckpoint>();
    const activeCaptures = new Set<string>();
    let diskIndexLoaded = false;
    const artifactArchive = gzipSync(options.artifact, { level: 6 });
    const artifactDigest = createHash("sha256").update(options.artifact).digest("hex");
    const photonDigest = options.photonWasm && createHash("sha256").update(options.photonWasm).digest("hex");
    const activeByThread = new Map<string, ProviderWorkerRuntimeBinding>();
    const retiredGenerations = new Map<string, Set<string>>();
    const companyRefsEnabled = process.env.SYNARA_COMPANY_WORKSPACE_REFS === "true";
    const s3Lfs = s3LfsMountConfig(process.env);
    const mountS3Lfs = Effect.fn(function* (workspace: ProviderWorkerRuntimeBinding["workspace"]) {
      if (!s3Lfs) return;
      const ready = yield* workspaceRuntime.exec(workspace, {
        command: `mountpoint -q ${shellQuote(S3_LFS_MOUNT_ROOT)}`, timeoutSeconds: 10,
      });
      if (ready.exitCode === 0 && !ready.timedOut) return;
      yield* workspaceRuntime.writeFile(workspace, {
        path: S3_LFS_PASSWORD_PATH, data: s3LfsCredentialFile(s3Lfs), mode: 0o600,
      }).pipe(Effect.mapError((cause) => provisionError("repository.mount.credentials", "Could not prepare the S3 mount credential.", cause, workspace.runtimeId)));
      const mounted = yield* Effect.exit(workspaceRuntime.exec(workspace, {
        command: s3LfsMountCommand(s3Lfs), timeoutSeconds: 45,
      }));
      const cleanup = yield* workspaceRuntime.exec(workspace, {
        command: `rm -f ${shellQuote(S3_LFS_PASSWORD_PATH)} && test ! -e ${shellQuote(S3_LFS_PASSWORD_PATH)}`,
        timeoutSeconds: 10,
      });
      if (cleanup.exitCode !== 0 || cleanup.timedOut)
        return yield* provisionError("repository.mount.cleanup", "S3 mount credential erasure could not be confirmed.", undefined, workspace.runtimeId);
      if (Exit.isFailure(mounted) || mounted.value.exitCode !== 0 || mounted.value.timedOut)
        return yield* provisionError("repository.mount", "Company S3 files could not be mounted.", Exit.isFailure(mounted) ? Cause.squash(mounted.cause) : undefined, workspace.runtimeId);
    });
    const runRepositoryPlan = Effect.fn(function* (workspace: ProviderWorkerRuntimeBinding["workspace"], command: string,
      timeoutSeconds: number, shellTimeout?: number) {
      const script = `/root/.synara-repository-plan-${randomUUID()}.sh`;
      yield* workspaceRuntime.writeFile(workspace, { path: script, data: command, mode: 0o700 });
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const executed = yield* Effect.exit(restore(workspaceRuntime.exec(workspace, {
          command: shellTimeout ? `timeout --kill-after=5s ${shellTimeout}s sh ${shellQuote(script)}` : `sh ${shellQuote(script)}`,
          timeoutSeconds,
        })));
        const cleanup = yield* workspaceRuntime.exec(workspace, {
          command: `rm -f ${shellQuote(script)} && test ! -e ${shellQuote(script)}`, timeoutSeconds: 10,
        });
        if (cleanup.exitCode !== 0 || cleanup.timedOut)
          return yield* provisionError("repository.plan.cleanup", "Repository command cleanup could not be confirmed.", undefined, workspace.runtimeId);
        if (Exit.isFailure(executed)) return yield* Effect.failCause(executed.cause);
        return executed.value;
      }));
    });
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

    const indexDisks = Effect.gen(function* () {
      if (diskIndexLoaded || !workspaceCheckpointStore || !archiveEnabled) return;
      const entries = yield* Effect.tryPromise({ try: () => workspaceCheckpointStore.list(), catch: (cause) => cause });
      for (const entry of entries) {
        if (entry.saved.checkpoint || entry.saved.retiredCheckpoints?.length) cachedDisks.set(entry.threadId, entry.saved);
      }
      diskIndexLoaded = true;
    });
    const saveDiskPointer = (threadId: string, saved: ProviderWorkspaceCheckpoint) => Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => workspaceCheckpointStore!.write(threadId, saved), catch: (cause) => cause });
      cachedDisks.delete(threadId);
      if (saved.checkpoint || saved.retiredCheckpoints?.length) cachedDisks.set(threadId, saved);
    });
    const saveNativeBinding = (binding: ProviderWorkerRuntimeBinding) => Effect.gen(function* () {
      if (binding.workspace.runtimeKind !== "daytona-sandbox" || !binding.threadId) return;
      const previous = yield* readWorkspaceCheckpoint(binding.threadId);
      const sameRepository = JSON.stringify(previous?.binding.repositoryCheckout?.binding ?? previous?.binding.repositoryUnavailable?.binding) ===
        JSON.stringify(binding.repositoryCheckout?.binding ?? binding.repositoryUnavailable?.binding);
      const archive = sameRepository ? previous?.archive : undefined;
      yield* saveDiskPointer(binding.threadId, { binding, nativeRevision: archive?.revision ?? `native-${randomUUID()}`,
        ...(archive ? { archive, archiveBinding: previous!.archiveBinding ?? previous!.binding } : {}) });
    });
    const reconcileCaptures = Effect.gen(function* () {
      if (!workspaceCheckpointStore || !workspaceRuntime.listCheckpoints || !workspaceRuntime.deleteCheckpoint) return;
      const pending = (yield* Effect.tryPromise({ try: () => workspaceCheckpointStore.listCaptures(), catch: (cause) => cause }))
        .filter((capture) => !activeCaptures.has(capture.key));
      if (!pending.length) return;
      const inventory = yield* workspaceRuntime.listCheckpoints();
      let unresolved = 0;
      for (const capture of pending) {
        const saved = yield* readWorkspaceCheckpoint(capture.threadId);
        // A write may have renamed the pointer before its fsync failed. The file is authoritative.
        cachedDisks.delete(capture.threadId);
        if (saved && (saved.checkpoint || saved.retiredCheckpoints?.length)) cachedDisks.set(capture.threadId, saved);
        const referenced = saved?.checkpoint?.key === capture.key || saved?.retiredCheckpoints?.some((old) => old.key === capture.key);
        const disk = inventory.find((checkpoint) => checkpoint.key === capture.key);
        if (!referenced && disk) yield* workspaceRuntime.deleteCheckpoint(disk.id);
        if (!referenced && !disk && Date.now() - capture.createdAt < 600_000) {
          // An interrupted API request may still be capturing. Reserve its slot until it settles.
          unresolved += 1;
          continue;
        }
        yield* Effect.tryPromise({ try: () => workspaceCheckpointStore.finishCapture(capture.key), catch: (cause) => cause });
      }
      if (unresolved >= 4) return yield* provisionError("workspace.checkpoint.pending",
        "Previous checkpoint requests have not settled; retaining the last saved disks.", undefined);
    });
    const cleanRetiredDisks = Effect.gen(function* () {
      if (!workspaceRuntime.deleteCheckpoint) return;
      for (const [threadId, saved] of cachedDisks) {
        const remaining = [...(saved.retiredCheckpoints ?? [])];
        for (const old of saved.retiredCheckpoints ?? []) {
          if (diskReaders.has(old.key)) continue;
          yield* workspaceRuntime.deleteCheckpoint(old.id);
          remaining.splice(remaining.findIndex((item) => item.id === old.id), 1);
        }
        if (remaining.length !== (saved.retiredCheckpoints?.length ?? 0)) {
          yield* saveDiskPointer(threadId, { ...saved, retiredCheckpoints: remaining });
        }
      }
    });
    const trimDiskCache = (limit: number) => Effect.gen(function* () {
      if (!archiveEnabled || !workspaceCheckpointStore || !workspaceRuntime.deleteCheckpoint) return;
      yield* indexDisks;
      yield* cleanRetiredDisks;
      const count = () => new Set(Array.from(cachedDisks.values()).flatMap((saved) =>
        [...(saved.checkpoint ? [saved.checkpoint.id] : []), ...(saved.retiredCheckpoints ?? []).map((item) => item.id)])).size;
      while (count() > limit) {
        const candidate = Array.from(cachedDisks.entries()).find(([, saved]) =>
          saved.checkpoint && !diskReaders.has(saved.checkpoint.key) &&
          /^companies\/[a-z0-9][a-z0-9-]*$/.test((saved.binding.repositoryCheckout?.binding ?? saved.binding.repositoryUnavailable?.binding)?.path ?? ""));
        if (!candidate) return yield* provisionError("workspace.archive.capacity",
          "No saved workspace can be archived safely; retaining all disk snapshots.", undefined);
        const [threadId, saved] = candidate;
        // ponytail: serialize cold archive commits; add parallel eviction only if measured backlog requires it.
        const archive = saved.archive ?? (yield* archiveWorkspaceCheckpoint({
          workspaceRuntime, binding: saved.binding, checkpoint: saved.checkpoint!,
        }));
        // The pointer is durable before deletion. Keeping both locations makes a failed deletion retryable.
        const verified = { ...saved, archive };
        yield* saveDiskPointer(threadId, verified);
        yield* workspaceRuntime.deleteCheckpoint(saved.checkpoint!.id);
        const { checkpoint: _released, ...cold } = verified;
        yield* saveDiskPointer(threadId, cold);
        yield* Effect.logInfo("provider workspace archived", { threadId, revision: archive.revision, bytes: archive.sizeBytes });
      }
    });
    const withSavedDisk = <A, E, R>(threadId: string, use: (saved: ProviderWorkspaceCheckpoint | undefined) => Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        checkpointPool.withLock("pool", Effect.gen(function* () {
          const saved = yield* readWorkspaceCheckpoint(threadId);
          if (saved?.checkpoint && !saved.archive) {
            const key = saved.checkpoint.key;
            diskReaders.set(key, (diskReaders.get(key) ?? 0) + 1);
          }
          return saved;
        })),
        use,
        (saved) => Effect.sync(() => {
          if (!saved?.checkpoint || saved.archive) return;
          const key = saved.checkpoint.key, count = (diskReaders.get(key) ?? 1) - 1;
          if (count) diskReaders.set(key, count); else diskReaders.delete(key);
        }),
      );
    const checkpointWorkspaceUnlocked = (binding: ProviderWorkerRuntimeBinding) => captureSlots.withPermits(1)(Effect.gen(function* () {
      if (!workspaceCheckpointStore || !binding.threadId) return;
      const active = activeByThread.get(binding.threadId);
      if (active && active.fence.lifecycleGeneration !== binding.fence.lifecycleGeneration) {
        return yield* staleGeneration(binding.threadId, binding.fence.lifecycleGeneration);
      }
      const flush = yield* workspaceRuntime.exec(binding.workspace, {
        command: `test ! -e ${shellQuote(WORKER_CONFIG_PATH)} && test ! -e ${shellQuote(REPOSITORY_CREDENTIAL_CONFIG_PATH)} && test ! -e ${shellQuote(S3_LFS_PASSWORD_PATH)} && sync`,
        timeoutSeconds: 30,
      });
      if (flush.exitCode !== 0 || flush.timedOut) {
        return yield* provisionError("workspace.checkpoint.flush", "Worker disk could not be flushed without transient credentials.", undefined, binding.workspace.runtimeId);
      }
      const captureKey = `synara-thread-${createHash("sha256").update(binding.threadId).digest("hex").slice(0, 16)}-${randomUUID()}`;
      if (binding.workspace.runtimeKind === "daytona-sandbox") {
        const archive = yield* archiveWorkspace({ workspaceRuntime, binding, revision: captureKey }).pipe(
          observeProviderOperation("workspace.backup", { threadId: binding.threadId, sandboxId: binding.workspace.runtimeId }),
        );
        yield* saveDiskPointer(binding.threadId, { binding, nativeRevision: captureKey, archive });
        yield* Effect.logInfo("provider native workspace backed up", {
          threadId: binding.threadId, sandboxId: binding.workspace.runtimeId, revision: captureKey, bytes: archive.sizeBytes,
        });
        return;
      }
      if (!workspaceRuntime.checkpoint) return;
      yield* checkpointPool.withLock("pool", Effect.gen(function* () {
        yield* indexDisks;
        yield* reconcileCaptures;
        yield* trimDiskCache(maxCachedDisks);
        yield* Effect.tryPromise({ try: () => workspaceCheckpointStore.beginCapture(binding.threadId!, binding, captureKey), catch: (cause) => cause });
        activeCaptures.add(captureKey);
      }));
      yield* Effect.gen(function* () {
      const checkpoint = yield* workspaceRuntime.checkpoint!(binding.workspace, captureKey);
      yield* checkpointPool.withLock("pool", Effect.gen(function* () {
        const previous = yield* readWorkspaceCheckpoint(binding.threadId!);
        const retiredCheckpoints = [...(previous?.retiredCheckpoints ?? []), ...(previous?.checkpoint ? [previous.checkpoint] : [])];
        yield* saveDiskPointer(binding.threadId!, { binding, checkpoint, retiredCheckpoints });
        yield* Effect.tryPromise({ try: () => workspaceCheckpointStore.finishCapture(captureKey), catch: (cause) => cause });
        yield* cleanRetiredDisks;
        yield* trimDiskCache(maxCachedDisks);
      }));
      yield* Effect.logInfo("provider worker disk checkpoint saved", {
        threadId: binding.threadId, sandboxId: binding.workspace.runtimeId,
        checkpointId: checkpoint.id, sourceCommit: binding.repositoryCheckout?.commit,
      });
      }).pipe(Effect.ensuring(Effect.sync(() => activeCaptures.delete(captureKey))));
    }));

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
      if (s3Lfs && binding.cwd.startsWith("/workspace/repository/companies/")) {
        const ownership = yield* workspaceRuntime.exec(binding.workspace, {
          command: `chown -R ${S3_LFS_AGENT_UID}:${S3_LFS_AGENT_UID} ${shellQuote(PROVIDER_PERSISTENCE_OUTBOX_ROOT)}`,
          timeoutSeconds: 30,
        });
        if (ownership.exitCode !== 0 || ownership.timedOut)
          return yield* provisionError("persistence.checkpoint.owner", "Restored Outbox files are not readable to the company worker.", undefined, binding.workspace.runtimeId);
      }
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
              "Failed to destroy the provider workspace after provisioning failed.",
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
      readonly allowUnavailable?: boolean;
      readonly previousCheckout?: ProviderWorkerRuntimeBinding["repositoryCheckout"];
      readonly repositoryCredential?: string;
      readonly unprivileged?: boolean;
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
        let repositoryUnavailable = false;
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
                        runRepositoryPlan(input.workspace, input.checkoutCommand!, input.allowUnavailable ? 45 : 120,
                          input.allowUnavailable ? 30 : undefined),
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
                Effect.tap((result) => {
                  if (result.exitCode === 0 && !result.timedOut) return Effect.void;
                  const missingObject = result.stderr.match(
                    /(?:bad (?:(?:tree|commit|blob) )?object|Could not read) ([a-f0-9]{40,64})\b/,
                  )?.[1];
                  return Effect.logError("provider repository checkout failed", {
                    ...fence,
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                    failureKind: missingObject ? "repository_integrity" :
                      result.timedOut ? "timeout" : "git_checkout",
                    ...(missingObject ? { missingObject } : {}),
                  });
                }),
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
                observeProviderOperation("repository.checkout", { ...fence }),
                Effect.catch((cause) => {
                  // Credential cleanup failures remain fatal. Do not expose secrets to a live agent.
                  if (!input.allowUnavailable || !(cause instanceof ProviderWorkerProvisioningError) ||
                      !["checkout.exec", "checkout.verify"].includes(cause.operation)) return Effect.fail(cause);
                  repositoryUnavailable = true;
                  return Effect.logWarning("company files unavailable; starting conversation without tools", { ...fence, operation: cause.operation }).pipe(
                    Effect.andThen(workspaceRuntime.exec(input.workspace, { command: `mkdir -p ${shellQuote(input.cwd)}`, timeoutSeconds: 10 })),
                    Effect.flatMap((result) => result.exitCode === 0 && !result.timedOut
                      ? Effect.succeed(input.previousCheckout)
                      : Effect.fail(provisionError("workspace.directory", "Could not prepare the chat workspace.", undefined, fence.sandboxId))),
                  );
                }),
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
        if (options.photonWasm && photonDigest) {
          const photonProbe = yield* workspaceRuntime.exec(input.workspace, {
            command: `test -f ${shellQuote(WORKER_PHOTON_WASM_PATH)} && printf '%s  %s\\n' ${shellQuote(photonDigest)} ${shellQuote(WORKER_PHOTON_WASM_PATH)} | sha256sum --check --status`,
            timeoutSeconds: 15,
          });
          if (photonProbe.exitCode !== 0 || photonProbe.timedOut) {
            yield* workspaceRuntime.writeFile(input.workspace, {
              path: WORKER_PHOTON_WASM_PATH,
              data: options.photonWasm,
              mode: 0o444,
            });
          }
        }
        yield* Effect.logInfo("provider worker artifact ready", {
          sandboxId: fence.sandboxId,
          sha256: artifactDigest,
          reused: artifactProbe.exitCode === 0 && !artifactProbe.timedOut,
          uploadBytes: artifactProbe.exitCode === 0 && !artifactProbe.timedOut ? 0 : artifactArchive.byteLength,
        });
        if (input.unprivileged) {
          const prepared = yield* workspaceRuntime.exec(input.workspace, {
            command: `mkdir -p ${shellQuote(input.homeDir)} ${shellQuote(PROVIDER_PERSISTENCE_OUTBOX_ROOT)} /workspace/.pi/agent/sessions && if [ -d /root/.pi/agent/sessions ]; then cp -an /root/.pi/agent/sessions/. /workspace/.pi/agent/sessions/; fi && chown ${S3_LFS_AGENT_UID}:${S3_LFS_AGENT_UID} /workspace /workspace/.synara && chown -R ${S3_LFS_AGENT_UID}:${S3_LFS_AGENT_UID} ${shellQuote(input.homeDir)} ${shellQuote(PROVIDER_PERSISTENCE_OUTBOX_ROOT)} /workspace/.pi`,
            timeoutSeconds: 60,
          });
          if (prepared.exitCode !== 0 || prepared.timedOut)
            return yield* provisionError("workspace.user", "Could not prepare the unprivileged company worker.", undefined, fence.sandboxId);
          yield* workspaceRuntime.writeFile(input.workspace, {
            path: "/opt/synara/agent-gitconfig",
            data: "[safe]\n\tdirectory = /workspace/repository\n[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n",
            mode: 0o644,
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
            ...(input.unprivileged ? { runAsUid: String(S3_LFS_AGENT_UID) } : {}),
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
          command: workerLaunchCommand(input.homeDir, artifactDigest, photonDigest),
        });
        durableSessionName = durable.sessionName;
        yield* Effect.logInfo("provider worker process started", {
          sandboxId: fence.sandboxId,
          supervision: durable.supervision,
        });
        yield* broker.waitForConnection(fence).pipe(
          Effect.onError(() => workspaceRuntime.exec(input.workspace, {
            command: `tail -c 12000 ${shellQuote(`${input.homeDir}/state/logs/worker.log`)} 2>/dev/null`,
            timeoutSeconds: 3,
          }).pipe(
            Effect.timeout(Duration.seconds(5)),
            Effect.flatMap((result) => Effect.logWarning(JSON.stringify({
              event: "provider.worker.startup-diagnostics",
              threadId: input.threadId,
              sandboxId: fence.sandboxId,
              workerId: fence.workerId,
              lifecycleGeneration: fence.lifecycleGeneration,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              log: sanitizeUnmappedProviderData(result.stdout
                .replaceAll(credential, "[REDACTED]")
                .replaceAll(input.agentGatewayConnection?.bearerToken || credential, "[REDACTED]")),
            }))),
            Effect.catch(() => Effect.logWarning(JSON.stringify({
              event: "provider.worker.startup-diagnostics-unavailable",
              threadId: input.threadId,
              sandboxId: fence.sandboxId,
            }))),
          )),
        );
        yield* Effect.logInfo("provider worker connected", {
          sandboxId: fence.sandboxId,
          workerId: fence.workerId,
        });
        return {
          schemaVersion: 1,
          runtimeKind: input.workspace.runtimeKind === "docker-container" ? "docker-pi"
            : input.workspace.runtimeKind === "daytona-sandbox" ? "daytona-pi" : "railway-sandbox-pi",
          threadId: input.threadId,
          workspace: input.workspace,
          fence,
          durableSessionName: durable.sessionName,
          processSupervision: durable.supervision,
          cwd: input.cwd,
          homeDir: input.homeDir,
          ...(repositoryUnavailable && input.repositoryBinding ? {
            repositoryUnavailable: { binding: input.repositoryBinding, lastAttemptAt: new Date().toISOString() },
          } : {}),
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
            "Failed to launch and connect the provider worker.",
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
      withSavedDisk(input.threadId, (stored) => Effect.gen(function* () {
        const previousRepository = stored?.binding.repositoryCheckout?.binding ?? stored?.binding.repositoryUnavailable?.binding;
        const sameRepository = input.repositoryBinding && previousRepository &&
          (["origin", "owner", "repository", "ref", "path"] as const).every((key) => input.repositoryBinding![key] === previousRepository[key]);
        let saved = stored && (sameRepository || (!input.repositoryBinding && !previousRepository)) ? stored : undefined;
        if (process.env.SYNARA_WORKSPACE_RUNTIME === "daytona" &&
            saved?.binding.workspace.runtimeKind === "railway-sandbox" && !saved.archive) {
          const archive = yield* importLock.withLock("railway", importRailwayWorkspace(saved)).pipe(
            observeProviderOperation("workspace.import", { threadId: input.threadId }),
          );
          yield* Effect.tryPromise({ try: () => workspaceCheckpointStore!.writeImportedArchive(saved!.checkpoint!.key, archive), catch: (cause) => cause });
          saved = { ...saved, archive };
        }
        if (nativeDaytona && saved?.nativeRevision) return yield* replaceBinding(saved.binding, input);
        const checkpointName = (saved?.archive ? undefined : saved?.checkpoint?.key) ?? options.templateCheckpointName;
        const companyOnly = (companyRefsEnabled && input.repositoryBinding?.ref === "main" && /^companies\/[a-z0-9][a-z0-9-]*$/.test(input.repositoryBinding?.path ?? "")) || saved?.binding.repositoryCheckout?.checkoutMode === "company";
        const mountedCompany = !!s3Lfs && companyOnly;
        const migrate = companyOnly && saved && (saved.binding.repositoryUnavailable || saved.binding.repositoryCheckout?.checkoutMode !== "company");
        const checkout = input.repositoryBinding
          ? (migrate ? makeRepositoryIsolationPlan : saved ? makeVerifiedRepositoryRefreshPlan : makeRepositoryCheckoutPlan)({
              companyOnly,
              allowEmpty: saved?.binding.repositoryCheckout === undefined,
              verifiedCommit: saved?.binding.repositoryCheckout?.commit,
              binding: input.repositoryBinding,
              repositoryOrigin: repositoryOrigin(input.repositoryBinding),
              ...(mountedCompany ? { mountRoot: S3_LFS_MOUNT_ROOT } : {}),
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
        }).pipe(observeProviderOperation("workspace.create", {
          threadId: input.threadId, lifecycleGeneration: input.lifecycleGeneration,
        }));
        return yield* withWorkspaceCleanup(
          workspace,
          (saved?.archive ? restoreWorkspaceArchive({ workspaceRuntime, workspace, binding: saved.binding, archive: saved.archive }) : Effect.void).pipe(
            Effect.andThen(saved ? prepareWorkerToolchain(workspace) : Effect.void),
            Effect.andThen(mountedCompany ? mountS3Lfs(workspace) : Effect.void),
            Effect.andThen(provisionConnectedWorker({
            workspace,
            threadId: input.threadId,
            lifecycleGeneration: input.lifecycleGeneration,
            cwd: checkout?.cwd ?? input.cwd?.trim() ?? DEFAULT_CWD,
            homeDir: saved?.binding.homeDir ?? DEFAULT_HOME_DIR,
            allowUnavailable: companyOnly,
            unprivileged: mountedCompany,
            ...(saved?.binding.repositoryCheckout ? { previousCheckout: saved.binding.repositoryCheckout } : {}),
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
      })).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderWorkerProvisioningError
            ? cause
            : provisionError("start", "Failed to create the provider workspace.", cause),
        ),
      );

    const stopWorkerProcess = (binding: ProviderWorkerRuntimeBinding) => Effect.gen(function* () {
      yield* workspaceRuntime.stopDurableProcess(binding.workspace, binding.durableSessionName)
        .pipe(Effect.catch(() => Effect.void));
      if (binding.workspace.runtimeKind === "daytona-sandbox") {
        const fenced = yield* workspaceRuntime.exec(binding.workspace, {
          command: `pkill -KILL -u ${S3_LFS_AGENT_UID} 2>/dev/null || true; for i in $(seq 1 100); do if ! pgrep -u ${S3_LFS_AGENT_UID} >/dev/null; then exit 0; fi; sleep 0.05; done; exit 1`,
          timeoutSeconds: 10,
        });
        if (fenced.exitCode !== 0 || fenced.timedOut) return yield* provisionError("workspace.stop", "Previous worker processes could not be fenced.", undefined, binding.workspace.runtimeId);
      }
      if (!workspaceCheckpointStore) return;
      const stopped = yield* workspaceRuntime.exec(binding.workspace, {
        command: "for i in $(seq 1 100); do if ! pgrep -f '^node /opt/synara/provider-worker.mjs$' >/dev/null; then exit 0; fi; sleep 0.1; done; exit 1",
        timeoutSeconds: 15,
      });
      if (stopped.exitCode !== 0 || stopped.timedOut) {
        return yield* provisionError("workspace.stop", "Worker did not stop before its disk checkpoint.", undefined, binding.workspace.runtimeId);
      }
    });

    const retireWorkspace = (binding: ProviderWorkerRuntimeBinding, reason: string, mode: "destroy" | "park" | "reuse" = "destroy") => Effect.gen(function* () {
      let connection = yield* Effect.exit(workspaceRuntime.connect(binding.workspace));
      if (Exit.isFailure(connection) && binding.workspace.runtimeKind === "daytona-sandbox") {
        const unavailable = Cause.squash(connection.cause);
        if (!(unavailable instanceof WorkspaceRuntimeError) || !unavailable.unavailable) return yield* Effect.failCause(connection.cause);
        if (mode === "destroy" && unavailable.status === "stopped" && workspaceRuntime.resume) {
          const workspace = yield* workspaceRuntime.resume(binding.workspace, {
            ...(binding.threadId ? { threadId: binding.threadId } : {}), lifecycleGeneration: binding.fence.lifecycleGeneration, maintenance: true,
          });
          binding = { ...binding, workspace };
          connection = yield* Effect.exit(workspaceRuntime.connect(workspace));
          if (Exit.isFailure(connection)) return yield* Effect.failCause(connection.cause);
        }
      }
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
      } else if (workspaceCheckpointStore && mode === "destroy") {
        const saved = binding.threadId ? yield* readWorkspaceCheckpoint(binding.threadId) : undefined;
        if (!saved || (!saved.checkpoint && !saved.archive)) {
          return yield* provisionError("workspace.restore", "The worker is unavailable and has no completed disk checkpoint; refusing to lose its native session.", Cause.squash(connection.cause), binding.workspace.runtimeId);
        }
        yield* Effect.logWarning("restoring last completed provider disk checkpoint", { threadId: binding.threadId, revision: workspaceCheckpointRevision(saved) });
      }
      if (mode === "destroy") yield* workspaceRuntime.destroy(binding.workspace);
      else if (workspaceRuntime.park && (mode === "park" || Exit.isFailure(connection))) yield* workspaceRuntime.park(binding.workspace);
      checkedToolchains.delete(binding.workspace.runtimeId);
    });

    const replaceBinding: ProviderWorkerProvisionerShape["restart"] = (binding, input) =>
      Effect.gen(function* () {
        if (binding.threadId && binding.threadId !== input.threadId) {
          return yield* provisionError("workspace.restore", "Cannot restore another thread's writable worker disk.", undefined, binding.workspace.runtimeId);
        }
        const repositoryBinding = input.repositoryBinding ?? binding.repositoryCheckout?.binding ?? binding.repositoryUnavailable?.binding;
        const previousRepository = binding.repositoryCheckout?.binding ?? binding.repositoryUnavailable?.binding;
        const reuse = binding.workspace.runtimeKind === "daytona-sandbox" && workspaceRuntime.park && workspaceRuntime.resume &&
          repositoryBinding && previousRepository &&
          (["origin", "owner", "repository", "ref", "path"] as const).every((key) => repositoryBinding[key] === previousRepository[key]);
        if (reuse && repositoryBinding && workspaceRuntime.resume) {
          const inventory = yield* workspaceRuntime.list;
          const existing = inventory.find((item) => item.runtimeId === binding.workspace.runtimeId);
          if (existing && existing.status !== "running" && existing.status !== "stopped") return yield* provisionError("workspace.resume", `Native workspace is ${existing.status}; its disk is retained for recovery.`, undefined, binding.workspace.runtimeId);
          if (existing) {
            yield* retireWorkspace(binding, "worker generation replaced", "reuse");
            const workspace = yield* workspaceRuntime.resume(binding.workspace, {
              threadId: input.threadId,
              lifecycleGeneration: input.lifecycleGeneration,
              ...(input.onCapacityAdmitted ? { onCapacityAdmitted: input.onCapacityAdmitted } : {}),
            });
            const companyOnly = binding.repositoryCheckout?.checkoutMode === "company" ||
              (companyRefsEnabled && repositoryBinding.ref === "main" && /^companies\/[a-z0-9][a-z0-9-]*$/.test(repositoryBinding.path));
            const mountedCompany = !!s3Lfs && companyOnly;
            const checkout = (binding.repositoryCheckout ? makeVerifiedRepositoryRefreshPlan : makeRepositoryIsolationPlan)({
              binding: repositoryBinding,
              repositoryOrigin: repositoryOrigin(repositoryBinding),
              verifiedCommit: binding.repositoryCheckout?.commit,
              allowEmpty: binding.repositoryCheckout === undefined,
              companyOnly,
              ...(mountedCompany ? { mountRoot: S3_LFS_MOUNT_ROOT } : {}),
              ...(options.repositoryAuthorization ? { credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH } : {}),
            });
            return yield* prepareWorkerToolchain(workspace).pipe(
              Effect.andThen(mountedCompany ? mountS3Lfs(workspace) : Effect.void),
              Effect.andThen(provisionConnectedWorker({
                workspace,
                threadId: input.threadId,
                lifecycleGeneration: input.lifecycleGeneration,
                cwd: checkout.cwd,
                homeDir: binding.homeDir,
                repositoryBinding,
                checkoutCommand: checkout.command,
                ...(binding.repositoryCheckout ? { previousCheckout: binding.repositoryCheckout } : {}),
                allowUnavailable: companyOnly,
                unprivileged: mountedCompany,
                ...(input.agentGatewayConnection ? { agentGatewayConnection: input.agentGatewayConnection } : {}),
                ...(options.repositoryAuthorization ? { repositoryCredential: makeRepositoryCredentialConfig(
                  repositoryBinding, options.repositoryAuthorization, repositoryOrigin(repositoryBinding),
                ) } : {}),
              })),
              Effect.tap(saveNativeBinding),
              Effect.onError(() => workspaceRuntime.park!(workspace).pipe(
                Effect.catch((cause) => Effect.logError("failed to park reused Daytona workspace", {
                  sandboxId: workspace.runtimeId, cause,
                })),
              )),
            );
          }
        }
        if (binding.workspace.runtimeKind === "daytona-sandbox" && binding.threadId) {
          const saved = yield* readWorkspaceCheckpoint(binding.threadId);
          if (saved?.nativeRevision) {
            if (!saved.archive) return yield* provisionError("workspace.restore", "Native workspace is unavailable and has no portable backup.", undefined, binding.workspace.runtimeId);
            yield* saveDiskPointer(binding.threadId, { binding: saved.archiveBinding ?? saved.binding, archive: saved.archive });
          }
        }
        yield* retireWorkspace(binding, "worker generation replaced");
        return yield* createBinding({ ...input, ...(repositoryBinding ? { repositoryBinding } : {}) });
      }).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError
        ? cause : provisionError("restart", "Failed to restore the provider worker disk.", cause, binding.workspace.runtimeId)));

    const park: NonNullable<ProviderWorkerProvisionerShape["park"]> = (binding) => {
      if (binding.workspace.runtimeKind !== "daytona-sandbox" || !workspaceRuntime.park) return stop(binding);
      return lifecycleLock.withLock(binding.threadId ?? binding.workspace.runtimeId, Effect.gen(function* () {
        if (binding.threadId) {
          const active = activeByThread.get(binding.threadId);
          if (active && active.fence.lifecycleGeneration !== binding.fence.lifecycleGeneration) return;
          if (!active && retiredGenerations.get(binding.threadId)?.has(binding.fence.lifecycleGeneration)) return;
        }
        yield* retireWorkspace(binding, "provider session parked", "park");
        if (binding.threadId) {
          activeByThread.delete(binding.threadId);
          markRetired(binding.threadId, binding.fence.lifecycleGeneration);
        }
      })).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError
        ? cause : provisionError("park", "Failed to park the provider worker.", cause, binding.workspace.runtimeId)));
    };

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
            const saved = yield* readWorkspaceCheckpoint(threadId);
            if (!saved?.nativeRevision || saved.binding.workspace.runtimeId !== binding.workspace.runtimeId ||
                saved.binding.fence.lifecycleGeneration !== binding.fence.lifecycleGeneration) return;
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
          Effect.andThen(saveNativeBinding(binding)),
          Effect.mapError((cause) =>
            provisionError(
              "adopt",
              "Failed to commit the durable provider workspace binding.",
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
            Effect.flatMap(() => s3Lfs && binding.cwd.startsWith("/workspace/repository/companies/")
              ? workspaceRuntime.exec(binding.workspace, {
                  command: `chown ${S3_LFS_AGENT_UID}:${S3_LFS_AGENT_UID} ${shellQuote(path.posix.join(binding.homeDir, "state", "attachments", attachmentRelativePath(attachment)))}`,
                  timeoutSeconds: 10,
                }).pipe(Effect.flatMap((result) => result.exitCode === 0 && !result.timedOut
                  ? Effect.void : Effect.fail(provisionError("attachment.owner", "Could not make the attachment readable to the company worker.", undefined, binding.workspace.runtimeId))))
              : Effect.void),
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
        const repository = binding.repositoryCheckout?.binding ?? binding.repositoryUnavailable?.binding;
        if (!repository) return yield* provisionError("repository.refresh", "Worker has no company source binding.", undefined, binding.workspace.runtimeId);
        const active = binding.threadId ? activeByThread.get(binding.threadId) : undefined;
        if (active && active.fence.lifecycleGeneration !== binding.fence.lifecycleGeneration) {
          return yield* staleGeneration(binding.threadId!, binding.fence.lifecycleGeneration);
        }
        yield* prepareWorkerToolchain(binding.workspace);
        const companyOnly = (companyRefsEnabled && repository.ref === "main" && /^companies\/[a-z0-9][a-z0-9-]*$/.test(repository.path)) || binding.repositoryCheckout?.checkoutMode === "company";
        if (s3Lfs && companyOnly) yield* mountS3Lfs(binding.workspace);
        const plan = (companyOnly && (binding.repositoryUnavailable || binding.repositoryCheckout?.checkoutMode !== "company")
          ? makeRepositoryIsolationPlan : makeVerifiedRepositoryRefreshPlan)({
          companyOnly,
          allowEmpty: binding.repositoryCheckout === undefined,
          verifiedCommit: binding.repositoryCheckout?.commit,
          binding: repository,
          repositoryOrigin: repositoryOrigin(repository),
          ...(s3Lfs && companyOnly ? { mountRoot: S3_LFS_MOUNT_ROOT } : {}),
          ...(options.repositoryAuthorization ? { credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH } : {}),
        });
        if (options.repositoryAuthorization) {
          yield* workspaceRuntime.writeFile(binding.workspace, {
            path: REPOSITORY_CREDENTIAL_CONFIG_PATH,
            data: makeRepositoryCredentialConfig(repository, options.repositoryAuthorization, repositoryOrigin(repository)),
            mode: 0o600,
          }).pipe(Effect.mapError((cause) => provisionError("repository.refresh.credentials", "Repository credentials could not be prepared safely.", cause, binding.workspace.runtimeId)));
        }
        const result = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
          const refreshed = yield* Effect.exit(restore(runRepositoryPlan(binding.workspace, plan.command,
            companyOnly ? 45 : 300, companyOnly ? 30 : undefined)));
          const cleanup = yield* workspaceRuntime.exec(binding.workspace, { command: `rm -f ${shellQuote(REPOSITORY_CREDENTIAL_CONFIG_PATH)}`, timeoutSeconds: 10 }).pipe(
            Effect.mapError((cause) => provisionError("repository.refresh.cleanup", "Repository credential erasure could not be confirmed.", cause, binding.workspace.runtimeId)),
          );
          if (cleanup.exitCode !== 0 || cleanup.timedOut) return yield* provisionError("repository.refresh.cleanup", "Repository credential erasure could not be confirmed.", undefined, binding.workspace.runtimeId);
          if (Exit.isFailure(refreshed)) return yield* Effect.failCause(refreshed.cause);
          return refreshed.value;
        }));
        if (result.exitCode !== 0 || result.timedOut) return yield* provisionError("repository.refresh", "Company sources could not be refreshed and verified. Conflicting local work is preserved; move edited evidence to a draft before retrying.", new Error(result.stderr || result.stdout || "refresh failed"), binding.workspace.runtimeId);
        const refreshed = yield* Effect.try({
          try: () => parseRepositoryRefreshResult(result.stdout),
          catch: (cause) => provisionError("repository.refresh.verify", "Company refresh did not report its source commit.", cause, binding.workspace.runtimeId),
        });
        const { repositoryUnavailable: _unavailable, ...readyBinding } = binding;
        const updated = { ...readyBinding, repositoryCheckout: { binding: repository, commit: refreshed.commit,
          checkoutMode: companyOnly ? "company" as const : binding.repositoryCheckout!.checkoutMode } };
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
        if (s3Lfs && /^companies\/[a-z0-9][a-z0-9-]*$/.test(repositoryBinding.path)) yield* mountS3Lfs(binding.workspace);
        const plan = yield* Effect.try({
          try: () =>
            makeRepositoryReconcilePlan({
              binding: repositoryBinding,
              repositoryOrigin: repositoryOrigin(repositoryBinding),
              commit,
              persistedFiles,
              credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH,
              ...(s3Lfs && /^companies\/[a-z0-9][a-z0-9-]*$/.test(repositoryBinding.path) ? { mountRoot: S3_LFS_MOUNT_ROOT } : {}),
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
                runRepositoryPlan(binding.workspace, plan.command, 120),
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

    const prepareReadWorkspace = (binding: ProviderWorkerRuntimeBinding, filePath: string) => Effect.gen(function* () {
      if (!s3Lfs || binding.repositoryCheckout?.checkoutMode !== "company" ||
          !filePath.startsWith(`/workspace/repository/${binding.repositoryCheckout.binding.path}/`)) return;
      const probe = yield* workspaceRuntime.exec(binding.workspace, {
        command: `python3 -c ${shellQuote('import os,sys,stat; p=sys.argv[1]; s=os.lstat(p) if os.path.lexists(p) else None; print("pointer" if s is None or (stat.S_ISREG(s.st_mode) and s.st_size<=1024 and open(p,"rb").read(128).startswith(b"version https://git-lfs.github.com/spec/v1\\n")) else "data")')} ${shellQuote(filePath)}`,
        timeoutSeconds: 10,
      });
      if (probe.exitCode !== 0 || probe.timedOut) return yield* provisionError("workspace.file.read", "Could not inspect the saved workspace file.", undefined, binding.workspace.runtimeId);
      if (probe.stdout.trim() !== "pointer") return;
      yield* mountS3Lfs(binding.workspace);
      const repository = binding.repositoryCheckout.binding;
      const mounted = yield* runRepositoryPlan(binding.workspace, hydrateLfs(
        "/workspace/repository", repository.path,
        `${repositoryOrigin(repository)}/${repository.owner}/${repository.repository}.git`, repository.origin,
        undefined, S3_LFS_MOUNT_ROOT, filePath.slice("/workspace/repository/".length),
      ), 60);
      if (mounted.exitCode !== 0 || mounted.timedOut) return yield* provisionError("workspace.file.mount", "Saved company files could not be mounted.", undefined, binding.workspace.runtimeId);
    });

    const readWorkspaceFile: NonNullable<ProviderWorkerProvisionerShape["readWorkspaceFile"]> = (binding, filePath) =>
      lifecycleLock.withLock(binding.threadId ?? binding.workspace.runtimeId, Effect.gen(function* () {
        if (!isWorkspaceFilePathAllowed(binding, filePath)) return yield* provisionError("workspace.file.read", "This path is outside the permitted thread workspace.", undefined);
        if (!(yield* isWorkspaceUnavailable(binding))) {
          const file = yield* readProviderWorkspaceFile({ workspaceRuntime, binding, filePath });
          return { ...file, workspaceSource: "live" as const };
        }
        if (!binding.threadId) return yield* provisionError("workspace.file.read", "No thread workspace is available.", undefined);
        if (binding.workspace.runtimeKind === "daytona-sandbox" && workspaceRuntime.resume && workspaceRuntime.park) {
          const inventory = yield* workspaceRuntime.list;
          if (inventory.some((item) => item.runtimeId === binding.workspace.runtimeId)) {
            return yield* Effect.acquireUseRelease(
              workspaceRuntime.resume(binding.workspace, { threadId: binding.threadId, lifecycleGeneration: randomUUID(), maintenance: true }),
              (workspace) => prepareReadWorkspace({ ...binding, workspace }, filePath).pipe(
                Effect.andThen(readProviderWorkspaceFile({ workspaceRuntime, binding: { ...binding, workspace }, filePath })),
                Effect.map((file) => ({ ...file, workspaceSource: "live" as const })),
              ),
              (workspace) => workspaceRuntime.park!(workspace).pipe(Effect.catch((cause) => Effect.logError("native preview parking failed", { sandboxId: workspace.runtimeId, cause }))),
            );
          }
        }
        return yield* withSavedDisk(binding.threadId, (saved) => Effect.gen(function* () {
        const archivedBinding = saved?.archiveBinding ?? saved?.binding;
        const currentRepository = binding.repositoryCheckout?.binding;
        const savedRepository = saved?.binding.repositoryCheckout?.binding;
        if (!saved || !currentRepository || !savedRepository ||
            !(["origin", "owner", "repository", "ref", "path"] as const).every((key) => currentRepository[key] === savedRepository[key])) {
          return yield* provisionError("workspace.file.read", "No matching thread workspace checkpoint is available.", undefined);
        }
        const cacheKey = `${binding.threadId}\0${workspaceCheckpointRevision(saved)}\0${filePath}`;
        const cached = checkpointFiles.get(cacheKey);
        if (cached) {
          checkpointFiles.delete(cacheKey);
          checkpointFiles.set(cacheKey, cached);
          return cached;
        }
        // A preview needs disk bytes only. It must not launch Pi or refresh the
        // checkout, which could change the saved working copy being inspected.
        const file = yield* Effect.acquireUseRelease(
          workspaceRuntime.create({ maintenance: true, threadId: binding.threadId!, lifecycleGeneration: randomUUID(),
            ...((saved.archive ? options.templateCheckpointName : saved.checkpoint?.key) ? { checkpointName: saved.archive ? options.templateCheckpointName! : saved.checkpoint!.key } : {}), environment: {}, networkIsolation: "ISOLATED" }),
          (workspace) => (saved.archive ? restoreWorkspaceArchive({ workspaceRuntime, workspace, binding: archivedBinding!, archive: saved.archive }) : Effect.void).pipe(Effect.andThen(prepareReadWorkspace({ ...archivedBinding!, workspace }, filePath)), Effect.andThen(readProviderWorkspaceFile({ workspaceRuntime, binding: { ...archivedBinding!, workspace }, filePath })))
            .pipe(Effect.map((file) => ({ ...file, workspaceSource: "checkpoint" as const }))),
          (workspace) => workspaceRuntime.destroy(workspace).pipe(Effect.catch((cause) =>
            Effect.logError("workspace preview sandbox cleanup failed", { sandboxId: workspace.runtimeId, cause }))),
        );
        while (checkpointFiles.size >= 128 || checkpointFileBytes + file.sizeBytes > 64 * 1024 * 1024) {
          const oldest = checkpointFiles.keys().next().value;
          if (oldest === undefined) break;
          checkpointFileBytes -= checkpointFiles.get(oldest)!.sizeBytes;
          checkpointFiles.delete(oldest);
        }
        checkpointFiles.set(cacheKey, file);
        checkpointFileBytes += file.sizeBytes;
        return file;
        }));
      })).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError
        ? cause : provisionError("workspace.file.read", "Could not read the thread workspace.", cause)));

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
      readWorkspaceFile,
      stop,
      park,
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
      const photonWasm = yield* fileSystem
        .readFile(path.join(path.dirname(artifactPath), "photon_rs_bg.wasm"))
        .pipe(Effect.mapError((cause) =>
          provisionError("artifact.read", "Provider worker Photon WASM is missing; run the server build before enabling Railway distributed Pi.", cause)));
      return yield* makeProviderWorkerProvisioner({
        artifact,
        photonWasm,
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
