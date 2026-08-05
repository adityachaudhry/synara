import { Data } from "effect";

export class ProviderWorkerBrokerError extends Data.TaggedError("ProviderWorkerBrokerError")<{
  readonly operation: string;
  readonly detail: string;
  readonly sandboxId?: string;
  readonly cause?: unknown;
}> {}

export class ProviderWorkerAuthError extends Data.TaggedError("ProviderWorkerAuthError")<{
  readonly operation: "authorize";
  readonly detail: string;
  readonly sandboxId: string;
}> {}

export class ProviderWorkerTransportError extends Data.TaggedError("ProviderWorkerTransportError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}
