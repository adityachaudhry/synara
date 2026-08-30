import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@synara/contracts";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config";
import { ExternalProjectResolver } from "./externalProjectResolver";
import { externalApiEffectRouteLayer, versionEffectRouteLayer } from "./http";
import { ProjectionProjectRepository } from "./persistence/Services/ProjectionProjects";

const projectId = ProjectId.makeUnsafe("external-project-1");
const binding = {
  kind: "git-subdirectory" as const,
  origin: "https://git.example.com",
  owner: "acme",
  repository: "company-data",
  ref: "main",
  path: "companies/example",
};

async function withServer(run: (origin: string) => Promise<void>) {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let server: http.Server | null = null;
  try {
    const services = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, {
            externalAuthSecret: "shared-secret",
          } as ServerConfigShape),
          Layer.succeed(ExternalProjectResolver, {
            resolveExternalProject: () => Effect.succeed(projectId),
          }),
          Layer.succeed(ProjectionProjectRepository, {
            getById: () =>
              Effect.succeed(
                Option.some({ projectId, externalKey: "glasswing:example", repositoryBinding: binding }),
              ),
          } as never),
          NodeServices.layer,
        ),
        scope,
      ),
    );
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              server = http.createServer();
              return server;
            },
            { port: 0, host: "127.0.0.1" },
          );
          yield* httpServer.serve(
            yield* HttpRouter.toHttpEffect(
              Layer.merge(externalApiEffectRouteLayer, versionEffectRouteLayer),
            ),
          );
        }).pipe(Effect.provideServices(services)),
        scope,
      ),
    );
    const address = (server as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Expected server address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("external API routes", () => {
  it("protects project resolution and returns only canonical identity and binding metadata", async () => {
    await withServer(async (origin) => {
      expect(
        (await fetch(`${origin}/api/external/projects/resolve`, { method: "POST" })).status,
      ).toBe(401);
      const response = await fetch(`${origin}/api/external/projects/resolve`, {
        method: "POST",
        headers: {
          Authorization: "Bearer shared-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ externalKey: "glasswing:example" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        projectId,
        repositoryBinding: binding,
      });
    });
  });

  it("reports release, commit, and protocol provenance", async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/version`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        release: expect.any(String),
        commit: expect.any(String),
        protocolVersion: 1,
      });
    });
  });
});
