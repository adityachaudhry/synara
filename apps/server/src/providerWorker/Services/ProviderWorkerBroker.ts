import type {
  ProviderRuntimeEvent,
  ProviderWorkerClientFrame,
  ProviderWorkerMethod,
  ProviderWorkerServerFrame,
} from "@synara/contracts";
import { ServiceMap, type Effect, type Stream } from "effect";

import type { ProviderWorkerBrokerError } from "../Errors";

export interface ProviderWorkerFence {
  readonly sandboxId: string;
  readonly workerId: string;
  readonly lifecycleGeneration: string;
}

export interface ProviderWorkerConnection {
  readonly send: (
    frame: ProviderWorkerServerFrame,
  ) => Effect.Effect<void, ProviderWorkerBrokerError>;
  readonly close: () => Effect.Effect<void>;
}

export interface ProviderWorkerBrokerShape {
  readonly expectWorker: (
    fence: ProviderWorkerFence,
  ) => Effect.Effect<void, ProviderWorkerBrokerError>;
  readonly register: (
    fence: ProviderWorkerFence,
    connection: ProviderWorkerConnection,
  ) => Effect.Effect<void, ProviderWorkerBrokerError>;
  readonly waitForConnection: (
    fence: ProviderWorkerFence,
  ) => Effect.Effect<void, ProviderWorkerBrokerError>;
  readonly request: (
    fence: ProviderWorkerFence,
    method: ProviderWorkerMethod,
    params: unknown,
  ) => Effect.Effect<unknown, ProviderWorkerBrokerError>;
  readonly accept: (
    frame: ProviderWorkerClientFrame,
  ) => Effect.Effect<void, ProviderWorkerBrokerError>;
  readonly disconnect: (fence: ProviderWorkerFence) => Effect.Effect<void>;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

export class ProviderWorkerBroker extends ServiceMap.Service<
  ProviderWorkerBroker,
  ProviderWorkerBrokerShape
>()("synara/providerWorker/Services/ProviderWorkerBroker") {}
