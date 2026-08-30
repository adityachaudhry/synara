import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { WorkspaceCreationIntentRepository } from "../Services/WorkspaceCreationIntents.ts";
import { WorkspaceCreationIntentRepositoryLive } from "./WorkspaceCreationIntents.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  WorkspaceCreationIntentRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkspaceCreationIntentRepository", (it) => {
  it.effect("persists credential-free create ownership until adoption or cleanup", () =>
    Effect.gen(function* () {
      const repository = yield* WorkspaceCreationIntentRepository;
      yield* repository.put({
        operationId: "11111111-1111-4111-8111-111111111111",
        createdAt: "2026-08-29T18:00:00.000Z",
      });

      assert.deepStrictEqual(yield* repository.list(), [
        {
          operationId: "11111111-1111-4111-8111-111111111111",
          runtimeId: null,
          createdAt: "2026-08-29T18:00:00.000Z",
        },
      ]);

      const duplicate = yield* repository
        .put({
          operationId: "11111111-1111-4111-8111-111111111111",
          createdAt: "2026-08-29T18:00:01.000Z",
        })
        .pipe(Effect.result);
      assert.strictEqual(duplicate._tag, "Failure");

      yield* repository.bindRuntime({
        operationId: "11111111-1111-4111-8111-111111111111",
        runtimeId: "sandbox-1",
      });
      assert.deepStrictEqual(yield* repository.list(), [
        {
          operationId: "11111111-1111-4111-8111-111111111111",
          runtimeId: "sandbox-1",
          createdAt: "2026-08-29T18:00:00.000Z",
        },
      ]);

      yield* repository.remove("11111111-1111-4111-8111-111111111111");
      assert.deepStrictEqual(yield* repository.list(), []);
    }),
  );
});

it("survives a controller database-layer restart", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-workspace-intents-"));
  const dbPath = path.join(tempDir, "state.sqlite");
  const makeLayer = () =>
    WorkspaceCreationIntentRepositoryLive.pipe(
      Layer.provide(
        makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkspaceCreationIntentRepository;
        yield* repository.put({
          operationId: "22222222-2222-4222-8222-222222222222",
          createdAt: "2026-08-29T18:01:00.000Z",
        });
      }).pipe(Effect.provide(makeLayer())),
    );

    const afterRestart = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkspaceCreationIntentRepository;
        return yield* repository.list();
      }).pipe(Effect.provide(makeLayer())),
    );
    assert.deepStrictEqual(afterRestart, [
      {
        operationId: "22222222-2222-4222-8222-222222222222",
        runtimeId: null,
        createdAt: "2026-08-29T18:01:00.000Z",
      },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
