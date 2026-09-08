import { Data } from "effect";

export class RailwaySandboxClientError extends Data.TaggedError("RailwaySandboxClientError")<{
  readonly operation: string;
  readonly detail: string;
  readonly runtimeId?: string;
  readonly cause?: unknown;
}> {}

export class RailwaySandboxNotFoundError extends Data.TaggedError(
  "RailwaySandboxNotFoundError",
)<{
  readonly operation: string;
  readonly runtimeId: string;
  readonly cause?: unknown;
}> {}

export class WorkspaceRuntimeError extends Data.TaggedError("WorkspaceRuntimeError")<{
  readonly operation: string;
  readonly detail: string;
  readonly runtimeId?: string;
  /** Set only for an authoritative missing or terminal runtime, never a transport failure. */
  readonly unavailable?: boolean;
  readonly cause?: unknown;
}> {}
