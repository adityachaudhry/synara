import {
  PI_THINKING_LEVEL_OPTIONS,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type ProjectId,
  type ServerProviderStatus,
} from "@synara/contracts";
import {
  isThreadMentionPath,
  threadIdFromThreadMentionPath,
} from "@synara/shared/threadMentions";
import { Effect, Option, ServiceMap } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";

export type ProjectScope = ReadonlySet<ProjectId> | undefined;

export const CurrentProjectScope = ServiceMap.Reference<ProjectScope>(
  "synara/auth/CurrentProjectScope",
  { defaultValue: () => undefined },
);

export function toProjectScope(
  allowedProjectIds: ReadonlyArray<ProjectId> | undefined,
): ProjectScope {
  return allowedProjectIds === undefined ? undefined : new Set(allowedProjectIds);
}

export function filterReadModelByProjectScope(
  snapshot: OrchestrationReadModel,
  scope: ProjectScope,
): OrchestrationReadModel {
  if (scope === undefined) return snapshot;
  return {
    ...snapshot,
    spaces: [],
    projects: snapshot.projects.filter((project) => scope.has(project.id)),
    threads: snapshot.threads.filter((thread) => scope.has(thread.projectId)),
  };
}

export function filterShellSnapshotByProjectScope(
  snapshot: OrchestrationShellSnapshot,
  scope: ProjectScope,
): OrchestrationShellSnapshot {
  if (scope === undefined) return snapshot;
  return {
    ...snapshot,
    spaces: [],
    projects: snapshot.projects.filter((project) => scope.has(project.id)),
    threads: snapshot.threads.filter((thread) => scope.has(thread.projectId)),
  };
}

export function filterProviderStatusesByProjectScope(
  statuses: ReadonlyArray<ServerProviderStatus>,
  scope: ProjectScope,
): ReadonlyArray<ServerProviderStatus> {
  if (scope === undefined) return statuses;
  return statuses.map((status) => ({
    provider: status.provider,
    status: status.status,
    available: status.available,
    authStatus: status.authStatus,
    ...(status.voiceTranscriptionAvailable === undefined
      ? {}
      : { voiceTranscriptionAvailable: status.voiceTranscriptionAvailable }),
    ...(status.supportsAutoRuntimeMode === undefined
      ? {}
      : { supportsAutoRuntimeMode: status.supportsAutoRuntimeMode }),
    checkedAt: status.checkedAt,
  }));
}

const SCOPE_FILTERED_GLOBAL_METHODS = new Set([
  "orchestration.getSnapshot",
  "orchestration.getShellSnapshot",
  "orchestration.subscribeShell",
  "orchestration.unsubscribeShell",
  "orchestration.subscribeDomainEvents",
  "orchestration.unsubscribeThread",
  "terminal.subscribeEvents",
  "projects.listDevServers",
  "projects.subscribeDevServerEvents",
  "provider.getComposerCapabilities",
  "server.refreshProviders",
  "server.subscribeProviderStatuses",
]);

const SCOPE_DENIED_METHODS = new Set([
  "orchestration.importThread",
  "filesystem.browse",
  "projects.provisionFromGitHub",
  "projects.runDevServer",
  "projects.stopDevServer",
  "git.createWorktree",
  "git.createDetachedWorktree",
  "git.removeWorktree",
  "git.handoffThread",
  "terminal.open",
  "terminal.write",
  "terminal.resize",
  "terminal.clear",
  "terminal.restart",
  "terminal.close",
  "automation.list",
  "automation.getMemory",
  "automation.create",
  "automation.update",
  "automation.delete",
  "automation.runNow",
  "automation.cancelRun",
  "automation.markRunRead",
  "automation.archiveRun",
  "automation.resolveProposal",
]);

function stringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function scopedPayload(method: string, payload: unknown): unknown {
  if (method !== "orchestration.dispatchCommand" || !payload || typeof payload !== "object") {
    return payload;
  }
  return (payload as Record<string, unknown>).command ?? payload;
}

function hasSafeScopedModelConfiguration(payload: Record<string, unknown>): boolean {
  if (payload.providerOptions !== undefined) return false;
  const modelSelection = payload.modelSelection;
  if (modelSelection === undefined) return true;
  if (
    modelSelection === null ||
    typeof modelSelection !== "object" ||
    stringField(modelSelection, "provider") === undefined ||
    stringField(modelSelection, "model") === undefined
  ) {
    return false;
  }
  const selection = modelSelection as Record<string, unknown>;
  if (selection.options === undefined) {
    return Object.keys(selection).every((key) => key === "provider" || key === "model");
  }
  if (
    selection.provider !== "pi" ||
    !Object.keys(selection).every(
      (key) => key === "provider" || key === "model" || key === "options",
    ) ||
    selection.options === null ||
    typeof selection.options !== "object" ||
    Array.isArray(selection.options)
  ) {
    return false;
  }
  const options = selection.options as Record<string, unknown>;
  return (
    Object.keys(options).every((key) => key === "thinkingLevel") &&
    (options.thinkingLevel === undefined ||
      (typeof options.thinkingLevel === "string" &&
        PI_THINKING_LEVEL_OPTIONS.includes(options.thinkingLevel as never)))
  );
}

