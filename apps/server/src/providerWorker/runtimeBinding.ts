import { ProjectRepositoryBinding } from "@synara/contracts";
import { Schema } from "effect";

export const ProviderWorkerRuntimeBinding = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeKind: Schema.Literals(["railway-sandbox-pi", "docker-pi"]),
  threadId: Schema.optional(Schema.String),
  workspace: Schema.Struct({
    runtimeKind: Schema.Literals(["railway-sandbox", "docker-container"]),
    runtimeId: Schema.String,
    creationOperationId: Schema.optional(Schema.String),
    capacityKey: Schema.optional(Schema.String),
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
  processSupervision: Schema.optional(Schema.Literals(["durable", "attached"])),
  cwd: Schema.String,
  homeDir: Schema.String,
  repositoryCheckout: Schema.optional(
    Schema.Struct({
      binding: ProjectRepositoryBinding,
      commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
      checkoutMode: Schema.Literals(["partial", "shallow"]),
    }),
  ),
});

export type ProviderWorkerRuntimeBinding = typeof ProviderWorkerRuntimeBinding.Type;

export function decodeProviderWorkerRuntimeBinding(value: unknown) {
  const result = Schema.decodeUnknownExit(ProviderWorkerRuntimeBinding)(value);
  if (result._tag !== "Success") return undefined;
  const binding = result.value;
  if (binding.workspace.capacityKey !== undefined || binding.threadId === undefined) {
    return binding;
  }
  return {
    ...binding,
    workspace: {
      ...binding.workspace,
      capacityKey: `${binding.threadId}:${binding.workspace.lifecycleGeneration}`,
    },
  };
}
