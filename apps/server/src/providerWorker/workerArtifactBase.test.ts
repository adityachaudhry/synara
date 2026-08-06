import { describe, expect, it } from "vitest";

import { workerArtifactDigest, workerCheckpointName } from "./workerArtifactBase";

describe("provider worker artifact base", () => {
  it("derives a deterministic digest-scoped Railway checkpoint name", () => {
    const digest = workerArtifactDigest(new TextEncoder().encode("hello"));

    expect(digest).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(workerCheckpointName(digest)).toBe(
      "synara-provider-worker-2cf24dba5fb0a30e26e83b2a",
    );
  });
});
