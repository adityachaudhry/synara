import { createHash } from "node:crypto";

import { isWorkspaceRelativePathSafe } from "@synara/shared/path";

export const PROVIDER_PERSISTENCE_OUTBOX_ROOT = "/workspace/.synara/outbox";
export const MAX_PROVIDER_PERSISTENCE_CANDIDATES = 100;
export const MAX_PROVIDER_PERSISTENCE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PROVIDER_PERSISTENCE_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_PROVIDER_PERSISTENCE_DEPTH = 8;

export type ProviderPersistenceSource = "outbox" | "checkout";

export interface ProviderPersistenceCandidateSelection {
  readonly source: ProviderPersistenceSource;
  readonly path: string;
  readonly sha256: string;
}

export interface ProviderPersistenceCandidate extends ProviderPersistenceCandidateSelection {
  readonly destinationPath: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

export interface ProviderPersistenceCandidateList {
  readonly runtimeId: string;
  readonly lifecycleGeneration: string;
  readonly entries: ReadonlyArray<ProviderPersistenceCandidate>;
}

export interface ProviderPersistenceFile extends ProviderPersistenceCandidate {
  readonly bytes: Uint8Array;
}

const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".cache",
  ".venv",
  "__pycache__",
  "cache",
  "node_modules",
]);

const CREDENTIAL_LIKE_NAMES = new Set([
  ".env",
  ".env.local",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "private_key",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

export function isProviderPersistencePathSafe(value: string): boolean {
  if (!isWorkspaceRelativePathSafe(value) || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => {
    const lowered = segment.toLowerCase();
    return (
      !segment.startsWith(".") &&
      !FORBIDDEN_SEGMENTS.has(lowered) &&
      !CREDENTIAL_LIKE_NAMES.has(lowered)
    );
  });
}

export function providerPersistenceSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function providerPersistenceSelectionKey(
  selection: ProviderPersistenceCandidateSelection,
): string {
  return `${selection.source}\0${selection.path}`;
}
