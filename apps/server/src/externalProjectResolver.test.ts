import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "./config.ts";
import {
  ExternalProjectResolver,
  makeExternalProjectResolverLive,
} from "./externalProjectResolver.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionProjectRepositoryLive } from "./persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "./persistence/Services/ProjectionProjects.ts";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";

const policy = {
  allowedOrigins: ["https://git.example.com"],
  allowedOwners: ["acme-platform"],
} as const;

const repositoryBinding = {
  kind: "git-subdirectory" as const,
  origin: "https://git.example.com",
  owner: "acme-platform",
  repository: "company-data",
  ref: "main",
  path: "companies/cue-cloud",
};

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-external-project-resolver-test-",
}).pipe(Layer.provide(NodeServices.layer));
const baseLayer = Layer.mergeAll(SqlitePersistenceMemory, configLayer, NodeServices.layer);
const orchestrationLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(baseLayer),
);
const projectRepositoryLayer = ProjectionProjectRepositoryLive.pipe(
  Layer.provideMerge(baseLayer),
);
const layer = it.layer(
  makeExternalProjectResolverLive(policy).pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectRepositoryLayer),
    Layer.provideMerge(baseLayer),
  ),
);

layer("ExternalProjectResolver", (it) => {
  it.effect("resolves concurrent retries to one durable project", () =>
    Effect.gen(function* () {
      const resolver = yield* ExternalProjectResolver;
      const repository = yield* ProjectionProjectRepository;
      const input = {
        externalKey: "host-company:123",
        name: "Cue Cloud",
        repositoryBinding,
      };

      const projectIds = yield* Effect.all(
        Array.from({ length: 8 }, () => resolver.resolveExternalProject(input)),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(new Set(projectIds).size, 1);

      const row = Option.getOrThrow(
        yield* repository.getByExternalKey({ externalKey: input.externalKey }),
      );
      assert.strictEqual(row.projectId, projectIds[0]);
      assert.strictEqual(row.externalKey, input.externalKey);
      assert.deepStrictEqual(row.repositoryBinding, repositoryBinding);
    }),
  );

  it.effect("rejects rebinding an external key and preserves the original coordinates", () =>
    Effect.gen(function* () {
      const resolver = yield* ExternalProjectResolver;
      const repository = yield* ProjectionProjectRepository;
      const externalKey = "host-company:mismatch";
      const projectId = yield* resolver.resolveExternalProject({
        externalKey,
        name: "Original",
        repositoryBinding,
      });

      const mismatch = yield* Effect.result(
        resolver.resolveExternalProject({
          externalKey,
          name: "Changed",
          repositoryBinding: { ...repositoryBinding, path: "companies/other" },
        }),
      );
      assert.strictEqual(mismatch._tag, "Failure");
      if (mismatch._tag === "Failure") {
        assert.strictEqual(mismatch.failure._tag, "ExternalProjectBindingMismatchError");
      }

      const stored = Option.getOrThrow(yield* repository.getByExternalKey({ externalKey }));
      assert.strictEqual(stored.projectId, projectId);
      assert.deepStrictEqual(stored.repositoryBinding, repositoryBinding);
    }),
  );

  it.effect("runs repository admission before creating a project", () =>
    Effect.gen(function* () {
      const resolver = yield* ExternalProjectResolver;
      const repository = yield* ProjectionProjectRepository;
      const externalKey = "host-company:unapproved";

      const rejected = yield* Effect.result(
        resolver.resolveExternalProject({
          externalKey,
          name: "Unapproved",
          repositoryBinding: { ...repositoryBinding, origin: "https://evil.example.com" },
        }),
      );
      assert.strictEqual(rejected._tag, "Failure");
      if (rejected._tag === "Failure") {
        assert.strictEqual(rejected.failure._tag, "RepositoryBindingAdmissionError");
      }
      assert.isTrue(Option.isNone(yield* repository.getByExternalKey({ externalKey })));
    }),
  );
});
