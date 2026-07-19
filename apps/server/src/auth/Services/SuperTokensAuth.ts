import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";
import type { Cookies, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export type EffectCookieTuple = readonly [
  name: string,
  value: string,
  options?: Cookies.Cookie["options"],
];

export class SuperTokensAuthError extends Data.TaggedError("SuperTokensAuthError")<{
  readonly message: string;
  readonly status: 400 | 401 | 403 | 404 | 500 | 503;
  readonly cause?: unknown;
}> {}

export interface VerifiedSuperTokensIdentity {
  readonly email: string;
  readonly responseCookies: ReadonlyArray<EffectCookieTuple>;
}

export interface SuperTokensAuthShape {
  readonly enabled: boolean;
  readonly handleApiRequest: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, SuperTokensAuthError>;
  readonly verifyRequestSession: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<VerifiedSuperTokensIdentity, SuperTokensAuthError>;
  readonly revokeRequestSession: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<ReadonlyArray<EffectCookieTuple>, never>;
}

export class SuperTokensAuth extends ServiceMap.Service<SuperTokensAuth, SuperTokensAuthShape>()(
  "synara/auth/Services/SuperTokensAuth",
) {}
