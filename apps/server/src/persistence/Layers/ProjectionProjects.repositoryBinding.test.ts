import { ProjectId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";

const layer = it.layer(
  ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionProjectRepository repository identity", (it) => {
  it.effect("round-trips a canonical repository binding and stable external key", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionProjectRepository;
      const row = {
        projectId: ProjectId.makeUnsafe("project-bound"),
        kind: "project" as const,
        title: "Bound",
        workspaceRoot: "/tmp/bound",
        repositoryBinding: {
          kind: "git-subdirectory" as const,
          origin: "https://git.example.com",
          owner: "acme-platform",
          repository: "company-data",
          ref: "main",
          path: "companies/cue-cloud",
        },
        externalKey: "host-company:123",
        defaultModelSelection: null,
        scripts: [],
        isPinned: false,
        spaceId: null,
        createdAt: "2026-08-29T12:00:00.000Z",
        updatedAt: "2026-08-29T12:00:00.000Z",
        deletedAt: null,
      };

      yield* repository.upsert(row);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getById({ projectId: row.projectId })),
        row,
      );
      assert.deepStrictEqual(yield* repository.listAll(), [row]);
    }),
  );

  it.effect("keeps ordinary projects without repository identity unchanged", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionProjectRepository;
      const projectId = ProjectId.makeUnsafe("project-local");
      yield* repository.upsert({
        projectId,
        kind: "project",
        title: "Local",
        workspaceRoot: "/tmp/local",
        repositoryBinding: null,
        externalKey: null,
        defaultModelSelection: null,
        scripts: [],
        isPinned: false,
        spaceId: null,
        createdAt: "2026-08-29T12:00:00.000Z",
        updatedAt: "2026-08-29T12:00:00.000Z",
        deletedAt: null,
      });

      const stored = Option.getOrThrow(yield* repository.getById({ projectId }));
      assert.strictEqual(stored.repositoryBinding, null);
      assert.strictEqual(stored.externalKey, null);
    }),
  );
});
