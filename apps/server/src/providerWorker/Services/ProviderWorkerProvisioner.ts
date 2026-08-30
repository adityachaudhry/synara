import { ServiceMap, type Effect } from "effect";
import type { ProjectRepositoryBinding, ThreadId } from "@synara/contracts";

import type { ProviderWorkerProvisioningError } from "../Errors";
import type { ProviderWorkerRuntimeBinding } from "../runtimeBinding";

export interface ProviderWorkerProvisionInput {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration: string;
  readonly cwd?: string;
  readonly repositoryBinding?: ProjectRepositoryBinding;
  readonly onCapacityAdmitted?: () => void;
}

export interface ProviderWorkerProvisionerShape {
  readonly start: (
    input: ProviderWorkerProvisionInput,
  ) => Effect.Effect<ProviderWorkerRuntimeBinding, ProviderWorkerProvisioningError>;
  readonly restart: (
    binding: ProviderWorkerRuntimeBinding,
    input: ProviderWorkerProvisionInput,
  ) => Effect.Effect<ProviderWorkerRuntimeBinding, ProviderWorkerProvisioningError>;
  readonly adopt: (
    binding: ProviderWorkerRuntimeBinding,
  ) => Effect.Effect<void, ProviderWorkerProvisioningError>;
  readonly stop: (
    binding: ProviderWorkerRuntimeBinding,
  ) => Effect.Effect<void, ProviderWorkerProvisioningError>;
}

export class ProviderWorkerProvisioner extends ServiceMap.Service<
  ProviderWorkerProvisioner,
  ProviderWorkerProvisionerShape
>()("synara/providerWorker/Services/ProviderWorkerProvisioner") {}