export function projectScopePayloadForEvent(event: OrchestrationEvent): unknown {
  if (event.type === "thread.deleted" && event.payload.projectId !== undefined) {
    return { projectId: event.payload.projectId };
  }
  return {
    ...(event.payload as Record<string, unknown>),
    ...(event.aggregateKind === "project"
      ? { projectId: event.aggregateId }
      : event.aggregateKind === "thread"
        ? { threadId: event.aggregateId }
        : {}),
  };
}

export function authorizeProjectScopedRpc(input: {
  readonly method: string;
  readonly payload: unknown;
  readonly scope: ProjectScope;
  readonly query: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getActiveProjectByWorkspaceRoot" | "getShellSnapshot"
  >;
}): Effect.Effect<boolean> {
  if (input.scope === undefined) return Effect.succeed(true);
  if (SCOPE_DENIED_METHODS.has(input.method)) return Effect.succeed(false);
  if (
    (input.method.startsWith("provider.") &&
      input.method !== "provider.getComposerCapabilities") ||
    input.method.startsWith("device.")
  ) {
    return Effect.succeed(false);
  }
  if (SCOPE_FILTERED_GLOBAL_METHODS.has(input.method)) return Effect.succeed(true);
  const scope = input.scope;
  const payload = scopedPayload(input.method, input.payload);
  const threadIsAllowed = (threadId: string) =>
    input.query.getThreadShellById(threadId as never).pipe(
      Effect.map((thread) => Option.isSome(thread) && scope.has(thread.value.projectId)),
      Effect.orElseSucceed(() => false),
    );
  return Effect.gen(function* () {
    let located = false;
    const projectId = stringField(payload, "projectId");
    if (projectId !== undefined) {
      located = true;
      if (!scope.has(projectId as ProjectId)) return false;
    }

    const threadId = stringField(payload, "threadId");
    const commandType = stringField(payload, "type");
    if (
      (commandType === "thread.create" ||
        commandType === "thread.fork.create" ||
        commandType === "thread.meta.update" ||
        commandType === "thread.turn.start" ||
        commandType === "thread.message.edit-and-resend") &&
      payload &&
      typeof payload === "object" &&
      !hasSafeScopedModelConfiguration(payload as Record<string, unknown>)
    ) {
      return false;
    }
    if (commandType === "thread.fork.create" && payload && typeof payload === "object") {
      const fork = payload as Record<string, unknown>;
      const sourceThreadId = stringField(fork, "sourceThreadId");
      const sidechatSourceThreadId = stringField(fork, "sidechatSourceThreadId");
      if (
        sourceThreadId === undefined ||
        sidechatSourceThreadId !== sourceThreadId ||
        projectId === undefined
      ) {
        return false;
      }
      const sourceThreadOption = yield* input.query
        .getThreadShellById(sourceThreadId as never)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(sourceThreadOption)) return false;
      const sourceThread = sourceThreadOption.value;
      if (
        !scope.has(sourceThread.projectId) ||
        projectId !== sourceThread.projectId ||
        sourceThread.sidechatSourceThreadId !== null
      ) {
        return false;
      }
      for (const field of [
        "envMode",
        "branch",
        "worktreePath",
        "workingDirectory",
        "associatedWorktreePath",
        "associatedWorktreeBranch",
        "associatedWorktreeRef",
      ] as const) {
        if (fork[field] !== sourceThread[field]) return false;
      }
    }
    if (commandType === "thread.create" || commandType === "thread.meta.update") {
      if (
        ["worktreePath", "workingDirectory", "associatedWorktreePath"].some(
          (field) => stringField(payload, field) !== undefined,
        )
      ) {
        return false;
      }
      const parentThreadId = stringField(payload, "parentThreadId");
      if (parentThreadId !== undefined && !(yield* threadIsAllowed(parentThreadId))) {
        return false;
      }
    }
    if (
      threadId !== undefined &&
      commandType !== "thread.create" &&
      commandType !== "thread.fork.create"
    ) {
      located = true;
      const allowed = yield* threadIsAllowed(threadId);
      if (!allowed) return false;
    }

    if (commandType === "thread.turn.start" && payload && typeof payload === "object") {
      const turnStart = payload as Record<string, unknown>;
      const message = turnStart.message;
      const skills =
        message && typeof message === "object"
          ? (message as Record<string, unknown>).skills
          : undefined;
      if (skills !== undefined && (!Array.isArray(skills) || skills.length > 0)) return false;
      const mentions =
        message && typeof message === "object"
          ? (message as Record<string, unknown>).mentions
          : undefined;
      if (Array.isArray(mentions)) {
        for (const mention of mentions) {
          const mentionPath = stringField(mention, "path");
          if (mentionPath === undefined || !isThreadMentionPath(mentionPath)) continue;
          const mentionedThreadId = threadIdFromThreadMentionPath(mentionPath);
          if (mentionedThreadId === null || !(yield* threadIsAllowed(mentionedThreadId))) {
            return false;
          }
        }
      }
    }

    const cwd =
      stringField(payload, "cwd") ?? stringField(payload, "workspaceRoot");
    if (cwd !== undefined) {
      located = true;
      const allowed = yield* input.query.getActiveProjectByWorkspaceRoot(cwd).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              input.query.getShellSnapshot().pipe(
                Effect.map((snapshot) =>
                  snapshot.threads.some(
                    (thread) =>
                      scope.has(thread.projectId) &&
                      (thread.worktreePath === cwd || thread.workingDirectory === cwd),
                  ),
                ),
              ),
            onSome: (project) => Effect.succeed(scope.has(project.id)),
          }),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (!allowed) return false;
    }

    return located;
  });
}
