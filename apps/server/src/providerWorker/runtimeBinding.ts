import { Schema } from "effect";

export const ProviderWorkerRuntimeBinding = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeKind: Schema.Literal("railway-sandbox-pi"),
  workspace: Schema.Struct({
    runtimeKind: Schema.Literal("railway-sandbox"),
    runtimeId: Schema.String,
    lifecycleGeneration: Schema.String,
    status: Schema.Literals([
      "creating",
      "running",
      "stopped",
      "destroying",
      "destroyed",
      "failed",
    ]),
    region: Schema.String,
  }),
  fence: Schema.Struct({
    sandboxId: Schema.String.check(Schema.isUUID(undefined)),
    workerId: Schema.String.check(Schema.isUUID(undefined)),
    lifecycleGeneration: Schema.String,
  }),
  durableSessionName: Schema.String,
  cwd: Schema.String,
  homeDir: Schema.String,
});

export type ProviderWorkerRuntimeBinding = typeof ProviderWorkerRuntimeBinding.Type;

export function decodeProviderWorkerRuntimeBinding(value: unknown) {
  const result = Schema.decodeUnknownExit(ProviderWorkerRuntimeBinding)(value);
  return result._tag === "Success" ? result.value : undefined;
}
