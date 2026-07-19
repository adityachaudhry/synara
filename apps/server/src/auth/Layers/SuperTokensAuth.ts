import { Effect, FileSystem, Layer } from "effect";
import {
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import SuperTokens from "supertokens-node";
import {
  CollectingResponse,
  PreParsedRequest,
  middleware,
} from "supertokens-node/framework/custom";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import type { HTTPMethod } from "supertokens-node/types";

import { ServerConfig, type SuperTokensRuntimeConfig } from "../../config";
import {
  SuperTokensAuth,
  SuperTokensAuthError,
  type EffectCookieTuple,
  type SuperTokensAuthShape,
} from "../Services/SuperTokensAuth";

const AUTH_BODY_MAX_BYTES = 16 * 1024;
export const ALLOWED_EMAIL_DOMAIN = "glasswing.vc";

let initialized = false;

export function isAllowedGlasswingEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at > 0 && normalized.slice(at + 1) === ALLOWED_EMAIL_DOMAIN;
}

export function toEffectCookieTuples(
  cookies: ReadonlyArray<CollectingResponse["cookies"][number]>,
): ReadonlyArray<EffectCookieTuple> {
  return cookies.map(
    (cookie) =>
      [
        cookie.key,
        cookie.value,
        {
          ...(cookie.domain ? { domain: cookie.domain } : {}),
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expires: new Date(cookie.expires),
          path: cookie.path,
          sameSite: cookie.sameSite,
        },
      ] as const,
  );
}

function initialize(config: Extract<SuperTokensRuntimeConfig, { readonly enabled: true }>): void {
  if (initialized) return;
  SuperTokens.init({
    framework: "custom",
    supertokens: { connectionURI: config.coreUrl, apiKey: config.apiKey },
    appInfo: {
      appName: "Glasswing",
      apiDomain: config.apiDomain,
      websiteDomain: config.websiteDomain,
      apiBasePath: "/api/supertokens",
      websiteBasePath: "/auth",
    },
    recipeList: [
      Passwordless.init({
        contactMethod: "EMAIL",
        flowType: "USER_INPUT_CODE",
        override: {
          apis: (original) => ({
            ...original,
            createCodePOST: async (input) => {
              const email = "email" in input ? input.email : undefined;
              if (!email || !isAllowedGlasswingEmail(email)) {
                return {
                  status: "GENERAL_ERROR",
                  message: "Access is limited to @glasswing.vc accounts.",
                };
              }
              return original.createCodePOST!(input);
            },
          }),
        },
      }),
      Session.init({ getTokenTransferMethod: () => "cookie" }),
    ],
    isInServerlessEnv: true,
  });
  initialized = true;
}

function toPreParsedRequest(request: HttpServerRequest.HttpServerRequest): PreParsedRequest {
  const url = HttpServerRequest.toURL(request);
  if (!url) throw new Error("Invalid request URL.");
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return new PreParsedRequest({
    url: url.toString(),
    method: request.method as HTTPMethod,
    headers,
    cookies: request.cookies,
    query: Object.fromEntries(url.searchParams.entries()),
    getJSONBody: () =>
      Effect.runPromise(
        request.json.pipe(
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            FileSystem.Size(AUTH_BODY_MAX_BYTES),
          ),
        ),
      ),
    getFormBody: async () => ({}),
  });
}

function collectedResponse(response: CollectingResponse): HttpServerResponse.HttpServerResponse {
  const headers = Object.fromEntries(response.headers.entries());
  const base =
    response.body === undefined
      ? HttpServerResponse.empty({ status: response.statusCode, headers })
      : HttpServerResponse.text(response.body, { status: response.statusCode, headers });
  return HttpServerResponse.setCookiesUnsafe(base, toEffectCookieTuples(response.cookies));
}

function expiredCookies(secure: boolean): ReadonlyArray<EffectCookieTuple> {
  const expires = new Date(0);
  return ["sAccessToken", "sRefreshToken", "sFrontToken", "sAntiCsrf"].map(
    (name) =>
      [
        name,
        "",
        { expires, httpOnly: name !== "sFrontToken", path: "/", sameSite: "lax", secure },
      ] as const,
  );
}

export const SuperTokensAuthLive = Layer.effect(
  SuperTokensAuth,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const superTokensConfig = serverConfig.superTokens ?? { enabled: false as const };
    if (!superTokensConfig.enabled) {
      return {
        enabled: false,
        handleApiRequest: () =>
          Effect.fail(
            new SuperTokensAuthError({ message: "Not Found", status: 404 }),
          ),
        verifyRequestSession: () =>
          Effect.fail(
            new SuperTokensAuthError({
              message: "SuperTokens authentication is not enabled.",
              status: 503,
            }),
          ),
        revokeRequestSession: () => Effect.succeed([]),
      } satisfies SuperTokensAuthShape;
    }

    const config = superTokensConfig;
    yield* Effect.sync(() => initialize(config));
    const handle = middleware();

    return {
      enabled: true,
      handleApiRequest: (request) =>
        Effect.tryPromise({
          try: async () => {
            const parsed = toPreParsedRequest(request);
            const response = new CollectingResponse();
            const result = await handle(parsed, response);
            if (result.error) throw result.error;
            if (!result.handled) {
              throw new SuperTokensAuthError({ message: "Not Found", status: 404 });
            }
            return collectedResponse(response);
          },
          catch: (cause) =>
            cause instanceof SuperTokensAuthError
              ? cause
              : new SuperTokensAuthError({
                  message: "SuperTokens request failed.",
                  status: 500,
                  cause,
                }),
        }),
      verifyRequestSession: (request) =>
        Effect.tryPromise({
          try: async () => {
            const parsed = toPreParsedRequest(request);
            const response = new CollectingResponse();
            const session = await Session.getSession(parsed, response);
            const user = await SuperTokens.getUser(session.getUserId());
            const email = user?.emails.find(isAllowedGlasswingEmail)?.trim().toLowerCase();
            if (!email) {
              throw new SuperTokensAuthError({
                message: "A verified Glasswing email is required.",
                status: 403,
              });
            }
            return { email, responseCookies: toEffectCookieTuples(response.cookies) };
          },
          catch: (cause) =>
            cause instanceof SuperTokensAuthError
              ? cause
              : new SuperTokensAuthError({
                  message: "Authentication required.",
                  status: 401,
                  cause,
                }),
        }),
      revokeRequestSession: (request) =>
        Effect.tryPromise({
          try: async () => {
            const parsed = toPreParsedRequest(request);
            const response = new CollectingResponse();
            const session = await Session.getSession(parsed, response, { sessionRequired: false });
            await session?.revokeSession();
            const cookies = toEffectCookieTuples(response.cookies);
            return cookies.length > 0 ? cookies : expiredCookies(config.apiDomain.startsWith("https:"));
          },
          catch: () => expiredCookies(config.apiDomain.startsWith("https:")),
        }).pipe(Effect.catch(() => Effect.succeed(expiredCookies(config.apiDomain.startsWith("https:"))))),
    } satisfies SuperTokensAuthShape;
  }),
);
