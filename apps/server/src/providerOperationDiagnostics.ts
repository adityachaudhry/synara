import { Cause, Effect, Exit, References } from "effect";

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
      }));
    return yield* log("provider.operation.started").pipe(
      Effect.andThen(effect),
      Effect.onExit((exit) => log("provider.operation.finished", {
        durationMs: Math.round(performance.now() - startedAt),
        outcome: Exit.isSuccess(exit) ? "success" :
          Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed",
      })),
    );
  }).pipe(Effect.withSpan(`provider.${operation}`, { attributes: identifiers }));
