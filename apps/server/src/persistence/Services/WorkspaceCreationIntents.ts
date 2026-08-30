import { ServiceMap, type Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface WorkspaceCreationIntent {
  readonly operationId: string;
  readonly runtimeId: string | null;
  readonly createdAt: string;
}

export interface WorkspaceCreationIntentRepositoryShape {
  readonly put: (input: {
    readonly operationId: string;
    readonly createdAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly bindRuntime: (input: {
    readonly operationId: string;
    readonly runtimeId: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly remove: (operationId: string) => Effect.Effect<void, PersistenceSqlError>;
  readonly list: () => Effect.Effect<ReadonlyArray<WorkspaceCreationIntent>, PersistenceSqlError>;
}

export class WorkspaceCreationIntentRepository extends ServiceMap.Service<
  WorkspaceCreationIntentRepository,
  WorkspaceCreationIntentRepositoryShape
>()("synara/persistence/Services/WorkspaceCreationIntentRepository") {}
