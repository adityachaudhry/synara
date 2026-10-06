import { Cause, Effect, Exit, References } from "effect";

// Failures can be wrapped at several boundaries. Keep only fixed categories;
// message/detail/stack and arbitrary remote error fields may contain private data.
const failureTypes = new Set([
  "ProviderAdapterValidationError", "ProviderAdapterRequestError",
  "ProviderAdapterProcessError", "ProviderAdapterSessionNotFoundError",
  "ProviderAdapterSessionClosedError", "ProviderSessionNotFoundError",
  "ProviderValidationError", "ProviderUnsupportedError",
  "ProviderSessionDirectoryPersistenceError", "ProviderWorkerProvisioningError",
  "ProviderWorkerBrokerError", "ProviderWorkerTransportError", "ProviderWorkerAuthError",
  "WorkspaceRuntimeError", "RailwaySandboxClientError", "RailwaySandboxNotFoundError",
]);
const failureStages = new Set([
  "start", "restart", "session.start", "session.start.cleanup", "authorize",
  "request", "request.error", "request.timeout", "worker.response", "register", "connect",
  "session/start", "session/restart", "model/set",
  "workspace.create", "workspace.directory", "workspace.user", "workspace.mutation",
  "workspace.restore", "workspace.restore.coverage", "workspace.archive.capacity",
  "workspace.checkpoint.pending", "repository.checkout", "repository.mount",
  "repository.mount.credentials", "repository.mount.cleanup",
]);

function failureCategories(cause: unknown): Record<string, string | number> {
  const types: string[] = [];
  const stages: string[] = [];
  const fields: Record<string, string | number> = {};
  for (let depth = 0; depth < 4 && cause !== null && typeof cause === "object"; depth++) {
    const error = cause as Record<string, unknown>;
    types.push(typeof error._tag === "string" && failureTypes.has(error._tag) ? error._tag : "unknown");
    const stage = error.operation ?? error.method;
    if (typeof stage === "string" && failureStages.has(stage)) stages.push(stage);
    if (error.regionUnavailable === true) fields.regionUnavailable = 1;
    if (error.unavailable === true) fields.runtimeUnavailable = 1;
    cause = error.cause;
  }
  return { ...fields, failureTypes: types.join(">") || "unknown", failureStages: stages.join(">") || "unknown" };
}

// Log both edges: a crash still leaves the last started operation. Single-line
// records cannot have their fields interleaved by Railway's concurrent log ingest.
// Only identifiers belong here; never prompts, credentials, or RPC payloads.
export const observeProviderOperation = (
  operation: string,
  identifiers: Readonly<Record<string, string | number>>,
) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const annotations = yield* References.CurrentLogAnnotations;
    const span = yield* Effect.currentSpan.pipe(Effect.orElseSucceed(() => undefined));
    const context = {
      ...(typeof annotations.threadId === "string" ? { threadId: annotations.threadId } : {}),
      ...(typeof annotations.eventSequence === "number" ? { eventSequence: annotations.eventSequence } : {}),
      ...identifiers,
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
    };
    const startedAt = performance.now();
    const log = (event: string, result: Record<string, string | number> = {}) =>
      Effect.logInfo(JSON.stringify({
        event, operation, ...context, ...result, timestamp: new Date().toISOString(),
      })).pipe(Effect.provideService(References.CurrentLogAnnotations, {}));
    return yield* log("provider.operation.started").pipe(
      Effect.andThen(effect),
      Effect.onExit((exit) => log("provider.operation.finished", {
        durationMs: Math.round(performance.now() - startedAt),
        outcome: Exit.isSuccess(exit) ? "success" :
          Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed",
        ...(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? failureCategories(Cause.squash(exit.cause)) : {}),
      })),
    );
  }).pipe(Effect.withSpan(`provider.${operation}`, { attributes: identifiers }));
