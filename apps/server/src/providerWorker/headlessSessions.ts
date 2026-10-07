import type { ProviderSession } from "@synara/contracts";

/**
 * Session state for headless sandboxes. Their agent loop runs in the controller, so the
 * provisioner asks the durable engine instead of a worker process inside the sandbox.
 */
let source: ((threadId: string | undefined) => ReadonlyArray<ProviderSession>) | undefined;

export function setHeadlessSessionSource(next: typeof source) {
  source = next;
}

export function headlessSessions(threadId: string | undefined): ReadonlyArray<ProviderSession> {
  return source?.(threadId) ?? [];
}

/** Threads whose durable turn continues after a controller restart; startup cleanup must not interrupt them. */
export const resumingDurableThreads = new Set<string>();
