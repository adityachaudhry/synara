import { createHash } from "node:crypto";
import path from "node:path";

import {
  CommandId,
  ExternalProjectKey,
  ProjectId,
  type ProjectRepositoryBinding,
  TrimmedNonEmptyString,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";

import { ServerConfig } from "./config.ts";
import {
  admitRepositoryBinding,
  type RepositoryBindingAdmissionError,
  type RepositoryBindingAdmissionPolicy,
} from "./repositoryBindingAdmission.ts";
import type { OrchestrationDispatchError } from "./orchestration/Errors.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionRepositoryError } from "./persistence/Errors.ts";
import { ProjectionProjectRepository } from "./persistence/Services/ProjectionProjects.ts";

const ResolveExternalProjectInput = Schema.Struct({
  externalKey: ExternalProjectKey,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  repositoryBinding: Schema.Unknown,
});

export interface ResolveExternalProjectInput {
  readonly externalKey: string;
  readonly name: string;
  readonly repositoryBinding: unknown;
}

export class ExternalProjectResolveValidationError extends Schema.TaggedErrorClass<ExternalProjectResolveValidationError>()(
  "ExternalProjectResolveValidationError",
  { issue: Schema.String },
) {}

export class ExternalProjectBindingMismatchError extends Schema.TaggedErrorClass<ExternalProjectBindingMismatchError>()(
  "ExternalProjectBindingMismatchError",
  {
    externalKey: ExternalProjectKey,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `External project '${this.externalKey}' is already bound to different repository coordinates.`;
  }
}

type ExternalProjectResolverError =
  | ExternalProjectResolveValidationError
  | ExternalProjectBindingMismatchError
  | RepositoryBindingAdmissionError
  | OrchestrationDispatchError
  | ProjectionRepositoryError;

export interface ExternalProjectResolverShape {
  readonly resolveExternalProject: (
    input: ResolveExternalProjectInput,
  ) => Effect.Effect<ProjectId, ExternalProjectResolverError>;
}

export class ExternalProjectResolver extends ServiceMap.Service<
  ExternalProjectResolver,
  ExternalProjectResolverShape
>()("synara/externalProjectResolver/ExternalProjectResolver") {}

function bindingsEqual(
  left: ProjectRepositoryBinding | null,
  right: ProjectRepositoryBinding,
): boolean {
  return (
    left !== null &&
    left.kind === right.kind &&
    left.origin === right.origin &&
    left.owner === right.owner &&
    left.repository === right.repository &&
    left.ref === right.ref &&
    left.path === right.path
  );
}

export const makeExternalProjectResolverLive = (
  policy: RepositoryBindingAdmissionPolicy,
): Layer.Layer<
  ExternalProjectResolver,
  never,
  OrchestrationEngineService | ProjectionProjectRepository | ServerConfig
> =>
  Layer.effect(
    ExternalProjectResolver,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projects = yield* ProjectionProjectRepository;
      const config = yield* ServerConfig;

      const resolveExisting = (
        externalKey: string,
        repositoryBinding: ProjectRepositoryBinding,
      ) =>
        projects.getByExternalKey({ externalKey }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed<Option.Option<ProjectId>>(Option.none()),
              onSome: (project) =>
                bindingsEqual(project.repositoryBinding, repositoryBinding)
                  ? Effect.succeed(Option.some(project.projectId))
                  : Effect.fail(
                      new ExternalProjectBindingMismatchError({
                        externalKey,
                        projectId: project.projectId,
                      }),
                    ),
            }),
          ),
        );

      const resolveExternalProject: ExternalProjectResolverShape["resolveExternalProject"] = (
        input,
      ) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(ResolveExternalProjectInput)(input).pipe(
            Effect.mapError(
              (error) => new ExternalProjectResolveValidationError({ issue: String(error) }),
            ),
          );
          const repositoryBinding = yield* admitRepositoryBinding(
            decoded.repositoryBinding,
            policy,
          );
          const existing = yield* resolveExisting(decoded.externalKey, repositoryBinding);
          if (Option.isSome(existing)) return existing.value;

          const digest = createHash("sha256").update(decoded.externalKey).digest("hex");
          const projectId = ProjectId.makeUnsafe(`external-${digest.slice(0, 32)}`);
          const commandId = CommandId.makeUnsafe(`server:external-project:${digest}`);
          const dispatch = engine.dispatch({
            type: "project.external.resolve",
            commandId,
            projectId,
            externalKey: decoded.externalKey,
            title: decoded.name,
            workspaceRoot: path.join(config.worktreesDir, "external-projects", digest),
            repositoryBinding,
            createdAt: new Date().toISOString(),
          });

          const result = yield* Effect.result(dispatch);
          if (result._tag === "Success") return projectId;

          const raced = yield* resolveExisting(decoded.externalKey, repositoryBinding);
          if (Option.isSome(raced)) return raced.value;
          return yield* Effect.fail(result.failure);
        });

      return { resolveExternalProject } satisfies ExternalProjectResolverShape;
    }),
  );
