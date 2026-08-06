import { createHash } from "node:crypto";

const CHECKPOINT_DIGEST_PREFIX_LENGTH = 24;

export function workerArtifactDigest(artifact: Uint8Array): string {
  return createHash("sha256").update(artifact).digest("hex");
}

export function workerCheckpointName(digest: string): string {
  return `synara-provider-worker-${digest.slice(0, CHECKPOINT_DIGEST_PREFIX_LENGTH)}`;
}
