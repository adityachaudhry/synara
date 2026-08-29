import {
  GitRef,
  type ProjectRepositoryBinding,
  RepositoryIdentifier,
  RepositoryOrigin,
  RepositorySubdirectoryPath,
} from "@synara/contracts";
import { Effect, Schema } from "effect";

const RepositoryBindingField = Schema.Literals([
  "kind",
  "origin",
  "owner",
  "repository",
  "ref",
  "path",
]);

export class RepositoryBindingAdmissionError extends Schema.TaggedErrorClass<RepositoryBindingAdmissionError>()(
  "RepositoryBindingAdmissionError",
  {
    field: RepositoryBindingField,
    reason: Schema.Literals(["invalid", "not-allowed"]),
  },
) {
  override get message(): string {
    return `Repository binding ${this.field} is ${this.reason}.`;
  }
}

export interface RepositoryBindingAdmissionPolicy {
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly allowedOwners: ReadonlyArray<string>;
}

const decodeField = <A>(
  field: typeof RepositoryBindingField.Type,
  schema: Schema.Schema<A>,
  value: unknown,
): Effect.Effect<A, RepositoryBindingAdmissionError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new RepositoryBindingAdmissionError({ field, reason: "invalid" })),
  );

export const admitRepositoryBinding = (
  input: unknown,
  policy: RepositoryBindingAdmissionPolicy,
): Effect.Effect<ProjectRepositoryBinding, RepositoryBindingAdmissionError> =>
  Effect.gen(function* () {
    const candidate =
      typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const kind = yield* decodeField("kind", Schema.Literal("git-subdirectory"), candidate.kind);
    const origin = yield* decodeField("origin", RepositoryOrigin, candidate.origin);
    const owner = yield* decodeField("owner", RepositoryIdentifier, candidate.owner);
    const repository = yield* decodeField(
      "repository",
      RepositoryIdentifier,
      candidate.repository,
    );
    const ref = yield* decodeField("ref", GitRef, candidate.ref);
    const path = yield* decodeField("path", RepositorySubdirectoryPath, candidate.path);

    if (!policy.allowedOrigins.includes(origin)) {
      return yield* new RepositoryBindingAdmissionError({
        field: "origin",
        reason: "not-allowed",
      });
    }
    if (!policy.allowedOwners.includes(owner)) {
      return yield* new RepositoryBindingAdmissionError({
        field: "owner",
        reason: "not-allowed",
      });
    }

    return { kind, origin, owner, repository, ref, path };
  });
