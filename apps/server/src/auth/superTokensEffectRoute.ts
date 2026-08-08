import { DateTime, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../config";
import { shouldRejectAuthMutationOrigin } from "../trustedOrigins";
import { SessionCredentialService } from "./Services/SessionCredentialService";
import { SuperTokensAuth } from "./Services/SuperTokensAuth";
import { deriveAuthClientMetadata } from "./utils";

export const superTokensEffectRouteLayer = HttpRouter.add(
  "*",
  "/api/supertokens/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    const config = yield* ServerConfig;
    const superTokens = yield* SuperTokensAuth;

    if (!superTokens.enabled) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const isCookieExchange =
      request.method === "POST" && url.pathname === "/api/supertokens/exchange";
    const isBearerExchange =
      request.method === "POST" && url.pathname === "/api/supertokens/exchange/bearer";
    if (isCookieExchange || isBearerExchange) {
      if (
        shouldRejectAuthMutationOrigin({
          rawOrigin: request.headers.origin,
          requestOrigin: url.origin,
          config,
          credentialSource: "cookie",
        })
      ) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Trusted request origin required." },
          { status: 403 },
        );
      }

      const identity = yield* superTokens.verifyRequestSession(request);
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        method: isBearerExchange ? "bearer-session-token" : "browser-session-cookie",
        subject: identity.email,
        role: "owner",
        client: deriveAuthClientMetadata({
          headers: request.headers,
          remoteAddress: request.remoteAddress ?? null,
        }),
      });
      if (isBearerExchange) {
        return HttpServerResponse.jsonUnsafe({
          authenticated: true,
          role: "owner",
          subject: identity.email,
          sessionMethod: "bearer-session-token",
          expiresAt: DateTime.toUtc(issued.expiresAt),
          sessionToken: issued.token,
        });
      }
      const response = HttpServerResponse.jsonUnsafe({
        authenticated: true,
        role: "owner",
        subject: identity.email,
        expiresAt: DateTime.toUtc(issued.expiresAt),
      });
      return HttpServerResponse.setCookiesUnsafe(response, [
        ...identity.responseCookies,
        [
          sessions.cookieName,
          issued.token,
          {
            expires: DateTime.toDate(issued.expiresAt),
            httpOnly: true,
            path: "/",
            sameSite: "lax",
            secure: config.publicUrl !== undefined,
          },
        ],
      ]);
    }

    return yield* superTokens.handleApiRequest(request);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: error instanceof Error ? error.message : "Authentication failed." },
          {
            status:
              typeof (error as { readonly status?: unknown }).status === "number"
                ? (error as { readonly status: number }).status
                : 500,
          },
        ),
      ),
    ),
  ),
);
