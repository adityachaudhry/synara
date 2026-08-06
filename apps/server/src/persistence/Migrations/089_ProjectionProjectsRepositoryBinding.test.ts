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

layer("089_ProjectionProjectsRepositoryBinding", (it) => {
  it.effect("adds nullable repository binding storage without changing existing projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 88 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, default_model_selection_json,
          scripts_json, is_pinned, space_id, created_at, updated_at, deleted_at
        ) VALUES (
          'project-existing', 'project', 'Existing', '/tmp/existing', NULL,
          '[]', 0, NULL, '2026-08-06T12:00:00.000Z', '2026-08-06T12:00:00.000Z', NULL
        )
      `;

      assert.notInclude(yield* columnNames(sql), "repository_binding_json");
      const executed = yield* runMigrations({ toMigrationInclusive: 89 });

      assert.deepStrictEqual(executed, [[89, "ProjectionProjectsRepositoryBinding"]]);
      assert.include(yield* columnNames(sql), "repository_binding_json");
      const rows = yield* sql<{ readonly binding: string | null }>`
        SELECT repository_binding_json AS binding
        FROM projection_projects
        WHERE project_id = 'project-existing'
      `;
      assert.deepStrictEqual(rows, [{ binding: null }]);
    }),
  );

  it.effect("is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runMigrations();
      assert.strictEqual(
        (yield* columnNames(sql)).filter((name) => name === "repository_binding_json").length,
        1,
      );
    }),
  );
});
