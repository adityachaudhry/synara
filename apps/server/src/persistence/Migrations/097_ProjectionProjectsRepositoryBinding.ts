import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_projects')
  `;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("repository_binding_json")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN repository_binding_json TEXT`;
  }
  if (!names.has("external_key")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN external_key TEXT`;
  }
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS projection_projects_external_key_unique
    ON projection_projects(external_key)
    WHERE external_key IS NOT NULL
  `;
});
