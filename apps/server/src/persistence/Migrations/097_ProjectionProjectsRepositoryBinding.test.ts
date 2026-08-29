import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_projects')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("097_ProjectionProjectsRepositoryBinding", (it) => {
  it.effect("adds nullable repository identity without changing pre-migration projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, default_model_selection_json,
          scripts_json, is_pinned, space_id, created_at, updated_at, deleted_at
        ) VALUES (
          'project-existing', 'project', 'Existing', '/tmp/existing', NULL,
          '[]', 0, NULL, '2026-08-29T12:00:00.000Z', '2026-08-29T12:00:00.000Z', NULL
        )
      `;

      assert.notInclude(yield* columnNames(sql), "repository_binding_json");
      const executed = yield* runMigrations({ toMigrationInclusive: 97 });

      assert.deepStrictEqual(executed, [[97, "ProjectionProjectsRepositoryBinding"]]);
      assert.include(yield* columnNames(sql), "repository_binding_json");
      assert.include(yield* columnNames(sql), "external_key");
      const rows = yield* sql<{
        readonly repositoryBinding: string | null;
        readonly externalKey: string | null;
      }>`
        SELECT
          repository_binding_json AS "repositoryBinding",
          external_key AS "externalKey"
        FROM projection_projects
        WHERE project_id = 'project-existing'
      `;
      assert.deepStrictEqual(rows, [{ repositoryBinding: null, externalKey: null }]);
    }),
  );

  it.effect("enforces one durable project per non-null external key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, external_key, scripts_json,
          created_at, updated_at
        ) VALUES (
          'project-one', 'project', 'One', '/tmp/one', 'host-company:123', '[]',
          '2026-08-29T12:00:00.000Z', '2026-08-29T12:00:00.000Z'
        )
      `;

      const duplicate = yield* Effect.result(sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, external_key, scripts_json,
          created_at, updated_at
        ) VALUES (
          'project-two', 'project', 'Two', '/tmp/two', 'host-company:123', '[]',
          '2026-08-29T12:00:01.000Z', '2026-08-29T12:00:01.000Z'
        )
      `);
      assert.strictEqual(duplicate._tag, "Failure");
    }),
  );
});
