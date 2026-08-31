/** Persist authenticated human attribution on projected user messages. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_thread_messages", "author_json"))) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN author_json TEXT
    `;
  }
});
