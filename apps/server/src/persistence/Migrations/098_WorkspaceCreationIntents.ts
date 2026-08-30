import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_creation_intents (
      operation_id TEXT PRIMARY KEY NOT NULL,
      runtime_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
});
