import { ServiceMap, type Effect } from "effect";

import type { ProviderWorkerProvisioningError } from "../Errors";
import type { ProviderWorkerRuntimeBinding } from "../runtimeBinding";

export interface ProviderWorkerProvisionInput {
  readonly lifecycleGeneration: string;
  readonly cwd?: string;
}

export interface ProviderWorkerProvisionerShape {
  readonly start: (
    input: ProviderWorkerProvisionInput,
  ) => Effect.Effect<ProviderWorkerRuntimeBinding, ProviderWorkerProvisioningError>;
  readonly restart: (
    binding: ProviderWorkerRuntimeBinding,
    input: ProviderWorkerProvisionInput,
  ) => Effect.Effect<ProviderWorkerRuntimeBinding, ProviderWorkerProvisioningError>;
  readonly stop: (
    binding: ProviderWorkerRuntimeBinding,
  ) => Effect.Effect<void, ProviderWorkerProvisioningError>;
}

export class ProviderWorkerProvisioner extends ServiceMap.Service<
  ProviderWorkerProvisioner,
  ProviderWorkerProvisionerShape
>()("synara/providerWorker/Services/ProviderWorkerProvisioner") {}
