import { ServiceMap, type Effect } from "effect";
import type { ChatAttachment, ProjectRepositoryBinding, ThreadId } from "@synara/contracts";
import type { AgentGatewayMcpConnection } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import type {
  ProviderPersistenceCandidateList,
  ProviderPersistenceCandidateSelection,
  ProviderPersistenceFile,
} from "../../providerPersistence.ts";

import type { ProviderWorkerProvisioningError } from "../Errors";
import type { ProviderWorkerRuntimeBinding } from "../runtimeBinding";

export interface ProviderWorkerProvisionInput {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration: string;
  readonly cwd?: string;
  readonly repositoryBinding?: ProjectRepositoryBinding;
  readonly agentGatewayConnection?: AgentGatewayMcpConnection;
  readonly onCapacityAdmitted?: () => void;
}

export interface ProviderWorkerAttachmentStageInput {
  readonly attachment: ChatAttachment;
  readonly sourcePath: string;
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
  readonly stageAttachments: (
    binding: ProviderWorkerRuntimeBinding,
    attachments: ReadonlyArray<ProviderWorkerAttachmentStageInput>,
  ) => Effect.Effect<void, ProviderWorkerProvisioningError>;
  readonly reconcileRepository: (
    binding: ProviderWorkerRuntimeBinding,
    commit: string,
    persistedFiles?: ReadonlyArray<ProviderPersistenceCandidateSelection>,
  ) => Effect.Effect<ProviderWorkerRuntimeBinding, ProviderWorkerProvisioningError>;
  readonly listPersistenceCandidates: (
    binding: ProviderWorkerRuntimeBinding,
  ) => Effect.Effect<ProviderPersistenceCandidateList, ProviderWorkerProvisioningError>;
  readonly readPersistenceCandidate: (
    binding: ProviderWorkerRuntimeBinding,
    selection: ProviderPersistenceCandidateSelection,
  ) => Effect.Effect<ProviderPersistenceFile, ProviderWorkerProvisioningError>;
  readonly stop: (
    binding: ProviderWorkerRuntimeBinding,
  ) => Effect.Effect<void, ProviderWorkerProvisioningError>;
}

export class ProviderWorkerProvisioner extends ServiceMap.Service<
  ProviderWorkerProvisioner,
  ProviderWorkerProvisionerShape
>()("synara/providerWorker/Services/ProviderWorkerProvisioner") {}
