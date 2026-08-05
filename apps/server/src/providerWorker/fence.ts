export interface ProviderWorkerFence {
  readonly sandboxId: string;
  readonly workerId: string;
  readonly lifecycleGeneration: string;
}

export const providerWorkerFenceKey = (fence: ProviderWorkerFence) =>
  `${fence.sandboxId}\u0000${fence.lifecycleGeneration}`;

export function sameProviderWorkerFence(
  left: ProviderWorkerFence,
  right: ProviderWorkerFence,
): boolean {
  return (
    left.sandboxId === right.sandboxId &&
    left.workerId === right.workerId &&
    left.lifecycleGeneration === right.lifecycleGeneration
  );
}
