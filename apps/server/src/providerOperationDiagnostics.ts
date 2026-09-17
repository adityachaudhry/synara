import { Cause, Effect, Exit } from "effect";

// Log both edges: a process crash still leaves the last started operation.
// Only call-site identifiers belong here; never prompts, credentials, or RPC payloads.
export const observeProviderOperation = (
  operation: string,
  identifiers: Readonly<Record<string, string | number>>,
) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const startedAt = performance.now();
    return Effect.logInfo("provider operation started", { operation, ...identifiers }).pipe(
      Effect.andThen(effect),
      Effect.onExit((exit) => Effect.logInfo("provider operation finished", {
        operation,
        ...identifiers,
        durationMs: Math.round(performance.now() - startedAt),
        outcome: Exit.isSuccess(exit) ? "success" :
          Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed",
      })),
      Effect.withSpan(`provider.${operation}`, { attributes: identifiers }),
    );
  });
