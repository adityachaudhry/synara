import path from "node:path";

import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  ProjectId,
} from "@synara/contracts";
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
]);

const SCOPE_DENIED_METHODS = new Set([
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

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function scopedPayload(method: string, payload: unknown): unknown {
  if (method !== "orchestration.dispatchCommand" || !payload || typeof payload !== "object") {
    return payload;
  }
  return (payload as Record<string, unknown>).command;
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
  if (SCOPE_FILTERED_GLOBAL_METHODS.has(input.method)) return Effect.succeed(true);
  const scope = input.scope;
  const payload = scopedPayload(input.method, input.payload);
  return Effect.gen(function* () {
    if (input.method === "filesystem.browse") {
      const cwd = stringField(payload, "cwd");
      const partialPath = stringField(payload, "partialPath");
      if (
        cwd === undefined ||
        partialPath === undefined ||
        partialPath === "~" ||
        partialPath.startsWith("~/") ||
        partialPath.startsWith("~\\") ||
        (/^[A-Za-z]:[\\/]/u.test(partialPath) && process.platform !== "win32")
      ) {
        return false;
      }
      const target = path.isAbsolute(partialPath)
        ? partialPath
        : partialPath === "." ||
            partialPath === ".." ||
            partialPath.startsWith("./") ||
            partialPath.startsWith("../") ||
            partialPath.startsWith(".\\") ||
            partialPath.startsWith("..\\")
          ? path.resolve(cwd, partialPath)
          : undefined;
      if (target === undefined || !isPathInside(cwd, target)) return false;
    }

    let located = false;
    const projectId = stringField(payload, "projectId");
    if (projectId !== undefined) {
      located = true;
      if (!scope.has(projectId as ProjectId)) return false;
    }

    const threadId = stringField(payload, "threadId");
    const commandType = stringField(payload, "type");
    if (threadId !== undefined && commandType !== "thread.create") {
      located = true;
      const allowed = yield* input.query.getThreadShellById(threadId as never).pipe(
        Effect.map((thread) => Option.isSome(thread) && scope.has(thread.value.projectId)),
        Effect.orElseSucceed(() => false),
      );
      if (!allowed) return false;
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
