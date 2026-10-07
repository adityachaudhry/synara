/**
 * Internal diligence endpoints for the Glasswing API (Railway private network).
 * Authentication: the shared artifact service token, as Synara uses toward Glasswing.
 */
import { timingSafeEqual } from "node:crypto";

import { CommandId, ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { readMcpJsonBody } from "../agentGateway/httpRoute.ts";
import { extractBearerToken } from "../agentGateway/bearerToken.ts";
import { ExternalProjectResolver } from "../externalProjectResolver.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { diligenceRunner, diligenceThreadId, stepLabel, type DiligenceRequest } from "./diligence.ts";

const MAX_PLAN_BYTES = 16 * 1024 * 1024;

/** Only the Railway private network (or a local stack) may reach these routes, even with the token. */
const privateHost = (host: string | undefined) => {
  const name = (host ?? "").toLowerCase().replace(/:\d+$/u, "");
  return name.endsWith(".railway.internal") || name === "localhost" || name === "127.0.0.1" || name === "[::1]";
};

const authorized = (header: string | undefined, host: string | undefined) => {
  if (!privateHost(host)) return false;
  const expected = process.env.GLASSWING_ARTIFACT_SERVICE_TOKEN?.trim();
  const token = extractBearerToken(header);
  if (!expected || !token) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const RUN_TITLES: Record<string, string> = { full: "Full diligence", quick: "Quick read", memo: "Investment memo" };
/** The run thread's opening request, as the analyst would put it; the feed shows it. */
const runRequestText = (plan: DiligenceRequest) => {
  const company = plan.company.name;
  const by = requesterName(plan.requestedBy?.label);
  const started = by ? `, started by ${by}` : "";
  if (plan.mode === "quick") return `Quick read on ${company}${started}: does it earn a full diligence?`;
  if (plan.mode === "memo") return `Investment memo for ${company}${started}, written from its latest diligence.`;
  const steps = plan.plan.steps.map((step) => stepLabel(step).toLowerCase());
  return `Full diligence on ${company}${started}: ${steps.join(", ")}.`;
};

/** "Aditya Chaudhry" stays; "aditya@glasswing.vc" becomes "Aditya". */
const requesterName = (label: string | undefined) => {
  const value = label?.trim();
  if (!value) return undefined;
  if (!value.includes("@")) return value;
  const local = value.split("@")[0]!.split(/[._-]/u)[0]!;
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : undefined;
};

/** The run's top-level thread in the company's project; the run works without it if this fails. */
const ensureRunThread = (plan: DiligenceRequest) => Effect.gen(function* () {
  const threadId = ThreadId.makeUnsafe(diligenceThreadId(plan.runId));
  const snapshots = yield* ProjectionSnapshotQuery;
  if (Option.isSome(yield* snapshots.getThreadShellById(threadId))) return threadId;
  const resolver = yield* ExternalProjectResolver;
  const projectId: ProjectId = yield* resolver.resolveExternalProject({
    externalKey: `glasswing-company:${plan.company.id}`,
    name: plan.company.name,
    repositoryBinding: plan.repository,
  });
  const engine = yield* OrchestrationEngineService;
  const now = new Date();
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`diligence-thread-${plan.runId}`),
    threadId,
    projectId,
    title: `${RUN_TITLES[plan.mode] ?? "Diligence"} · ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}`,
    modelSelection: { provider: "pi", model: "anthropic/claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    creationSource: "diligence_run",
    ...(plan.sourceThreadId ? { sourceThreadId: ThreadId.makeUnsafe(plan.sourceThreadId) } : {}),
    createdAt: now.toISOString(),
  } as never);
  // The run starts with a request in the thread, so the workspace feed lists it like any thread.
  yield* engine.dispatch({
    type: "thread.messages.import",
    commandId: CommandId.makeUnsafe(`diligence-request-${plan.runId}`),
    threadId,
    messages: [{
      messageId: `diligence-request-${plan.runId}`,
      role: "user",
      text: runRequestText(plan),
      author: { subject: "glasswing:diligence", label: "Glasswing" },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }],
    createdAt: now.toISOString(),
  } as never);
  return threadId;
});

const runIdFrom = (url: string, suffix = "") => {
  const match = new URL(url, "http://local").pathname.match(new RegExp(`^/internal/diligence/runs/([0-9a-fA-F-]{8,64})${suffix}$`, "u"));
  return match?.[1];
};

const acceptRoute = HttpRouter.add("POST", "/internal/diligence/runs", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!authorized(request.headers.authorization, request.headers.host)) return json({ error: "unauthorized" }, 401);
  const runner = diligenceRunner();
  if (!runner) return json({ error: "durable diligence is not available on this controller" }, 503);
  const body = yield* readMcpJsonBody(request, MAX_PLAN_BYTES);
  if (body.kind !== "ok") return json({ error: body.kind === "too-large" ? "plan too large" : "invalid JSON" }, body.kind === "too-large" ? 413 : 400);
  const plan = body.body as DiligenceRequest;
  if (!plan?.runId || !plan.company?.slug || !plan.repository?.path || !Array.isArray(plan.plan?.steps) || !plan.plan.steps.length) {
    return json({ error: "runId, company, repository and plan.steps are required" }, 400);
  }
  const threadId = yield* ensureRunThread(plan).pipe(
    Effect.catch((cause) => Effect.sync(() => {
      console.warn(`[diligence] ${JSON.stringify({ event: "thread.create-failed", runId: plan.runId, message: String(cause) })}`);
      return undefined;
    })),
  );
  const result = yield* Effect.tryPromise(() => runner.accept(plan, threadId ? { threadId } : {})).pipe(
    Effect.map((accepted) => json(accepted, 202)),
    Effect.catch((cause) => Effect.succeed(json({ error: String(cause) }, 500))),
  );
  return result;
}));

const cancelRoute = HttpRouter.add("POST", "/internal/diligence/runs/:runId/cancel", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!authorized(request.headers.authorization, request.headers.host)) return json({ error: "unauthorized" }, 401);
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
  if (!authorized(request.headers.authorization, request.headers.host)) return json({ error: "unauthorized" }, 401);
  const runId = runIdFrom(request.url);
  const runner = diligenceRunner();
  if (!runId || !runner) return json({ error: "unknown run" }, 404);
  const status = yield* Effect.promise(() => runner.status(runId));
  return status ? json(status) : json({ error: "unknown run" }, 404);
}));

export const diligenceRouteLayer = Layer.mergeAll(acceptRoute, cancelRoute, statusRoute);
