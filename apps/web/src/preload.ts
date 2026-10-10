// FILE: preload.ts
// Purpose: Loads the code of the views an embedded workspace opens on, ahead of
// mounting it, for a host that expects to show one soon.

import { createMemoryHistory } from "@tanstack/react-router";

import { warmHostShellSnapshotDecoder } from "./hostShellSnapshot";
import { getRouter } from "./router";

let preload: Promise<void> | null = null;

/**
 * Loads the project feed's and a thread's code without mounting anything, and
 * compiles the decoder for a host's shell snapshot. Best effort and once per page:
 * mounting the app does whatever is still missing.
 */
export function preloadSynaraApp(): Promise<void> {
  preload ??= (async () => {
    warmHostShellSnapshotDecoder();
    const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
    await Promise.all([
      router.preloadRoute({ to: "/" }),
      router.preloadRoute({ to: "/$threadId", params: { threadId: "chunk-preload" } }),
    ]);
  })().catch(() => undefined);
  return preload;
}
