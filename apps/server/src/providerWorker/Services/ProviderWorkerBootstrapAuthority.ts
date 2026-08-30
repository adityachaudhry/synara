import { ServiceMap, type Effect } from "effect";

import type { ProviderWorkerAuthError } from "../Errors";
import type { ProviderWorkerFence } from "../fence";

export interface ProviderWorkerBootstrapAuthorityShape {
  readonly issue: (fence: ProviderWorkerFence) => Effect.Effect<string>;
  readonly authorize: (
    credential: string,
  ) => Effect.Effect<ProviderWorkerFence, ProviderWorkerAuthError>;
  readonly revoke: (fence: ProviderWorkerFence) => Effect.Effect<void>;
}

export class ProviderWorkerBootstrapAuthority extends ServiceMap.Service<
  ProviderWorkerBootstrapAuthority,
  ProviderWorkerBootstrapAuthorityShape
>()("synara/providerWorker/Services/ProviderWorkerBootstrapAuthority") {}
