/**
 * Product usage events for Glasswing (`POST /internal/usage-events`), through the same internal API
 * client and service token as the other `/internal/*` calls. Fire-and-forget: one retry, never
 * awaited by a turn. Glasswing dedupes on `dedupe_key`, so a retry after a lost response is safe.
 */
import { logEvent } from "../controllerMetrics.ts";
import { ArtifactApiError, artifactApiClient } from "../providerWorker/artifactPublisher.ts";

let endpointMissingLogged = false;

export interface UsageEvent {
  readonly dedupe_key: string;
  readonly name: string;
  readonly occurred_at: string;
  readonly actor_email: string;
  readonly actor_subject: string;
  readonly company_id: string;
  readonly thread_id: string;
  readonly app_version: string;
  readonly props: Record<string, unknown>;
}

export function sendUsageEvent(event: UsageEvent) {
  let api: ReturnType<typeof artifactApiClient>;
  try {
    api = artifactApiClient();
  } catch {
    return;
  }
  if (!api) return;
  const post = () => api(`/internal/usage-events`, { events: [event] }, { timeoutMs: 10_000 }).then(() => undefined, (cause: unknown) => {
    // A 2xx without a JSON body is still delivered.
    if (cause instanceof SyntaxError) return undefined;
    throw cause;
  });
  void post().catch(async (cause: unknown) => {
    if (cause instanceof ArtifactApiError && cause.status === 404) {
      if (!endpointMissingLogged) {
        endpointMissingLogged = true;
        logEvent("warn", "usage.endpoint-missing", { name: event.name });
      }
      return;
    }
    if (cause instanceof ArtifactApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 429) {
      logEvent("warn", "usage.event-rejected", { name: event.name, status: cause.status });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000).unref());
    await post().catch((again: unknown) =>
      logEvent("warn", "usage.event-failed", { name: event.name, message: String(again).slice(0, 200) }));
  });
}
