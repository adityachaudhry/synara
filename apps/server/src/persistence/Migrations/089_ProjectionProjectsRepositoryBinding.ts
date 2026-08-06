import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [column] = yield* sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1
      FROM pragma_table_info('projection_projects')
      WHERE name = 'repository_binding_json'
    ) AS "exists"
  `;
  if (column?.exists !== 1) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN repository_binding_json TEXT
    `;
  }
});
