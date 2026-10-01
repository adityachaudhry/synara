import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { makeRailwaySandboxClient } from "../workspaceRuntime/Layers/RailwaySandboxClient.ts";
import { resolveRailwaySandboxRuntimeConfig } from "../workspaceRuntime/railwaySandboxConfig.ts";
import { WorkspaceRuntimeError } from "../workspaceRuntime/Errors.ts";
import { archiveWorkspaceCheckpoint, type WorkspaceArchiveRuntime } from "./workspaceArchive.ts";
import type { ProviderWorkspaceCheckpoint } from "./workspaceCheckpointStore.ts";

/** One-time private-state import. The original Railway disk and snapshot remain intact. */
export const importRailwayWorkspace = Effect.fn(function* (saved: ProviderWorkspaceCheckpoint) {
  if (!saved.checkpoint || saved.binding.workspace.runtimeKind !== "railway-sandbox") throw new Error("Expected a Railway checkpoint.");
  const config = resolveRailwaySandboxRuntimeConfig({
    token: process.env.SYNARA_RAILWAY_SANDBOX_TOKEN ?? "",
    environmentId: process.env.SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID ?? "",
    authType: process.env.SYNARA_RAILWAY_SANDBOX_AUTH_TYPE ?? "project-token",
    idleTimeoutMinutes: "10", maxActiveSandboxes: "100",
  });
  if (!config.enabled) throw new Error("Railway credentials are required to import existing thread state.");
  const client = makeRailwaySandboxClient(config);
  const error = (cause: unknown) => new WorkspaceRuntimeError({ operation: "workspace.import", detail: "Railway workspace import failed.", cause });
  const runtime: WorkspaceArchiveRuntime = {
    create: (input) => client.create({ operationId: randomUUID(), ...(input.checkpointName ? { checkpointName: input.checkpointName } : {}),
      networkIsolation: "ISOLATED", idleTimeoutMinutes: 10, environment: {},
    }).pipe(Effect.map((record) => ({ runtimeKind: "railway-sandbox" as const, runtimeId: record.id,
      lifecycleGeneration: input.lifecycleGeneration, status: "running" as const, region: record.region })), Effect.mapError(error)),
    exec: (binding, input) => client.exec(binding.runtimeId, input).pipe(Effect.mapError(error)),
    writeFile: (binding, input) => client.writeFile(binding.runtimeId, input).pipe(Effect.mapError(error)),
    destroy: (binding) => client.destroy(binding.runtimeId).pipe(Effect.mapError(error)),
  };
  return yield* archiveWorkspaceCheckpoint({ workspaceRuntime: runtime, binding: saved.binding, checkpoint: saved.checkpoint });
});
