// FILE: hostShellSnapshot.ts
// Purpose: Decodes the shell (projects and thread rows) a host fetched for the app,
// and compiles that decoder ahead of time for a host that preloads the app.

import { OrchestrationShellSnapshot } from "@synara/contracts";
import { Option, Schema } from "effect";

const decode = Schema.decodeUnknownOption(OrchestrationShellSnapshot);

/** The host's copy of the shell, decoded, or null when it is not one. */
export function decodeHostShellSnapshot(value: unknown): OrchestrationShellSnapshot | null {
  if (value === undefined || value === null) return null;
  const started = performance.now();
  const decoded = Option.getOrNull(decode(value));
  performance.measure("synara:host-shell:decode", { start: started, end: performance.now() });
  return decoded;
}

/**
 * The first decodes compile the decoder for the shell schema (~150 ms of main thread
 * on a laptop, most of it the project and thread row schemas); a preload pays that
 * while the host page is idle rather than when the workspace opens. One empty row of
 * each kind, decoded collecting every issue, visits every field of every row schema.
 * The result is discarded.
 */
export function warmHostShellSnapshotDecoder(): void {
  const started = performance.now();
  decode(
    {
      snapshotSequence: 0,
      spaces: [{}],
      projects: [{}],
      threads: [{}],
      updatedAt: "1970-01-01T00:00:00.000Z",
    },
    { errors: "all" },
  );
  performance.measure("synara:host-shell:warm", { start: started, end: performance.now() });
}
