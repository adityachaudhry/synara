// FILE: glasswingRuntimeSetup.ts
// Purpose: Adapt durable provider runtime telemetry into transient Glasswing setup UX.
// Layer: Web presentation state

import type { OrchestrationThreadActivity, RuntimeStage } from "@synara/contracts";

const GLASSWING_RUNTIME_STAGE_LABELS = {
  "sandbox.create": "Preparing secure workspace",
  "workspace.checkout": "Syncing project files",
  "worker.files": "Restoring agent runtime",
  "worker.start": "Starting agent runtime",
  "worker.connect": "Connecting agent",
  "session.start": "Opening agent session",
  "turn.dispatch": "Starting your request",
} as const satisfies Record<RuntimeStage, string>;

const RUNTIME_STAGES = new Set<RuntimeStage>(
  Object.keys(GLASSWING_RUNTIME_STAGE_LABELS) as RuntimeStage[],
);

export interface GlasswingRuntimeSetupProgress {
  readonly stage: RuntimeStage;
  readonly label: string;
  readonly startedAt: string;
}

export interface GlasswingTranscriptWorkingPresentation {
  readonly isWorking: boolean;
  readonly label: string | undefined;
}

interface ParsedRuntimeStageActivity {
  readonly lifecycleGeneration: string;
  readonly stage: RuntimeStage;
  readonly state: "started" | "completed" | "failed";
  readonly createdAt: string;
}

function parseRuntimeStageActivity(
  activity: OrchestrationThreadActivity,
): ParsedRuntimeStageActivity | null {
  if (
    activity.kind !== "runtime.stage" ||
    !activity.payload ||
    typeof activity.payload !== "object"
  ) {
    return null;
  }

  const payload = activity.payload as Record<string, unknown>;
  const lifecycleGeneration = payload.lifecycleGeneration;
  const stage = payload.stage;
  const state = payload.state;
  if (
    typeof lifecycleGeneration !== "string" ||
    lifecycleGeneration.length === 0 ||
    typeof stage !== "string" ||
    !RUNTIME_STAGES.has(stage as RuntimeStage) ||
    (state !== "started" && state !== "completed" && state !== "failed")
  ) {
    return null;
  }

  return {
    lifecycleGeneration,
    stage: stage as RuntimeStage,
    state,
    createdAt: activity.createdAt,
  };
}

export function deriveGlasswingRuntimeSetupProgress(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly hasSubmittedMessage: boolean;
}): GlasswingRuntimeSetupProgress | null {
  if (!input.hasSubmittedMessage) return null;

  const parsed = input.activities.flatMap((activity) => {
    const stage = parseRuntimeStageActivity(activity);
    return stage === null ? [] : [stage];
  });
  const latestLifecycleGeneration = parsed.at(-1)?.lifecycleGeneration;
  if (!latestLifecycleGeneration) return null;

  const unresolved = new Map<
    RuntimeStage,
    GlasswingRuntimeSetupProgress & { readonly order: number }
  >();
  for (let index = 0; index < parsed.length; index += 1) {
    const activity = parsed[index]!;
    if (activity.lifecycleGeneration !== latestLifecycleGeneration) continue;
    if (activity.state === "started") {
      unresolved.set(activity.stage, {
        stage: activity.stage,
        label: GLASSWING_RUNTIME_STAGE_LABELS[activity.stage],
        startedAt: activity.createdAt,
        order: index,
      });
    } else {
      unresolved.delete(activity.stage);
    }
  }

  let latest: (GlasswingRuntimeSetupProgress & { readonly order: number }) | null = null;
  for (const progress of unresolved.values()) {
    if (latest === null || progress.order > latest.order) latest = progress;
  }
  if (latest === null) return null;

  return { stage: latest.stage, label: latest.label, startedAt: latest.startedAt };
}

export function resolveGlasswingTranscriptWorkingPresentation(input: {
  readonly enabled: boolean;
  readonly hasLiveTurn: boolean;
  readonly hasSubmittedMessage: boolean;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly latestTurnSettled?: boolean;
  readonly setupProgress: GlasswingRuntimeSetupProgress | null;
}): GlasswingTranscriptWorkingPresentation {
  if (!input.enabled || input.hasLiveTurn) {
    return { isWorking: input.hasLiveTurn, label: undefined };
  }

  const isWorking =
    input.hasSubmittedMessage &&
    (input.isSendBusy ||
      input.isConnecting ||
      (input.setupProgress !== null && input.latestTurnSettled !== true));
  return {
    isWorking,
    label: isWorking ? (input.setupProgress?.label ?? "Working…") : undefined,
  };
}
