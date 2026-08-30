import { createHmac, timingSafeEqual } from "node:crypto";

import { AuthSessionId, ProjectId } from "@synara/contracts";
import { Clock, Data, DateTime, Effect, Ref, Schema } from "effect";

const MAX_EXTERNAL_SESSION_TTL_MS = 15 * 60 * 1_000;
const ASSERTION_KEYS = new Set([
  "subject",
  "email",
  "allowedProjectIds",
  "expiresAt",
  "nonce",
]);

const ExternalIdentityAssertion = Schema.Struct({
  subject: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)),
  email: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(320),
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  ),
  allowedProjectIds: Schema.Array(ProjectId),
  expiresAt: Schema.DateTimeUtcFromString,
  nonce: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(8), Schema.isMaxLength(256)),
});

export class ExternalIdentityError extends Data.TaggedError("ExternalIdentityError")<{
  readonly message: string;
  readonly status: 400 | 401 | 409 | 500;
  readonly cause?: unknown;
}> {}

export interface ExternalIdentitySessionIssueInput {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly email: string;
  readonly allowedProjectIds: ReadonlyArray<ProjectId>;
  readonly expiresAt: DateTime.DateTime;
}

export interface ExternalIdentityExchangeShape<A> {
  readonly exchange: (input: {
    readonly authorization?: string;
    readonly payload: unknown;
  }) => Effect.Effect<A, ExternalIdentityError>;
}

function safeSecretEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function authorizeExternalServiceRequest(
  secret: string | undefined,
  authorization: string | undefined,
): boolean {
  const expected = secret?.trim();
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length).trim();
  return supplied.length > 0 && safeSecretEqual(expected, supplied);
}

function rejectUnexpectedIdentityFields(payload: unknown): Effect.Effect<void, ExternalIdentityError> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return Effect.void;
  const unexpected = Object.keys(payload).filter((key) => !ASSERTION_KEYS.has(key));
  return unexpected.length === 0
    ? Effect.void
    : Effect.fail(
        new ExternalIdentityError({
          message: "External identity assertions may not contain repository coordinates or other fields.",
          status: 400,
        }),
      );
}

export const makeExternalIdentityExchange = Effect.fn(function* <A>(input: {
  readonly secret: string | undefined;
  readonly issueSession: (
    assertion: ExternalIdentitySessionIssueInput,
  ) => Effect.Effect<A, unknown>;
}) {
  const usedNonces = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const exchange: ExternalIdentityExchangeShape<A>["exchange"] = (request) =>
    Effect.gen(function* () {
      if (!authorizeExternalServiceRequest(input.secret, request.authorization)) {
        return yield* new ExternalIdentityError({ message: "Unauthorized.", status: 401 });
      }
      yield* rejectUnexpectedIdentityFields(request.payload);
      const assertion = yield* Schema.decodeUnknownEffect(ExternalIdentityAssertion)(
        request.payload,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ExternalIdentityError({
              message: "Invalid external identity assertion.",
              status: 400,
              cause,
            }),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const expiresAtMillis = DateTime.toEpochMillis(assertion.expiresAt);
      if (expiresAtMillis <= now || expiresAtMillis - now > MAX_EXTERNAL_SESSION_TTL_MS) {
        return yield* new ExternalIdentityError({
          message: "External identity assertion is expired or exceeds the maximum lifetime.",
          status: 400,
        });
      }
      const replayed = yield* Ref.modify(usedNonces, (current) => {
        const next = new Map<string, number>();
        for (const [nonce, expiry] of current) if (expiry > now) next.set(nonce, expiry);
        if (next.has(assertion.nonce)) return [true, next] as const;
        next.set(assertion.nonce, expiresAtMillis);
        return [false, next] as const;
      });
      if (replayed) {
        return yield* new ExternalIdentityError({
          message: "External identity assertion nonce was already used.",
          status: 409,
        });
      }
      return yield* input
        .issueSession({
          sessionId: AuthSessionId.makeUnsafe(
            `external:${createHmac("sha256", input.secret?.trim() ?? "")
              .update(assertion.nonce)
              .digest("hex")}`,
          ),
          subject: assertion.subject,
          email: assertion.email,
          allowedProjectIds: Array.from(new Set(assertion.allowedProjectIds)),
          expiresAt: assertion.expiresAt,
        })
        .pipe(
          Effect.mapError((cause) => {
            const replayed =
              cause !== null &&
              typeof cause === "object" &&
              "status" in cause &&
              cause.status === 409;
            return new ExternalIdentityError({
              message: replayed
                ? "External identity assertion nonce was already used."
                : "Failed to issue external identity session.",
              status: replayed ? 409 : 500,
              cause,
            });
          }),
        );
    });

  return { exchange } satisfies ExternalIdentityExchangeShape<A>;
});
