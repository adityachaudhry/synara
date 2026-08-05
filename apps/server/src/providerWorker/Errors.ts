import { Data } from "effect";

export class ProviderWorkerBrokerError extends Data.TaggedError("ProviderWorkerBrokerError")<{
  readonly operation: string;
  readonly detail: string;
  readonly sandboxId?: string;
  readonly cause?: unknown;
}> {}
