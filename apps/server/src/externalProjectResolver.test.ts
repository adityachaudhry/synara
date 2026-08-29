import { CommandId, ProjectId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";

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
  it.effect("cannot be preempted through the client project and command ID surface", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const resolver = yield* ExternalProjectResolver;
      const repository = yield* ProjectionProjectRepository;
      const externalKey = "host-company:preempted";
      const formerlyDerivedProjectId = ProjectId.makeUnsafe(
        "external-bbba9db2c16bb05907bc4ee6caf8b95d",
      );

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(
          "server:external-project:bbba9db2c16bb05907bc4ee6caf8b95d8da1252b5efb93efe53de5738e375ac7",
        ),
        projectId: formerlyDerivedProjectId,
        title: "Client preemption attempt",
        workspaceRoot: "/tmp/client-preemption-attempt",
        createdAt: "2026-08-29T20:00:00.000Z",
      });

      const resolvedProjectId = yield* resolver.resolveExternalProject({
        externalKey,
        name: "Server-owned project",
        repositoryBinding,
      });

      assert.notStrictEqual(resolvedProjectId, formerlyDerivedProjectId);
      const clientProject = Option.getOrThrow(
        yield* repository.getById({ projectId: formerlyDerivedProjectId }),
      );
      assert.strictEqual(clientProject.externalKey, null);
      const resolvedProject = Option.getOrThrow(
        yield* repository.getByExternalKey({ externalKey }),
      );
      assert.strictEqual(resolvedProject.projectId, resolvedProjectId);
      assert.deepStrictEqual(resolvedProject.repositoryBinding, repositoryBinding);
    }),
  );

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

  it.effect("lets one of two concurrent bindings win without orphaning the loser", () =>
    Effect.gen(function* () {
      const resolver = yield* ExternalProjectResolver;
      const repository = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;
      const externalKey = "host-company:binding-race";
      const bindings = [
        repositoryBinding,
        { ...repositoryBinding, path: "companies/race-other" },
      ] as const;

      const outcomes = yield* Effect.all(
        bindings.map((binding) =>
          Effect.result(
            resolver.resolveExternalProject({
              externalKey,
              name: "Binding race",
              repositoryBinding: binding,
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(
        outcomes.filter((outcome) => outcome._tag === "Success").length,
        1,
      );
      assert.strictEqual(
        outcomes.filter((outcome) => outcome._tag === "Failure").length,
        1,
      );
      const winnerIndex = outcomes.findIndex((outcome) => outcome._tag === "Success");
      const loserIndex = outcomes.findIndex((outcome) => outcome._tag === "Failure");
      assert.notStrictEqual(winnerIndex, -1);
      assert.notStrictEqual(loserIndex, -1);
      const winner = outcomes[winnerIndex]!;
      const loser = outcomes[loserIndex]!;
      assert.strictEqual(winner._tag, "Success");
      assert.strictEqual(loser._tag, "Failure");
      if (winner._tag !== "Success" || loser._tag !== "Failure") return;
      assert.strictEqual(loser.failure._tag, "ExternalProjectBindingMismatchError");

      const stored = Option.getOrThrow(yield* repository.getByExternalKey({ externalKey }));
      assert.strictEqual(stored.projectId, winner.success);
      assert.deepStrictEqual(stored.repositoryBinding, bindings[winnerIndex]);

      const eventRows = yield* sql<{ readonly projectId: string }>`
        SELECT stream_id AS "projectId"
        FROM orchestration_events
        WHERE event_type = 'project.created'
          AND json_extract(payload_json, '$.externalKey') = ${externalKey}
      `;
      assert.deepStrictEqual(eventRows, [{ projectId: winner.success }]);
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

  it.effect("rejects a mismatched retry after soft deletion without rebinding identity", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const resolver = yield* ExternalProjectResolver;
      const repository = yield* ProjectionProjectRepository;
      const externalKey = "host-company:deleted-mismatch";
      const projectId = yield* resolver.resolveExternalProject({
        externalKey,
        name: "Deleted project",
        repositoryBinding,
      });
      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.makeUnsafe("delete-external-project-for-mismatch-test"),
        projectId,
      });
      const deleted = Option.getOrThrow(
        yield* repository.getByExternalKey({ externalKey }),
      );
      assert.isNotNull(deleted.deletedAt);

      const mismatch = yield* Effect.result(
        resolver.resolveExternalProject({
          externalKey,
          name: "Replacement attempt",
          repositoryBinding: { ...repositoryBinding, path: "companies/replacement" },
        }),
      );
      assert.strictEqual(mismatch._tag, "Failure");
      if (mismatch._tag === "Failure") {
        assert.strictEqual(mismatch.failure._tag, "ExternalProjectBindingMismatchError");
      }

      const preserved = Option.getOrThrow(
        yield* repository.getByExternalKey({ externalKey }),
      );
      assert.strictEqual(preserved.projectId, projectId);
      assert.deepStrictEqual(preserved.repositoryBinding, repositoryBinding);
      assert.strictEqual(preserved.deletedAt, deleted.deletedAt);
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
