import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  WorkspaceCreationIntentRepository,
  type WorkspaceCreationIntentRepositoryShape,
} from "../Services/WorkspaceCreationIntents.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const put: WorkspaceCreationIntentRepositoryShape["put"] = (input) =>
    sql`
      INSERT INTO workspace_creation_intents (operation_id, runtime_id, created_at)
      VALUES (${input.operationId}, NULL, ${input.createdAt})
      ON CONFLICT(operation_id) DO NOTHING
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("WorkspaceCreationIntentRepository.put")),
    );

  const bindRuntime: WorkspaceCreationIntentRepositoryShape["bindRuntime"] = (input) =>
    sql`
      UPDATE workspace_creation_intents
      SET runtime_id = ${input.runtimeId}
      WHERE operation_id = ${input.operationId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("WorkspaceCreationIntentRepository.bindRuntime")),
    );

  const remove: WorkspaceCreationIntentRepositoryShape["remove"] = (operationId) =>
    sql`
      DELETE FROM workspace_creation_intents
      WHERE operation_id = ${operationId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("WorkspaceCreationIntentRepository.remove")),
    );

  const list: WorkspaceCreationIntentRepositoryShape["list"] = () =>
    sql<{
      readonly operationId: string;
      readonly runtimeId: string | null;
      readonly createdAt: string;
    }>`
      SELECT
        operation_id AS "operationId",
        runtime_id AS "runtimeId",
        created_at AS "createdAt"
      FROM workspace_creation_intents
      ORDER BY created_at ASC, operation_id ASC
    `.pipe(
      Effect.mapError(toPersistenceSqlError("WorkspaceCreationIntentRepository.list")),
    );

  return { put, bindRuntime, remove, list } satisfies WorkspaceCreationIntentRepositoryShape;
});

export const WorkspaceCreationIntentRepositoryLive = Layer.effect(
  WorkspaceCreationIntentRepository,
  make,
);
