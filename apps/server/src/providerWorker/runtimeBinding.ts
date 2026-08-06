import { ProjectRepositoryBinding } from "@synara/contracts";
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
    baseSource: Schema.optional(Schema.Literals(["checkpoint", "clean"])),
  }),
  fence: Schema.Struct({
    sandboxId: Schema.String.check(Schema.isUUID(undefined)),
    workerId: Schema.String.check(Schema.isUUID(undefined)),
    lifecycleGeneration: Schema.String,
  }),
  durableSessionName: Schema.String,
  processSupervision: Schema.optional(Schema.Literals(["durable", "attached"])),
  cwd: Schema.String,
  homeDir: Schema.String,
  repositoryCheckout: Schema.optional(
    Schema.Struct({
      binding: ProjectRepositoryBinding,
      commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
      checkoutMode: Schema.optional(Schema.Literals(["partial", "shallow"])),
    }),
  ),
});

export type ProviderWorkerRuntimeBinding = typeof ProviderWorkerRuntimeBinding.Type;

export function decodeProviderWorkerRuntimeBinding(value: unknown) {
  const result = Schema.decodeUnknownExit(ProviderWorkerRuntimeBinding)(value);
  return result._tag === "Success" ? result.value : undefined;
}
