import { describe, expect, it } from "vitest";

import { planWorkerCheckpointPreparation } from "./workerCheckpointPreparation";

describe("planWorkerCheckpointPreparation", () => {
  it("reuses the exact digest checkpoint instead of deleting and rebuilding it", () => {
    expect(
      planWorkerCheckpointPreparation(
        [
          { id: "checkpoint-old", key: "synara-provider-worker-old" },
          { id: "checkpoint-exact", key: "synara-provider-worker-deadbeef" },
        ],
        "synara-provider-worker-deadbeef",
      ),
    ).toEqual({
      kind: "reuse",
      checkpoint: { id: "checkpoint-exact", key: "synara-provider-worker-deadbeef" },
    });
  });

  it("creates a digest checkpoint when the exact worker artifact is absent", () => {
    expect(
      planWorkerCheckpointPreparation(
        [{ id: "checkpoint-old", key: "synara-provider-worker-old" }],
        "synara-provider-worker-deadbeef",
      ),
    ).toEqual({ kind: "create" });
  });
});
