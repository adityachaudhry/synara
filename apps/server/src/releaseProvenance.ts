import { WS_PROTOCOL_EPOCH } from "@synara/contracts";

import { version as packageVersion } from "../package.json" with { type: "json" };

export const SYNARA_PROTOCOL_VERSION = WS_PROTOCOL_EPOCH;

export function getReleaseProvenance(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return {
    release: environment.SYNARA_RELEASE?.trim() || packageVersion,
    commit: environment.SYNARA_COMMIT?.trim() || "development",
    protocolVersion: SYNARA_PROTOCOL_VERSION,
  } as const;
}
