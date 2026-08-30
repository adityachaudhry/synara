import type {
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

function stringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
  if (SCOPE_FILTERED_GLOBAL_METHODS.has(input.method)) return Effect.succeed(true);

  const projectId = stringField(input.payload, "projectId");
  if (projectId !== undefined && !input.scope.has(projectId as ProjectId)) {
    return Effect.succeed(false);
  }

  const threadId = stringField(input.payload, "threadId");
  const commandType = stringField(input.payload, "type");
  if (threadId !== undefined && commandType !== "thread.create") {
    return input.query.getThreadShellById(threadId as never).pipe(
      Effect.map((thread) => Option.isSome(thread) && input.scope!.has(thread.value.projectId)),
      Effect.orElseSucceed(() => false),
    );
  }
  if (projectId !== undefined) return Effect.succeed(true);

  const cwd =
    stringField(input.payload, "cwd") ?? stringField(input.payload, "workspaceRoot");
  if (cwd !== undefined) {
    return input.query.getActiveProjectByWorkspaceRoot(cwd).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            input.query.getShellSnapshot().pipe(
              Effect.map((snapshot) =>
                snapshot.threads.some(
                  (thread) =>
                    input.scope!.has(thread.projectId) &&
                    (thread.worktreePath === cwd || thread.workingDirectory === cwd),
                ),
              ),
            ),
          onSome: (project) => Effect.succeed(input.scope!.has(project.id)),
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
  }

  return Effect.succeed(false);
}
