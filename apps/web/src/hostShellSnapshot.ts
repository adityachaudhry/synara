// FILE: hostShellSnapshot.ts
// Purpose: Decodes the shell (projects and thread rows) a host fetched for the app,
// and compiles that decoder ahead of time for a host that preloads the app.

import { OrchestrationShellSnapshot } from "@synara/contracts";
import { Option, Schema } from "effect";

const decode = Schema.decodeUnknownOption(OrchestrationShellSnapshot);

/** The host's copy of the shell, decoded, or null when it is not one. */
export function decodeHostShellSnapshot(value: unknown): OrchestrationShellSnapshot | null {
  if (value === undefined || value === null) return null;
  return Option.getOrNull(decode(value));
}

/**
 * The first decode compiles the decoder for the whole shell schema (~150 ms of main
 * thread on a laptop); a preload pays it while the host page is idle rather than
 * when the workspace opens.
 */
export function warmHostShellSnapshotDecoder(): void {
  decode({
    snapshotSequence: 0,
    spaces: [],
    projects: [],
    threads: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
}
