import { ServiceMap, type Effect } from "effect";

import type {
  RailwaySandboxClientError,
  RailwaySandboxNotFoundError,
} from "../Errors";

export type RailwaySandboxStatus =
  | "CREATING"
  | "DESTROYING"
  | "RUNNING"
  | "STOPPED"
  | "DESTROYED"
  | "FAILED";

export interface RailwaySandboxRecord {
  readonly id: string;
  readonly status: RailwaySandboxStatus;
  readonly region: string;
}

export interface RailwaySandboxCreateInput {
  readonly networkIsolation: "PRIVATE" | "ISOLATED";
  readonly idleTimeoutMinutes: number;
  readonly region?: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface RailwaySandboxExecInput {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutSeconds?: number;
}

export interface RailwaySandboxExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface RailwaySandboxWriteFileInput {
  readonly path: string;
  readonly data: string | Uint8Array;
  readonly mode?: number;
}

export interface RailwaySandboxDurableProcessInput {
  readonly command: string;
  readonly cwd?: string;
}

export interface RailwaySandboxDurableProcess {
  readonly sessionName: string;
  readonly supervision: "durable" | "attached";
}

export type RailwaySandboxClientFailure =
  | RailwaySandboxClientError
  | RailwaySandboxNotFoundError;

export interface RailwaySandboxClientShape {
  readonly create: (
    input: RailwaySandboxCreateInput,
  ) => Effect.Effect<RailwaySandboxRecord, RailwaySandboxClientError>;
  readonly connect: (
    runtimeId: string,
  ) => Effect.Effect<RailwaySandboxRecord, RailwaySandboxClientFailure>;
  readonly exec: (
    runtimeId: string,
    input: RailwaySandboxExecInput,
  ) => Effect.Effect<RailwaySandboxExecResult, RailwaySandboxClientFailure>;
  readonly writeFile: (
    runtimeId: string,
    input: RailwaySandboxWriteFileInput,
  ) => Effect.Effect<void, RailwaySandboxClientFailure>;
  readonly startDurableProcess: (
    runtimeId: string,
    input: RailwaySandboxDurableProcessInput,
  ) => Effect.Effect<RailwaySandboxDurableProcess, RailwaySandboxClientFailure>;
  readonly stopDurableProcess: (
    runtimeId: string,
    sessionName: string,
  ) => Effect.Effect<void, RailwaySandboxClientFailure>;
  readonly destroy: (
    runtimeId: string,
  ) => Effect.Effect<void, RailwaySandboxClientFailure>;
  readonly list: Effect.Effect<ReadonlyArray<RailwaySandboxRecord>, RailwaySandboxClientError>;
}

export class RailwaySandboxClient extends ServiceMap.Service<
  RailwaySandboxClient,
  RailwaySandboxClientShape
>()("synara/workspaceRuntime/Services/RailwaySandboxClient") {}
