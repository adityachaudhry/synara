/**
 * Disposable sandboxes for durable Pi threads.
 *
 * The agent loop and conversation live in the controller (Pi Durable). A sandbox holds
 * only the company checkout, the read-only LFS mount and the thread's files, so it can be
 * replaced at any time:
 *
 * - claim:   create from the image, check out the company revision, restore drafts.
 * - capture: after file changes and turn ends, store Outbox files and checkout drafts on
 *            the controller (and publish Outbox artifacts).
 * - release: capture, stop agent processes, destroy.
 *
 * No worker process, credential, model key or conversation state is placed in a sandbox.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import { Cause, Duration, Effect, Exit, FileSystem, Layer, Schedule } from "effect";

import { ServerConfig } from "../../config.ts";
import { attachmentRelativePath } from "../../attachmentStore";
import { makeKeyedLock } from "../../provider/keyedLock";
import { observeProviderOperation } from "../../providerOperationDiagnostics";
import {
  PROVIDER_PERSISTENCE_OUTBOX_ROOT,
  isProviderPersistencePathSafe,
  type ProviderPersistenceCandidateList,
  type ProviderPersistenceFile,
} from "../../providerPersistence.ts";
import { WorkspaceRuntimeError } from "../../workspaceRuntime/Errors";
import { WorkspaceRuntime } from "../../workspaceRuntime/Services/WorkspaceRuntime";
import { publishOutboxArtifacts } from "../artifactPublisher.ts";
import { ProviderWorkerProvisioningError } from "../Errors";
import { headlessSessions } from "../headlessSessions.ts";
import { listUnpromotedOutboxCandidates, makeOutboxCheckpointStore } from "../outboxCheckpointStore.ts";
import { listProviderPersistenceCandidates, readProviderPersistenceCandidate } from "../persistenceCandidates";
import {
  hydrateLfs,
  makeRepositoryCheckoutPlan,
  makeRepositoryCredentialConfig,
  makeRepositoryReconcilePlan,
  parseRepositoryCheckoutResult,
  parseRepositoryReconcileResult,
  parseRepositoryRefreshResult,
  REPOSITORY_CREDENTIAL_CONFIG_PATH,
} from "../repositoryCheckout";
import { makeVerifiedRepositoryRefreshPlan } from "../repositoryIsolation";
import type { ProviderWorkerRuntimeBinding } from "../runtimeBinding";
import { S3_LFS_AGENT_UID, S3_LFS_MOUNT_ROOT, S3_LFS_PASSWORD_PATH, s3LfsCredentialFile, s3LfsMountCommand, s3LfsMountConfig } from "../s3LfsMount.ts";
import { ProviderWorkerProvisioner, type ProviderWorkerProvisionerShape, type ProviderWorkerProvisionInput } from "../Services/ProviderWorkerProvisioner";
import { isWorkspaceFilePathAllowed, readProviderWorkspaceFile } from "../workspaceFiles.ts";
import { WORKER_TOOLCHAIN_CHECK_COMMAND, WORKER_TOOLCHAIN_INSTALL_COMMAND } from "../workerToolchain.ts";

const DEFAULT_CWD = "/workspace";
const HOME_DIR = "/workspace/.synara-provider-worker";
const AGENT_GITCONFIG = "[safe]\n\tdirectory = /workspace/repository\n[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const provisionError = (operation: string, detail: string, cause?: unknown, sandboxId?: string) =>
  new ProviderWorkerProvisioningError({ operation, detail, ...(sandboxId === undefined ? {} : { sandboxId }), cause });

export interface SandboxProvisionerOptions {
  readonly checkpointRoot: string;
  readonly templateCheckpointName?: string;
  readonly repositoryOriginOverride?: { readonly sourceOrigin: string; readonly origin: string };
  readonly repositoryAuthorization?: string;
  readonly networkIsolation?: "ISOLATED" | "PRIVATE";
}

export const makeSandboxProvisioner = (options: SandboxProvisionerOptions) =>
  Effect.gen(function* () {
    const workspaceRuntime = yield* WorkspaceRuntime;
    const fileSystem = yield* FileSystem.FileSystem;
    const lock = makeKeyedLock<string>();
    const outboxStore = makeOutboxCheckpointStore(options.checkpointRoot);
    const draftStore = makeOutboxCheckpointStore(path.join(options.checkpointRoot, "drafts"));
    const activeByThread = new Map<string, ProviderWorkerRuntimeBinding>();
    const companyRefs = process.env.SYNARA_COMPANY_WORKSPACE_REFS === "true";
    const s3Lfs = s3LfsMountConfig(process.env);

    const repositoryOrigin = (binding: { readonly origin: string }) =>
      options.repositoryOriginOverride && binding.origin === options.repositoryOriginOverride.sourceOrigin
        ? options.repositoryOriginOverride.origin
        : binding.origin;
    const companyOnlyFor = (repository: NonNullable<ProviderWorkerProvisionInput["repositoryBinding"]>) =>
      companyRefs && repository.ref === "main" && /^companies\/[a-z0-9][a-z0-9-]*$/u.test(repository.path);
    const exec = (workspace: ProviderWorkerRuntimeBinding["workspace"], command: string, timeoutSeconds: number) =>
      workspaceRuntime.exec(workspace, { command, timeoutSeconds });
    const mustExec = (workspace: ProviderWorkerRuntimeBinding["workspace"], command: string, timeoutSeconds: number, operation: string, detail: string) =>
      exec(workspace, command, timeoutSeconds).pipe(
        Effect.flatMap((result) => result.exitCode === 0 && !result.timedOut
          ? Effect.succeed(result)
          : Effect.fail(provisionError(operation, detail, new Error(result.stderr || result.stdout || "command failed"), workspace.runtimeId))),
      );

    const mountS3Lfs = Effect.fn(function* (workspace: ProviderWorkerRuntimeBinding["workspace"]) {
      if (!s3Lfs) return;
      const ready = yield* exec(workspace, `mountpoint -q ${shellQuote(S3_LFS_MOUNT_ROOT)}`, 10);
      if (ready.exitCode === 0 && !ready.timedOut) return;
      yield* workspaceRuntime.writeFile(workspace, { path: S3_LFS_PASSWORD_PATH, data: s3LfsCredentialFile(s3Lfs), mode: 0o600 });
      const mounted = yield* Effect.exit(exec(workspace, s3LfsMountCommand(s3Lfs), 45));
      yield* mustExec(workspace, `rm -f ${shellQuote(S3_LFS_PASSWORD_PATH)} && test ! -e ${shellQuote(S3_LFS_PASSWORD_PATH)}`, 10,
        "repository.mount.cleanup", "S3 mount credential erasure could not be confirmed.");
      if (Exit.isFailure(mounted) || mounted.value.exitCode !== 0 || mounted.value.timedOut)
        return yield* provisionError("repository.mount", "Company S3 files could not be mounted.", Exit.isFailure(mounted) ? Cause.squash(mounted.cause) : undefined, workspace.runtimeId);
    });

    /** Runs a repository plan with a short-lived credential file that is always erased. */
    const withRepositoryCredential = <A, E>(
      workspace: ProviderWorkerRuntimeBinding["workspace"],
      repository: NonNullable<ProviderWorkerProvisionInput["repositoryBinding"]>,
      run: Effect.Effect<A, E>,
    ) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      if (options.repositoryAuthorization) {
        yield* workspaceRuntime.writeFile(workspace, {
          path: REPOSITORY_CREDENTIAL_CONFIG_PATH,
          data: makeRepositoryCredentialConfig(repository, options.repositoryAuthorization, repositoryOrigin(repository)),
          mode: 0o600,
        });
      }
      const result = yield* Effect.exit(restore(run));
      yield* mustExec(workspace, `rm -f ${shellQuote(REPOSITORY_CREDENTIAL_CONFIG_PATH)} && test ! -e ${shellQuote(REPOSITORY_CREDENTIAL_CONFIG_PATH)}`, 10,
        "repository.credential.cleanup", "Repository credential erasure could not be confirmed.");
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      return result.value;
    }));

    const runPlan = (workspace: ProviderWorkerRuntimeBinding["workspace"], command: string, timeoutSeconds: number, shellTimeout?: number) =>
      exec(workspace, shellTimeout ? `timeout --kill-after=5s ${shellTimeout}s sh -c ${shellQuote(command)}` : command, timeoutSeconds);

    const prepareToolchain = Effect.fn(function* (workspace: ProviderWorkerRuntimeBinding["workspace"]) {
      const probe = yield* exec(workspace, WORKER_TOOLCHAIN_CHECK_COMMAND, 15);
      if (probe.exitCode === 0 && !probe.timedOut) return;
      yield* mustExec(workspace, WORKER_TOOLCHAIN_INSTALL_COMMAND, 180, "workspace.toolchain", "Sandbox tools could not be installed.");
    });

    /** Writes captured Outbox files and checkout drafts back into a fresh sandbox. */
    const restoreFiles = Effect.fn(function* (binding: ProviderWorkerRuntimeBinding) {
      if (!binding.threadId) return;
      const [outbox, drafts] = yield* Effect.tryPromise({
        try: () => Promise.all([outboxStore.restore(binding.threadId!), draftStore.restore(binding.threadId!)]),
        catch: (cause) => provisionError("files.restore", "Captured thread files could not be read.", cause, binding.workspace.runtimeId),
      });
      const checkoutRoot = binding.repositoryCheckout ? `/workspace/repository/${binding.repositoryCheckout.binding.path}` : undefined;
      const targets = [
        ...outbox.map((file) => ({ ...file, target: path.posix.join(PROVIDER_PERSISTENCE_OUTBOX_ROOT, file.path) })),
        ...(checkoutRoot ? drafts.map((file) => ({ ...file, target: path.posix.join(checkoutRoot, file.path) })) : []),
      ];
      if (targets.length === 0) return;
      yield* Effect.forEach(targets, (file) =>
        mustExec(binding.workspace, `mkdir -p ${shellQuote(path.posix.dirname(file.target))}`, 10, "files.restore", "Could not prepare a restored file directory.").pipe(
          Effect.andThen(workspaceRuntime.writeFile(binding.workspace, { path: file.target, data: file.bytes, mode: 0o644 })),
        ), { concurrency: 2, discard: true });
      yield* mustExec(binding.workspace,
        `chown -R ${S3_LFS_AGENT_UID}:${S3_LFS_AGENT_UID} ${targets.map((file) => shellQuote(file.target)).join(" ")} ${shellQuote(PROVIDER_PERSISTENCE_OUTBOX_ROOT)}`,
        30, "files.restore.owner", "Restored thread files are not readable to the agent.");
      yield* Effect.logInfo("thread files restored into a fresh sandbox", {
        threadId: binding.threadId, sandboxId: binding.workspace.runtimeId, outbox: outbox.length, drafts: drafts.length,
      });
    });

    const claim = (input: ProviderWorkerProvisionInput) => Effect.gen(function* () {
      const workspace = yield* workspaceRuntime.create({
        ...(input.speculative ? { speculative: true } : {}),
        threadId: input.threadId,
        lifecycleGeneration: input.lifecycleGeneration,
        ...(options.templateCheckpointName ? { checkpointName: options.templateCheckpointName } : {}),
        // No credentials or model keys: the agent loop runs in the controller.
        environment: {},
        networkIsolation: options.networkIsolation ?? "ISOLATED",
        ...(input.onCapacityAdmitted ? { onCapacityAdmitted: input.onCapacityAdmitted } : {}),
      }).pipe(observeProviderOperation("workspace.create", { threadId: input.threadId, lifecycleGeneration: input.lifecycleGeneration }));
      const prepare = Effect.gen(function* () {
        yield* prepareToolchain(workspace);
        const repository = input.repositoryBinding;
        const companyOnly = repository ? companyOnlyFor(repository) : false;
        if (repository && companyOnly) yield* mountS3Lfs(workspace);
        let repositoryUnavailable = false;
        let checkout: { readonly commit: string; readonly checkoutMode: "partial" | "shallow" | "company" } | undefined;
        const plan = repository
          ? makeRepositoryCheckoutPlan({
              companyOnly,
              binding: repository,
              repositoryOrigin: repositoryOrigin(repository),
              ...(s3Lfs && companyOnly ? { mountRoot: S3_LFS_MOUNT_ROOT } : {}),
              ...(options.repositoryAuthorization ? { credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH } : {}),
            })
          : undefined;
        const cwd = plan?.cwd ?? input.cwd?.trim() ?? DEFAULT_CWD;
        if (repository && plan) {
          const result = yield* withRepositoryCredential(workspace, repository,
            runPlan(workspace, plan.command, companyOnly ? 45 : 120, companyOnly ? 30 : undefined));
          if (result.exitCode === 0 && !result.timedOut) {
            checkout = yield* Effect.try({
              try: () => parseRepositoryCheckoutResult(result.stdout),
              catch: (cause) => provisionError("checkout.verify", "Repository checkout did not report a verified commit.", cause, workspace.runtimeId),
            });
          } else if (companyOnly) {
            repositoryUnavailable = true;
            yield* Effect.logWarning("company files unavailable; starting conversation without tools", { threadId: input.threadId });
            yield* mustExec(workspace, `mkdir -p ${shellQuote(cwd)}`, 10, "workspace.directory", "Could not prepare the chat workspace.");
          } else {
            return yield* provisionError("checkout.exec", "Repository checkout failed.", new Error(result.stderr || result.stdout), workspace.runtimeId);
          }
        }
        // The agent user owns its company directory, Outbox and home; Git metadata stays root-owned.
        yield* mustExec(workspace, [
          `mkdir -p ${shellQuote(HOME_DIR)} ${shellQuote(PROVIDER_PERSISTENCE_OUTBOX_ROOT)} ${shellQuote(cwd)}`,
          "chown 0:0 /workspace /workspace/.synara && chmod 755 /workspace /workspace/.synara",
          `chown -R ${S3_LFS_AGENT_UID}:${S3_LFS_AGENT_UID} ${shellQuote(HOME_DIR)} ${shellQuote(PROVIDER_PERSISTENCE_OUTBOX_ROOT)}`,
          ...(repository ? [
            "chown 0:0 /workspace/repository && chmod 755 /workspace/repository",
            "if [ -d /workspace/repository/.git ]; then chown -R 0:0 /workspace/repository/.git && chmod 755 /workspace/repository/.git && chmod -R go-w /workspace/repository/.git; fi",
          ] : []),
        ].join(" && "), 60, "workspace.user", "Could not prepare the agent user.");
        yield* workspaceRuntime.writeFile(workspace, { path: "/opt/synara/agent-gitconfig", data: AGENT_GITCONFIG, mode: 0o644 });
        const binding: ProviderWorkerRuntimeBinding = {
          schemaVersion: 1,
          runtimeKind: "daytona-pi",
          threadId: input.threadId,
          workspace,
          fence: { sandboxId: workspace.runtimeId, workerId: randomUUID(), lifecycleGeneration: input.lifecycleGeneration },
          durableSessionName: "headless",
          headless: true,
          cwd,
          homeDir: HOME_DIR,
          ...(repositoryUnavailable && repository ? { repositoryUnavailable: { binding: repository, lastAttemptAt: new Date().toISOString() } } : {}),
          ...(repository && checkout ? { repositoryCheckout: { binding: repository, ...checkout } } : {}),
        };
        yield* restoreFiles(binding);
        yield* Effect.logInfo(JSON.stringify({
          event: "provider.operation.finished", operation: "sandbox.claimed",
          threadId: input.threadId, lifecycleGeneration: input.lifecycleGeneration, sandboxId: workspace.runtimeId,
          checkoutCommit: checkout?.commit,
        }));
        return binding;
      });
      return yield* prepare.pipe(
        Effect.onError(() => workspaceRuntime.destroy(workspace).pipe(Effect.catch((cause) =>
          Effect.logError("failed sandbox cleanup after a claim error", { sandboxId: workspace.runtimeId, cause })))),
      );
    }).pipe(
      observeProviderOperation("worker.provision", { threadId: input.threadId, lifecycleGeneration: input.lifecycleGeneration }),
      Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError ? cause
        : provisionError("start", "Failed to prepare a company sandbox.", cause)),
    );

    const isWorkspaceUnavailable: NonNullable<ProviderWorkerProvisionerShape["isWorkspaceUnavailable"]> = (binding) =>
      workspaceRuntime.connect(binding.workspace).pipe(
        // A stopped sandbox is replaced, never resumed: nothing in it outlives a capture.
        Effect.map((workspace) => workspace.status !== "running"),
        Effect.catch((cause) => Effect.succeed(cause.unavailable === true || cause.status === "stopped" || cause.status === "destroyed")),
      );

    /** Stores live Outbox files and checkout drafts on the controller; publishes Outbox artifacts. */
    const capture = (binding: ProviderWorkerRuntimeBinding, turnId?: string) => Effect.gen(function* () {
      const live = yield* listProviderPersistenceCandidates({ workspaceRuntime, binding });
      const published = yield* Effect.exit(publishOutboxArtifacts({
        binding, entries: live.entries, workspaceRuntime, ...(turnId ? { turnId } : {}),
      }));
      if (Exit.isFailure(published)) yield* Effect.logWarning("direct artifact upload deferred; preserving Outbox on the controller", { threadId: binding.threadId });
      if (!binding.threadId) return live;
      const read = (source: "outbox" | "checkout") => Effect.forEach(
        live.entries.filter((entry) => entry.source === source),
        (selection) => readProviderPersistenceCandidate({ workspaceRuntime, binding, selection }),
        { concurrency: 4 },
      );
      const [outbox, drafts] = yield* Effect.all([read("outbox"), read("checkout")]);
      const manifest = yield* Effect.tryPromise({
        try: async () => {
          const saved = await outboxStore.checkpoint({ threadId: binding.threadId!, lifecycleGeneration: binding.fence.lifecycleGeneration, files: outbox });
          // The draft store is a separate directory; it reuses the Outbox store format.
          await draftStore.checkpoint({
            threadId: binding.threadId!,
            lifecycleGeneration: binding.fence.lifecycleGeneration,
            files: drafts.map((file) => ({ ...file, source: "outbox" as const })),
          });
          return saved;
        },
        catch: (cause) => provisionError("persistence.checkpoint.write", "Failed to capture thread files on the controller.", cause, binding.workspace.runtimeId),
      });
      const entries = Exit.isSuccess(published) && published.value !== undefined
        ? published.value
        : [...listUnpromotedOutboxCandidates(manifest), ...live.entries.filter((entry) => entry.source === "checkout")];
      return { ...live, entries } satisfies ProviderPersistenceCandidateList;
    });

    const checkpointOutbox: ProviderWorkerProvisionerShape["checkpointOutbox"] = (binding, turnId) =>
      lock.withLock(`capture:${binding.threadId ?? binding.workspace.runtimeId}`, capture(binding, turnId)).pipe(
        Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError ? cause
          : provisionError("persistence.checkpoint", "Failed to capture thread files.", cause, binding.workspace.runtimeId)),
      );

    /** Capture what can still be read, stop agent processes, destroy the sandbox. */
    const release = (binding: ProviderWorkerRuntimeBinding) => Effect.gen(function* () {
      if (!(yield* isWorkspaceUnavailable(binding))) {
        yield* checkpointOutbox(binding).pipe(Effect.catch((cause) =>
          Effect.logWarning("sandbox capture before release failed; files from the last capture are kept", { threadId: binding.threadId, cause })));
        yield* exec(binding.workspace, `pkill -KILL -u ${S3_LFS_AGENT_UID} 2>/dev/null || true`, 10).pipe(Effect.catch(() => Effect.void));
      }
      yield* workspaceRuntime.destroy(binding.workspace).pipe(Effect.catch((cause) =>
        cause instanceof WorkspaceRuntimeError && cause.unavailable ? Effect.void : Effect.fail(cause)));
      if (binding.threadId && activeByThread.get(binding.threadId)?.workspace.runtimeId === binding.workspace.runtimeId) {
        activeByThread.delete(binding.threadId);
      }
    }).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError ? cause
      : provisionError("workspace.release", "Failed to release the sandbox.", cause, binding.workspace.runtimeId)));

    const start: ProviderWorkerProvisionerShape["start"] = (input) =>
      lock.withLock(input.threadId, Effect.gen(function* () {
        const active = activeByThread.get(input.threadId);
        if (active && !(yield* isWorkspaceUnavailable(active))) {
          if (active.fence.lifecycleGeneration === input.lifecycleGeneration) return active;
          yield* release(active);
        }
        const binding = yield* claim(input);
        activeByThread.set(input.threadId, binding);
        return binding;
      }));

    const restart: ProviderWorkerProvisionerShape["restart"] = (previous, input) =>
      lock.withLock(input.threadId, Effect.gen(function* () {
        const active = activeByThread.get(input.threadId) ?? previous;
        if (active.headless && !(yield* isWorkspaceUnavailable(active))) {
          if (active.fence.lifecycleGeneration === input.lifecycleGeneration) {
            activeByThread.set(input.threadId, active);
            return active;
          }
          yield* release(active);
        }
        const binding = yield* claim({ ...input, ...(input.repositoryBinding ? {} : previous.repositoryCheckout ? { repositoryBinding: previous.repositoryCheckout.binding } : {}) });
        activeByThread.set(input.threadId, binding);
        return binding;
      }));

    const stop: ProviderWorkerProvisionerShape["stop"] = (binding) =>
      lock.withLock(binding.threadId ?? binding.workspace.runtimeId, release(binding));

    const adopt: ProviderWorkerProvisionerShape["adopt"] = (binding) =>
      workspaceRuntime.adopt(binding.workspace).pipe(
        Effect.tap(() => Effect.sync(() => { if (binding.threadId) activeByThread.set(binding.threadId, binding); })),
        Effect.mapError((cause) => provisionError("adopt", "Failed to adopt the sandbox.", cause, binding.workspace.runtimeId)),
      );

    const stageAttachments: ProviderWorkerProvisionerShape["stageAttachments"] = (binding, attachments) =>
      Effect.forEach(attachments, ({ attachment, sourcePath }) => Effect.gen(function* () {
        const data = yield* fileSystem.readFile(sourcePath);
        const target = path.posix.join(binding.homeDir, "state", "attachments", attachmentRelativePath(attachment));
        yield* mustExec(binding.workspace, `mkdir -p ${shellQuote(path.posix.dirname(target))}`, 10, "attachment.write", "Could not prepare the attachment directory.");
        yield* workspaceRuntime.writeFile(binding.workspace, { path: target, data, mode: 0o600 });
        yield* mustExec(binding.workspace, `chown ${S3_LFS_AGENT_UID}:${S3_LFS_AGENT_UID} ${shellQuote(target)}`, 10,
          "attachment.owner", "Could not make the attachment readable to the agent.");
      }).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError ? cause
        : provisionError("attachment.write", `Failed to stage attachment '${attachment.id}'.`, cause, binding.workspace.runtimeId))),
      { concurrency: 1, discard: true });

    const refreshRepository: NonNullable<ProviderWorkerProvisionerShape["refreshRepository"]> = (binding) =>
      lock.withLock(binding.threadId ?? binding.workspace.runtimeId, Effect.gen(function* () {
        const repository = binding.repositoryCheckout?.binding ?? binding.repositoryUnavailable?.binding;
        if (!repository) return yield* provisionError("repository.refresh", "The sandbox has no company source binding.", undefined, binding.workspace.runtimeId);
        const companyOnly = companyOnlyFor(repository) || binding.repositoryCheckout?.checkoutMode === "company";
        if (s3Lfs && companyOnly) yield* mountS3Lfs(binding.workspace);
        const plan = makeVerifiedRepositoryRefreshPlan({
          companyOnly,
          verifiedCommit: binding.repositoryCheckout?.commit,
          binding: repository,
          repositoryOrigin: repositoryOrigin(repository),
          ...(s3Lfs && companyOnly ? { mountRoot: S3_LFS_MOUNT_ROOT } : {}),
          ...(options.repositoryAuthorization ? { credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH } : {}),
        });
        const result = yield* withRepositoryCredential(binding.workspace, repository,
          runPlan(binding.workspace, plan.command, companyOnly ? 45 : 300, companyOnly ? 30 : undefined));
        if (result.exitCode !== 0 || result.timedOut) return yield* provisionError("repository.refresh",
          "Company sources could not be refreshed and verified. Conflicting local work is preserved; move edited evidence to a draft before retrying.",
          new Error(result.stderr || result.stdout || "refresh failed"), binding.workspace.runtimeId);
        const refreshed = yield* Effect.try({
          try: () => parseRepositoryRefreshResult(result.stdout),
          catch: (cause) => provisionError("repository.refresh.verify", "Company refresh did not report its source commit.", cause, binding.workspace.runtimeId),
        });
        const { repositoryUnavailable: _unavailable, ...ready } = binding;
        const updated: ProviderWorkerRuntimeBinding = {
          ...ready,
          repositoryCheckout: { binding: repository, commit: refreshed.commit, checkoutMode: companyOnly ? "company" : binding.repositoryCheckout!.checkoutMode },
        };
        if (binding.threadId) activeByThread.set(binding.threadId, updated);
        return { binding: updated, ...refreshed };
      })).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError ? cause
        : provisionError("repository.refresh", "Failed to refresh company sources.", cause, binding.workspace.runtimeId)));

    const reconcileRepository: ProviderWorkerProvisionerShape["reconcileRepository"] = (binding, commit, persistedFiles = [], activeTurnId) =>
      lock.withLock(binding.threadId ?? binding.workspace.runtimeId, Effect.gen(function* () {
        const session = headlessSessions(binding.threadId).find((candidate) => candidate.threadId === binding.threadId);
        if (activeTurnId === undefined ? session?.activeTurnId !== undefined : session?.activeTurnId !== activeTurnId)
          return yield* provisionError("repository.reconcile", "The requesting turn changed while waiting to reconcile company files.", undefined, binding.workspace.runtimeId);
        const repository = binding.repositoryCheckout?.binding;
        if (!repository || !options.repositoryAuthorization)
          return yield* provisionError("repository.reconcile", "The sandbox does not have a repository binding.", undefined, binding.workspace.runtimeId);
        yield* Effect.forEach(persistedFiles, (selection) => readProviderPersistenceCandidate({ workspaceRuntime, binding, selection }), { concurrency: 1, discard: true });
        const companyPath = /^companies\/[a-z0-9][a-z0-9-]*$/u.test(repository.path);
        if (s3Lfs && companyPath) yield* mountS3Lfs(binding.workspace);
        const plan = yield* Effect.try({
          try: () => makeRepositoryReconcilePlan({
            binding: repository, repositoryOrigin: repositoryOrigin(repository), commit, persistedFiles,
            credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH,
            ...(s3Lfs && companyPath ? { mountRoot: S3_LFS_MOUNT_ROOT } : {}),
          }),
          catch: (cause) => provisionError("repository.reconcile.plan", "The requested repository commit is invalid.", cause, binding.workspace.runtimeId),
        });
        const result = yield* withRepositoryCredential(binding.workspace, repository, runPlan(binding.workspace, plan.command, 120));
        if (result.exitCode !== 0 || result.timedOut)
          return yield* provisionError("repository.reconcile.exec", "The sandbox checkout could not fast-forward without overwriting local work.",
            new Error(result.stderr || result.stdout || "reconciliation failed"), binding.workspace.runtimeId);
        const reconciled = yield* Effect.try({
          try: () => parseRepositoryReconcileResult(result.stdout),
          catch: (cause) => provisionError("repository.reconcile.verify", "The sandbox did not report its reconciled commit.", cause, binding.workspace.runtimeId),
        });
        const updated = { ...binding, repositoryCheckout: { ...binding.repositoryCheckout!, commit: reconciled.commit } };
        if (binding.threadId) activeByThread.set(binding.threadId, updated);
        // Saved drafts are now company history; drop their captured copies.
        yield* Effect.tryPromise({ try: () => draftStore.markPromoted(binding.threadId!, persistedFiles), catch: () => undefined }).pipe(Effect.catch(() => Effect.void));
        return updated;
      })).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError ? cause
        : provisionError("repository.reconcile", "Failed to reconcile the sandbox repository.", cause, binding.workspace.runtimeId)));

    const readPersistenceCandidate: ProviderWorkerProvisionerShape["readPersistenceCandidate"] = (binding, selection) =>
      (binding.threadId && selection.source === "outbox"
        ? Effect.tryPromise({ try: () => outboxStore.read(binding.threadId!, selection), catch: (cause) => cause })
        : readProviderPersistenceCandidate({ workspaceRuntime, binding, selection })
      ).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError ? cause
        : provisionError("persistence.read", "Failed to read the selected file.", cause, binding.workspace.runtimeId)));

    const readWorkspaceFile: NonNullable<ProviderWorkerProvisionerShape["readWorkspaceFile"]> = (binding, filePath) =>
      Effect.gen(function* () {
        if (!isWorkspaceFilePathAllowed(binding, filePath))
          return yield* provisionError("workspace.file.read", "This path is outside the permitted thread workspace.");
        if (!(yield* isWorkspaceUnavailable(binding))) {
          const repository = binding.repositoryCheckout;
          if (s3Lfs && repository?.checkoutMode === "company" && filePath.startsWith(`/workspace/repository/${repository.binding.path}/`)) {
            yield* mountS3Lfs(binding.workspace);
            yield* runPlan(binding.workspace, hydrateLfs("/workspace/repository", repository.binding.path,
              `${repositoryOrigin(repository.binding)}/${repository.binding.owner}/${repository.binding.repository}.git`,
              repository.binding.origin, undefined, S3_LFS_MOUNT_ROOT, filePath.slice("/workspace/repository/".length)), 60);
          }
          const file = yield* readProviderWorkspaceFile({ workspaceRuntime, binding, filePath });
          return { ...file, workspaceSource: "live" as const };
        }
        // The sandbox is gone: serve the last captured copy.
        if (!binding.threadId) return yield* provisionError("workspace.file.read", "No thread workspace is available.");
        const relative = filePath.startsWith(`${PROVIDER_PERSISTENCE_OUTBOX_ROOT}/`)
          ? { store: outboxStore, path: filePath.slice(PROVIDER_PERSISTENCE_OUTBOX_ROOT.length + 1) }
          : binding.repositoryCheckout && filePath.startsWith(`/workspace/repository/${binding.repositoryCheckout.binding.path}/`)
            ? { store: draftStore, path: filePath.slice(`/workspace/repository/${binding.repositoryCheckout.binding.path}/`.length) }
            : undefined;
        if (!relative || !isProviderPersistencePathSafe(relative.path))
          return yield* provisionError("workspace.file.read", "Only captured thread files can be read while the sandbox is released.");
        const file = yield* Effect.tryPromise({
          try: () => relative.store.readPath(binding.threadId!, relative.path),
          catch: (cause) => provisionError("workspace.file.read", "The file is not in the thread's captured files.", cause),
        });
        return { ...(file as ProviderPersistenceFile), workspaceSource: "checkpoint" as const } as never;
      }).pipe(Effect.mapError((cause) => cause instanceof ProviderWorkerProvisioningError ? cause
        : provisionError("workspace.file.read", "Could not read the thread workspace.", cause)));

    /**
     * One-time move of a worker-era thread: resume its retained disk read-only, read its Pi
     * session file, capture its Outbox and drafts, then park the disk again. The original
     * disk and its archives are kept.
     */
    const importLegacy: NonNullable<ProviderWorkerProvisionerShape["importLegacy"]> = (previous, sessionFile) =>
      lock.withLock(previous.threadId ?? previous.workspace.runtimeId, Effect.gen(function* () {
        if (previous.workspace.runtimeKind !== "daytona-sandbox" || !workspaceRuntime.resume) return {};
        const connected = yield* Effect.exit(workspaceRuntime.connect(previous.workspace));
        const stoppedOrMissing = Exit.isFailure(connected) || connected.value.status !== "running";
        const workspace = !stoppedOrMissing ? previous.workspace : yield* workspaceRuntime.resume(previous.workspace, {
          threadId: previous.threadId ?? randomUUID(), lifecycleGeneration: randomUUID(), maintenance: true,
        }).pipe(Effect.catch((cause) => Effect.logWarning("worker-era disk could not be resumed; history import skipped", { threadId: previous.threadId, cause }).pipe(Effect.as(undefined))));
        if (!workspace) return {};
        const legacy = { ...previous, workspace };
        let sessionJsonl: string | undefined;
        if (sessionFile) {
          const file = sessionFile.startsWith("/root/") ? `/workspace${sessionFile.slice("/root".length)}` : sessionFile;
          const read = yield* exec(workspace, `cat ${shellQuote(file)} 2>/dev/null || cat ${shellQuote(sessionFile)}`, 60);
          if (read.exitCode === 0 && !read.timedOut) sessionJsonl = read.stdout;
        }
        yield* capture(legacy).pipe(Effect.catch((cause) => Effect.logWarning("worker-era files could not be captured", { threadId: previous.threadId, cause })));
        if (workspaceRuntime.park) yield* workspaceRuntime.park(workspace).pipe(Effect.catch(() => Effect.void));
        return sessionJsonl === undefined ? {} : { sessionJsonl };
      }));

    // Periodic capture of live sandboxes: a lost sandbox costs at most a minute of file work.
    yield* Effect.forkScoped(Effect.suspend(() => Effect.forEach(Array.from(activeByThread.values()), (binding) =>
      checkpointOutbox(binding).pipe(Effect.catch(() => Effect.void)), { concurrency: 2, discard: true }),
    ).pipe(Effect.repeat(Schedule.spaced(Duration.minutes(1)))));

    return {
      execInWorkspace: (binding, input) => workspaceRuntime.exec(binding.workspace, input),
      writeWorkspaceFile: (binding, input) => workspaceRuntime.writeFile(binding.workspace, input),
      isWorkspaceUnavailable,
      start,
      restart,
      adopt,
      stop,
      park: stop,
      stageAttachments,
      checkpointOutbox,
      refreshRepository,
      markOutboxPromoted: (binding, selections) => binding.threadId
        ? Effect.tryPromise({ try: () => outboxStore.markPromoted(binding.threadId!, selections), catch: (cause) =>
            provisionError("persistence.checkpoint.promote", "Failed to record promoted Outbox files.", cause, binding.workspace.runtimeId) })
        : Effect.void,
      reconcileRepository,
      listPersistenceCandidates: checkpointOutbox,
      readPersistenceCandidate,
      readWorkspaceFile,
      readOutboxCheckpoint: (threadId, candidatePath) => Effect.tryPromise({
        try: () => outboxStore.readPath(threadId, candidatePath),
        catch: (cause) => provisionError("persistence.checkpoint.read", "Failed to read the captured Outbox file.", cause),
      }),
      importLegacy,
    } satisfies ProviderWorkerProvisionerShape;
  });

export const makeSandboxProvisionerLive = (options: Omit<SandboxProvisionerOptions, "checkpointRoot"> & { readonly checkpointRoot?: string }) =>
  Layer.effect(ProviderWorkerProvisioner, Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    return yield* makeSandboxProvisioner({
      ...options,
      checkpointRoot: options.checkpointRoot ?? path.join(serverConfig.baseDir, "provider-outbox-checkpoints"),
    });
  }));
