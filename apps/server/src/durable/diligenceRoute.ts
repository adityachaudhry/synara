/**
 * Internal diligence endpoints for the Glasswing API (Railway private network).
 * Authentication: the shared artifact service token, as Synara uses toward Glasswing.
 */
import { timingSafeEqual } from "node:crypto";

import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { readMcpJsonBody } from "../agentGateway/httpRoute.ts";
import { extractBearerToken } from "../agentGateway/bearerToken.ts";
import { diligenceRunner, type DiligenceRequest } from "./diligence.ts";

const MAX_PLAN_BYTES = 16 * 1024 * 1024;

const authorized = (header: string | undefined) => {
  const expected = process.env.GLASSWING_ARTIFACT_SERVICE_TOKEN?.trim();
  const token = extractBearerToken(header);
  if (!expected || !token) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const runIdFrom = (url: string, suffix = "") => {
  const match = new URL(url, "http://local").pathname.match(new RegExp(`^/internal/diligence/runs/([0-9a-fA-F-]{8,64})${suffix}$`, "u"));
  return match?.[1];
};

const acceptRoute = HttpRouter.add("POST", "/internal/diligence/runs", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!authorized(request.headers.authorization)) return json({ error: "unauthorized" }, 401);
  const runner = diligenceRunner();
  if (!runner) return json({ error: "durable diligence is not available on this controller" }, 503);
  const body = yield* readMcpJsonBody(request, MAX_PLAN_BYTES);
  if (body.kind !== "ok") return json({ error: body.kind === "too-large" ? "plan too large" : "invalid JSON" }, body.kind === "too-large" ? 413 : 400);
  const plan = body.body as DiligenceRequest;
  if (!plan?.runId || !plan.company?.slug || !plan.repository?.path || !Array.isArray(plan.plan?.steps) || !plan.plan.steps.length) {
    return json({ error: "runId, company, repository and plan.steps are required" }, 400);
  }
  const result = yield* Effect.tryPromise(() => runner.accept(plan)).pipe(
    Effect.map((accepted) => json(accepted, 202)),
    Effect.catch((cause) => Effect.succeed(json({ error: String(cause) }, 500))),
  );
  return result;
}));

const cancelRoute = HttpRouter.add("POST", "/internal/diligence/runs/:runId/cancel", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!authorized(request.headers.authorization)) return json({ error: "unauthorized" }, 401);
  const runId = runIdFrom(request.url, "/cancel");
  const runner = diligenceRunner();
  if (!runId || !runner) return json({ error: "unknown run" }, 404);
  return yield* Effect.tryPromise(() => runner.cancel(runId)).pipe(
    Effect.map(() => json({ runId, canceling: true }, 202)),
    Effect.catch((cause) => Effect.succeed(json({ error: String(cause) }, 500))),
  );
}));

const statusRoute = HttpRouter.add("GET", "/internal/diligence/runs/:runId", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!authorized(request.headers.authorization)) return json({ error: "unauthorized" }, 401);
  const runId = runIdFrom(request.url);
  const runner = diligenceRunner();
  if (!runId || !runner) return json({ error: "unknown run" }, 404);
  const status = yield* Effect.promise(() => runner.status(runId));
  return status ? json(status) : json({ error: "unknown run" }, 404);
}));

export const diligenceRouteLayer = Layer.mergeAll(acceptRoute, cancelRoute, statusRoute);
