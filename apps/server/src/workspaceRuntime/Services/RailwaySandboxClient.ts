import { ServiceMap, type Effect } from "effect";

import type { RailwaySandboxClientError, RailwaySandboxNotFoundError } from "../Errors";

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

/** Why a sandbox exists; selects its lifetime and labels it for operators. */
export type SandboxPurpose = "chat" | "diligence" | "eval";

export interface RailwaySandboxCreateInput {
  readonly operationId: string;
  readonly checkpointName?: string;
  readonly networkIsolation: "PRIVATE" | "ISOLATED";
  readonly idleTimeoutMinutes: number;
  readonly region?: string;
  readonly environment: Readonly<Record<string, string>>;
  /** Defaults to chat. */
  readonly purpose?: SandboxPurpose;
  /** Operator labels such as `thread_id`, `run_id` and `pack_id`; never credentials. */
  readonly labels?: Readonly<Record<string, string>>;
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

/** One file of a bulk write: installed root-owned with `mode` (default 0600), parents created. */
export interface RailwaySandboxBulkWriteEntry {
  readonly path: string;
  readonly data: string | Uint8Array;
  readonly mode?: number;
}

export interface RailwaySandboxFileEntry {
  readonly name: string;
  readonly size: number;
  readonly mode: number;
  readonly isDir: boolean;
  readonly modTime: string;
}

export interface RailwaySandboxDurableProcessInput {
  readonly command: string;
  readonly cwd?: string;
}

export interface RailwaySandboxDurableProcess {
  readonly sessionName: string;
  readonly supervision: "durable" | "attached";
}

export type RailwaySandboxClientFailure = RailwaySandboxClientError | RailwaySandboxNotFoundError;

export interface RailwaySandboxClientShape {
  readonly create: (
    input: RailwaySandboxCreateInput,
  ) => Effect.Effect<RailwaySandboxRecord, RailwaySandboxClientError>;
  readonly checkpoint?: (
    runtimeId: string,
    name: string,
  ) => Effect.Effect<{ readonly id: string; readonly key: string }, RailwaySandboxClientFailure>;
  readonly deleteCheckpoint?: (id: string) => Effect.Effect<void, RailwaySandboxClientFailure>;
  readonly listCheckpoints?: () => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly key: string }>, RailwaySandboxClientFailure
  >;
  readonly connect: (
    runtimeId: string,
  ) => Effect.Effect<RailwaySandboxRecord, RailwaySandboxClientFailure>;
  readonly start?: (runtimeId: string, environment?: Readonly<Record<string, string>>) => Effect.Effect<RailwaySandboxRecord, RailwaySandboxClientFailure>;
  readonly stop?: (runtimeId: string) => Effect.Effect<RailwaySandboxRecord, RailwaySandboxClientFailure>;
  readonly exec: (
    runtimeId: string,
    input: RailwaySandboxExecInput,
  ) => Effect.Effect<RailwaySandboxExecResult, RailwaySandboxClientFailure>;
  readonly writeFile: (
    runtimeId: string,
    input: RailwaySandboxWriteFileInput,
  ) => Effect.Effect<void, RailwaySandboxClientFailure>;
  /** Optional only so lightweight non-Railway fakes do not need filesystem plumbing. */
  readonly readFile?: (
    runtimeId: string,
    path: string,
  ) => Effect.Effect<Uint8Array, RailwaySandboxClientFailure>;
  readonly listFiles?: (
    runtimeId: string,
    path: string,
  ) => Effect.Effect<ReadonlyArray<RailwaySandboxFileEntry>, RailwaySandboxClientFailure>;
  /** Many files in one transfer; same result as `writeFile` for each. */
  readonly writeFiles?: (
    runtimeId: string,
    files: ReadonlyArray<RailwaySandboxBulkWriteEntry>,
  ) => Effect.Effect<void, RailwaySandboxClientFailure>;
  /** Many regular files in one transfer, read as root; missing or unreadable paths are omitted. */
  readonly readFiles?: (
    runtimeId: string,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, RailwaySandboxClientFailure>;
  readonly statFile?: (
    runtimeId: string,
    path: string,
  ) => Effect.Effect<RailwaySandboxFileEntry, RailwaySandboxClientFailure>;
  readonly startDurableProcess: (
    runtimeId: string,
    input: RailwaySandboxDurableProcessInput,
  ) => Effect.Effect<RailwaySandboxDurableProcess, RailwaySandboxClientFailure>;
  readonly stopDurableProcess: (
    runtimeId: string,
    sessionName: string,
  ) => Effect.Effect<void, RailwaySandboxClientFailure>;
  readonly destroy: (runtimeId: string) => Effect.Effect<void, RailwaySandboxClientFailure>;
  readonly findByCreateOperationId: (
    operationId: string,
  ) => Effect.Effect<string | null, RailwaySandboxClientFailure>;
  readonly list: Effect.Effect<ReadonlyArray<RailwaySandboxRecord>, RailwaySandboxClientError>;
}

export class RailwaySandboxClient extends ServiceMap.Service<
  RailwaySandboxClient,
  RailwaySandboxClientShape
>()("synara/workspaceRuntime/Services/RailwaySandboxClient") {}
