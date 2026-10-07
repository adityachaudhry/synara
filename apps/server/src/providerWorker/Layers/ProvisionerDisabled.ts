import { Effect, Layer } from "effect";

import { ProviderWorkerProvisioningError } from "../Errors";
import { ProviderWorkerProvisioner } from "../Services/ProviderWorkerProvisioner";

function provisionError(operation: string, detail: string, cause: unknown) {
  return new ProviderWorkerProvisioningError({ operation, detail, cause });
}

export const ProviderWorkerProvisionerDisabled = Layer.succeed(ProviderWorkerProvisioner, {
  start: () =>
    Effect.fail(
      provisionError(
        "start",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  restart: () =>
    Effect.fail(
      provisionError(
        "restart",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  adopt: () => Effect.void,
  stageAttachments: () =>
    Effect.fail(
      provisionError(
        "attachment.write",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  checkpointOutbox: () =>
    Effect.fail(
      provisionError(
        "persistence.checkpoint",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  markOutboxPromoted: () => Effect.void,
  reconcileRepository: () =>
    Effect.fail(
      provisionError(
        "repository.reconcile",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  listPersistenceCandidates: () =>
    Effect.fail(
      provisionError(
        "persistence.list",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  readPersistenceCandidate: () =>
    Effect.fail(
      provisionError(
        "persistence.read",
        "Railway distributed Pi is selected but the sandbox runtime is not configured.",
        undefined,
      ),
    ),
  readOutboxCheckpoint: () =>
    Effect.fail(
      provisionError(
        "persistence.checkpoint.read",
        "Railway distributed Pi is selected but durable Outbox checkpoints are not configured.",
        undefined,
      ),
    ),
  stop: () => Effect.void,
} satisfies import("../Services/ProviderWorkerProvisioner").ProviderWorkerProvisionerShape);
