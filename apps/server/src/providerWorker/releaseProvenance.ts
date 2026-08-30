import { PROVIDER_WORKER_PROTOCOL_VERSION } from "@synara/contracts";

import { getReleaseProvenance, SYNARA_PROTOCOL_VERSION } from "../releaseProvenance";

export function getProviderWorkerReleaseProvenance(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (SYNARA_PROTOCOL_VERSION !== PROVIDER_WORKER_PROTOCOL_VERSION) {
    throw new Error("Provider worker and Synara release protocol versions do not match.");
  }
  return getReleaseProvenance(environment);
}
