export interface WorkerCheckpointRecord {
  readonly id: string;
  readonly key: string;
}

export type WorkerCheckpointPreparationPlan =
  | {
      readonly kind: "reuse";
      readonly checkpoint: WorkerCheckpointRecord;
    }
  | { readonly kind: "create" };

export function planWorkerCheckpointPreparation(
  checkpoints: readonly WorkerCheckpointRecord[],
  checkpointName: string,
): WorkerCheckpointPreparationPlan {
  const checkpoint = checkpoints.find((candidate) => candidate.key === checkpointName);
  return checkpoint ? { kind: "reuse", checkpoint } : { kind: "create" };
}
