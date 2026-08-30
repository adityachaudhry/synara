import { PROVIDER_WORKER_PROTOCOL_VERSION } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { getProviderWorkerReleaseProvenance } from "./providerWorker/releaseProvenance";
import { getReleaseProvenance, SYNARA_PROTOCOL_VERSION } from "./releaseProvenance";

describe("release provenance", () => {
  it("aligns the server and provider worker source commit and protocol", () => {
    const environment = { SYNARA_RELEASE: "0.7.3", SYNARA_COMMIT: "abc123" };
    expect(getProviderWorkerReleaseProvenance(environment)).toEqual(
      getReleaseProvenance(environment),
    );
    expect(SYNARA_PROTOCOL_VERSION).toBe(PROVIDER_WORKER_PROTOCOL_VERSION);
  });
});
