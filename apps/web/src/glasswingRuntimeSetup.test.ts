import type { OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveGlasswingRuntimeSetupProgress,
  resolveGlasswingTranscriptWorkingPresentation,
} from "./glasswingRuntimeSetup";
import { makeActivity } from "./storeTestFixtures";

function runtimeStage(input: {
  id: string;
  createdAt: string;
  lifecycleGeneration: string;
  stage:
    | "sandbox.create"
    | "workspace.checkout"
    | "worker.files"
    | "worker.start"
    | "worker.connect"
    | "session.start"
    | "turn.dispatch";
  state: "started" | "completed" | "failed";
}): OrchestrationThreadActivity {
  return makeActivity({
    id: input.id,
    createdAt: input.createdAt,
    kind: "runtime.stage",
    summary: "Runtime setup",
    tone: input.state === "failed" ? "error" : "info",
    payload: {
      lifecycleGeneration: input.lifecycleGeneration,
      stage: input.stage,
      state: input.state,
      cold: input.stage !== "turn.dispatch",
    },
  });
}

describe("deriveGlasswingRuntimeSetupProgress", () => {
  it("keeps draft prewarming invisible until the user submits a message", () => {
    const activities = [
      runtimeStage({
        id: "sandbox-started",
        createdAt: "2026-08-09T18:00:00.000Z",
        lifecycleGeneration: "generation-1",
        stage: "sandbox.create",
        state: "started",
      }),
    ];

    expect(
      deriveGlasswingRuntimeSetupProgress({ activities, hasSubmittedMessage: false }),
    ).toBeNull();
  });

  it("presents the current setup phase with provider-neutral copy", () => {
    const activities = [
      runtimeStage({
        id: "worker-connect-started",
        createdAt: "2026-08-09T18:00:03.000Z",
        lifecycleGeneration: "generation-1",
        stage: "worker.connect",
        state: "started",
      }),
    ];

    expect(
      deriveGlasswingRuntimeSetupProgress({ activities, hasSubmittedMessage: true }),
    ).toEqual({
      stage: "worker.connect",
      label: "Connecting agent",
      startedAt: "2026-08-09T18:00:03.000Z",
    });
  });

  it("falls back to an overlapping unresolved phase when the newest phase completes", () => {
    const activities = [
      runtimeStage({
        id: "checkout-started",
        createdAt: "2026-08-09T18:00:01.000Z",
        lifecycleGeneration: "generation-1",
        stage: "workspace.checkout",
        state: "started",
      }),
      runtimeStage({
        id: "files-started",
        createdAt: "2026-08-09T18:00:02.000Z",
        lifecycleGeneration: "generation-1",
        stage: "worker.files",
        state: "started",
      }),
      runtimeStage({
        id: "files-completed",
        createdAt: "2026-08-09T18:00:03.000Z",
        lifecycleGeneration: "generation-1",
        stage: "worker.files",
        state: "completed",
      }),
    ];

    expect(
      deriveGlasswingRuntimeSetupProgress({ activities, hasSubmittedMessage: true }),
    ).toEqual({
      stage: "workspace.checkout",
      label: "Syncing project files",
      startedAt: "2026-08-09T18:00:01.000Z",
    });
  });

  it("settles after the final phase completes or fails", () => {
    const started = runtimeStage({
      id: "session-started",
      createdAt: "2026-08-09T18:00:04.000Z",
      lifecycleGeneration: "generation-1",
      stage: "session.start",
      state: "started",
    });

    for (const state of ["completed", "failed"] as const) {
      expect(
        deriveGlasswingRuntimeSetupProgress({
          activities: [
            started,
            runtimeStage({
              id: `session-${state}`,
              createdAt: "2026-08-09T18:00:05.000Z",
              lifecycleGeneration: "generation-1",
              stage: "session.start",
              state,
            }),
          ],
          hasSubmittedMessage: true,
        }),
      ).toBeNull();
    }
  });

  it("ignores unresolved stages from an older replaced lifecycle", () => {
    const activities = [
      runtimeStage({
        id: "old-worker-started",
        createdAt: "2026-08-09T18:00:01.000Z",
        lifecycleGeneration: "generation-1",
        stage: "worker.start",
        state: "started",
      }),
      runtimeStage({
        id: "new-sandbox-started",
        createdAt: "2026-08-09T18:00:02.000Z",
        lifecycleGeneration: "generation-2",
        stage: "sandbox.create",
        state: "started",
      }),
    ];

    expect(
      deriveGlasswingRuntimeSetupProgress({ activities, hasSubmittedMessage: true }),
    ).toMatchObject({ stage: "sandbox.create", label: "Preparing secure workspace" });
  });
});

describe("resolveGlasswingTranscriptWorkingPresentation", () => {
  it("preserves Synara's existing live-turn-only behavior when Glasswing mode is disabled", () => {
    expect(
      resolveGlasswingTranscriptWorkingPresentation({
        enabled: false,
        hasLiveTurn: false,
        hasSubmittedMessage: true,
        isSendBusy: true,
        isConnecting: true,
        setupProgress: {
          stage: "worker.connect",
          label: "Connecting agent",
          startedAt: "2026-08-09T18:00:03.000Z",
        },
      }),
    ).toEqual({ isWorking: false, label: undefined });
  });

  it("shows generic work immediately and upgrades it to concrete setup progress", () => {
    expect(
      resolveGlasswingTranscriptWorkingPresentation({
        enabled: true,
        hasLiveTurn: false,
        hasSubmittedMessage: true,
        isSendBusy: true,
        isConnecting: false,
        setupProgress: null,
      }),
    ).toEqual({ isWorking: true, label: "Working…" });

    expect(
      resolveGlasswingTranscriptWorkingPresentation({
        enabled: true,
        hasLiveTurn: false,
        hasSubmittedMessage: true,
        isSendBusy: false,
        isConnecting: true,
        setupProgress: {
          stage: "worker.connect",
          label: "Connecting agent",
          startedAt: "2026-08-09T18:00:03.000Z",
        },
      }),
    ).toEqual({ isWorking: true, label: "Connecting agent" });
  });

  it("does not expose background prewarming before a message and yields to a live turn", () => {
    const setupProgress = {
      stage: "worker.connect" as const,
      label: "Connecting agent",
      startedAt: "2026-08-09T18:00:03.000Z",
    };

    expect(
      resolveGlasswingTranscriptWorkingPresentation({
        enabled: true,
        hasLiveTurn: false,
        hasSubmittedMessage: false,
        isSendBusy: false,
        isConnecting: true,
        setupProgress,
      }),
    ).toEqual({ isWorking: false, label: undefined });

    expect(
      resolveGlasswingTranscriptWorkingPresentation({
        enabled: true,
        hasLiveTurn: true,
        hasSubmittedMessage: true,
        isSendBusy: false,
        isConnecting: false,
        setupProgress,
      }),
    ).toEqual({ isWorking: true, label: undefined });
  });

  it("does not revive a settled turn from stale unresolved telemetry", () => {
    expect(
      resolveGlasswingTranscriptWorkingPresentation({
        enabled: true,
        hasLiveTurn: false,
        hasSubmittedMessage: true,
        isSendBusy: false,
        isConnecting: false,
        latestTurnSettled: true,
        setupProgress: {
          stage: "worker.connect",
          label: "Connecting agent",
          startedAt: "2026-08-09T18:00:03.000Z",
        },
      }),
    ).toEqual({ isWorking: false, label: undefined });
  });
});
