import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  type ProviderRuntimeEvent,
  type ProviderWorkerEvent,
} from "@synara/contracts";

import { ProviderWorkerTransportError } from "./Errors";
import type { ProviderWorkerFence } from "./fence";

export interface ProviderWorkerOutbox {
  readonly push: (event: ProviderRuntimeEvent) => ProviderWorkerEvent;
  readonly acknowledge: (sequence: number) => void;
  readonly pending: () => ReadonlyArray<ProviderWorkerEvent>;
  readonly lastAcknowledgedSequence: () => number;
}

export function makeProviderWorkerOutbox(
  fence: ProviderWorkerFence,
  capacity = 2_048,
): ProviderWorkerOutbox {
  const frames = new Map<number, ProviderWorkerEvent>();
  let nextSequence = 1;
  let acknowledgedSequence = 0;

  const push = (event: ProviderRuntimeEvent) => {
    if (frames.size >= capacity) {
      throw new ProviderWorkerTransportError({
        operation: "event.outbox",
        detail: "Provider worker event outbox reached its lossless capacity.",
      });
    }
    const frame: ProviderWorkerEvent = {
      protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
      ...fence,
      type: "event",
      sequence: nextSequence,
      event,
    };
    frames.set(nextSequence, frame);
    nextSequence += 1;
    return frame;
  };

  const acknowledge = (sequence: number) => {
    if (sequence <= acknowledgedSequence) return;
    if (sequence >= nextSequence) {
      throw new ProviderWorkerTransportError({
        operation: "event.acknowledge",
        detail: `Control plane acknowledged future worker event sequence ${String(sequence)}.`,
      });
    }
    acknowledgedSequence = sequence;
    for (const retainedSequence of frames.keys()) {
      if (retainedSequence <= sequence) frames.delete(retainedSequence);
    }
  };

  return {
    push,
    acknowledge,
    pending: () => Array.from(frames.values()),
    lastAcknowledgedSequence: () => acknowledgedSequence,
  };
}
