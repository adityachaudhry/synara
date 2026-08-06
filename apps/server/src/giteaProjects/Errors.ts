import { Data } from "effect";

export class GiteaCompanyCatalogError extends Data.TaggedError(
  "GiteaCompanyCatalogError",
)<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}
