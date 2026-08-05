import { ServiceMap, type Effect } from "effect";

import type { WorkspaceRuntimeError } from "../Errors";

export interface WorkspaceRuntimeBinding {
  readonly runtimeKind: "railway-sandbox";
  readonly runtimeId: string;
  readonly lifecycleGeneration: string;
  readonly status:
    | "creating"
    | "running"
    | "stopped"
    | "destroying"
    | "destroyed"
    | "failed";
  readonly region: string;
}

export interface WorkspaceRuntimeInventoryRecord {
  readonly runtimeKind: "railway-sandbox";
  readonly runtimeId: string;
  readonly status: WorkspaceRuntimeBinding["status"];
  readonly region: string;
}

export interface WorkspaceRuntimeCreateInput {
  readonly lifecycleGeneration: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface WorkspaceExecInput {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutSeconds?: number;
}

export interface WorkspaceExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface WorkspaceRuntimeShape {
  readonly create: (
    input: WorkspaceRuntimeCreateInput,
  ) => Effect.Effect<WorkspaceRuntimeBinding, WorkspaceRuntimeError>;
  readonly connect: (
    binding: WorkspaceRuntimeBinding,
  ) => Effect.Effect<WorkspaceRuntimeBinding, WorkspaceRuntimeError>;
  readonly exec: (
    binding: WorkspaceRuntimeBinding,
    input: WorkspaceExecInput,
  ) => Effect.Effect<WorkspaceExecResult, WorkspaceRuntimeError>;
  readonly keepAlive: (
    binding: WorkspaceRuntimeBinding,
  ) => Effect.Effect<void, WorkspaceRuntimeError>;
  readonly destroy: (
    binding: WorkspaceRuntimeBinding,
  ) => Effect.Effect<void, WorkspaceRuntimeError>;
  readonly list: Effect.Effect<ReadonlyArray<WorkspaceRuntimeInventoryRecord>, WorkspaceRuntimeError>;
}

export class WorkspaceRuntime extends ServiceMap.Service<WorkspaceRuntime, WorkspaceRuntimeShape>()(
  "synara/workspaceRuntime/Services/WorkspaceRuntime",
) {}
