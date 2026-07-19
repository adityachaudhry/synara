import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@synara/contracts";
import { DateTime, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../config";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "./Services/SessionCredentialService";
import { SuperTokensAuth, type SuperTokensAuthShape } from "./Services/SuperTokensAuth";
import { superTokensEffectRouteLayer } from "./superTokensEffectRoute";

async function withServer(run: (origin: string) => Promise<void>) {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  const expiresAt = DateTime.addDuration(Effect.runSync(DateTime.now), "30 days");
  const superTokens: SuperTokensAuthShape = {
    enabled: true,
    handleApiRequest: () => Effect.succeed(HttpServerResponse.jsonUnsafe({ status: "OK" })),
    verifyRequestSession: (request) =>
      request.cookies.sAccessToken === "valid"
        ? Effect.succeed({ email: "person@glasswing.vc", responseCookies: [] })
        : Effect.fail({
            _tag: "SuperTokensAuthError",
            message: "Authentication required.",
            status: 401,
          } as const),
    revokeRequestSession: () => Effect.succeed([]),
  };
  const sessions = {
    cookieName: "synara_session",
    issue: () =>
      Effect.succeed({
        sessionId: AuthSessionId.makeUnsafe("11111111-1111-4111-8111-111111111111"),
        token: "synara-token",
        method: "browser-session-cookie" as const,
        role: "owner" as const,
        client: { deviceType: "unknown" as const },
        expiresAt,
      }),
  } as SessionCredentialServiceShape;
  const config = {
    host: "127.0.0.1",
    publicUrl: new URL("https://synara.example.test"),
    superTokens: {
      enabled: true,
      coreUrl: "http://supertokens:3567",
      apiKey: "secret",
      apiDomain: "https://synara.example.test",
      websiteDomain: "https://synara.example.test",
    },
  } as ServerConfigShape;
  try {
    const services = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, config),
          Layer.succeed(SuperTokensAuth, superTokens),
          Layer.succeed(SessionCredentialService, sessions),
          NodeServices.layer,
        ),
        scope,
      ),
    );
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const server = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { host: "127.0.0.1", port: 0 },
          );
          yield* server.serve(yield* HttpRouter.toHttpEffect(superTokensEffectRouteLayer));
        }).pipe(Effect.provideServices(services)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Expected server address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("superTokensEffectRouteLayer", () => {
  it("requires a verified SuperTokens session before issuing an owner cookie", async () => {
    await withServer(async (origin) => {
      const unauthorized = await fetch(`${origin}/api/supertokens/exchange`, {
        method: "POST",
        headers: { Origin: origin },
      });
      expect(unauthorized.status).toBe(401);

      const response = await fetch(`${origin}/api/supertokens/exchange`, {
        method: "POST",
        headers: { Origin: origin, Cookie: "sAccessToken=valid" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([
        expect.stringContaining("synara_session=synara-token"),
      ]);
      expect(await response.json()).toMatchObject({
        authenticated: true,
        role: "owner",
        subject: "person@glasswing.vc",
      });
    });
  });

  it("rejects a cross-origin exchange before issuing a session", async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/supertokens/exchange`, {
        method: "POST",
        headers: {
          Origin: "https://evil.example.test",
          Cookie: "sAccessToken=valid",
        },
      });
      expect(response.status).toBe(403);
    });
  });
});
