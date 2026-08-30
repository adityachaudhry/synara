import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  type ProviderWorkerRequest,
  type ProviderWorkerResponse,
} from "@synara/contracts";
import { Effect } from "effect";

import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import { ProviderWorkerTransportError } from "./Errors";
import type { ProviderWorkerFence } from "./fence";
import { dispatchProviderWorkerRequest } from "./workerDispatch";

interface RequestEntry {
  readonly fingerprint: string;
  readonly response: Promise<ProviderWorkerResponse>;
  settled?: ProviderWorkerResponse;
}

export function makeProviderWorkerRequestLedger<TError>(input: {
  readonly fence: ProviderWorkerFence;
  readonly adapter: ProviderAdapterShape<TError>;
  readonly capacity?: number;
}) {
  const entries = new Map<string, RequestEntry>();
  const acknowledged = new Map<string, RequestEntry>();
  const capacity = input.capacity ?? 2_048;

  const execute = (request: ProviderWorkerRequest) =>
    Effect.tryPromise({
      try: async () => {
        const fingerprint = JSON.stringify({ method: request.method, params: request.params });
        const existing = entries.get(request.requestId) ?? acknowledged.get(request.requestId);
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new ProviderWorkerTransportError({
              operation: "request.replay",
              detail: "A replayed worker request id carried different input.",
            });
          }
          return existing.response;
        }
        while (entries.size + acknowledged.size >= capacity && acknowledged.size > 0) {
          const oldest = acknowledged.keys().next().value;
          if (oldest !== undefined) acknowledged.delete(oldest);
        }
        if (entries.size + acknowledged.size >= capacity) {
          throw new ProviderWorkerTransportError({
            operation: "request.ledger",
            detail: "Provider worker request ledger reached its lossless capacity.",
          });
        }

        const response = Effect.runPromise(
          dispatchProviderWorkerRequest(input.adapter, request).pipe(
            Effect.match({
              onSuccess: (result): ProviderWorkerResponse => ({
                protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
                ...input.fence,
                type: "response",
                requestId: request.requestId,
                ok: true,
                result: result ?? null,
              }),
              onFailure: (): ProviderWorkerResponse => ({
                protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
                ...input.fence,
                type: "response",
                requestId: request.requestId,
                ok: false,
                error: {
                  code: "provider_request_failed",
                  message: `Provider worker request '${request.method}' failed.`,
                  retryable: false,
                },
              }),
            }),
          ),
        );
        const entry: RequestEntry = { fingerprint, response };
        entries.set(request.requestId, entry);
        entry.settled = await response;
        return entry.settled;
      },
      catch: (cause) =>
        cause instanceof ProviderWorkerTransportError
          ? cause
          : new ProviderWorkerTransportError({
              operation: "request.ledger",
              detail: "Provider worker request ledger failed.",
              cause,
            }),
    });

  return {
    execute,
    acknowledge: (requestId: string) => {
      const entry = entries.get(requestId);
      if (!entry) return;
      entries.delete(requestId);
      acknowledged.set(requestId, entry);
    },
    pending: () =>
      Array.from(entries.values()).flatMap((entry) =>
        entry.settled === undefined ? [] : [entry.settled],
      ),
  };
}

export type ProviderWorkerRequestLedger = ReturnType<typeof makeProviderWorkerRequestLedger>;
