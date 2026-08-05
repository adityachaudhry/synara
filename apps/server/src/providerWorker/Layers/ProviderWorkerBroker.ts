import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  type ProviderWorkerClientFrame,
  type ProviderWorkerServerFrame,
} from "@synara/contracts";
import { randomUUID } from "node:crypto";
import { Deferred, Duration, Effect, Layer, Option, Queue, Stream } from "effect";

import { ProviderWorkerBrokerError } from "../Errors";
import { providerWorkerFenceKey, sameProviderWorkerFence } from "../fence";
import type {
  ProviderWorkerBrokerShape,
  ProviderWorkerConnection,
  ProviderWorkerFence,
} from "../Services/ProviderWorkerBroker";
import { ProviderWorkerBroker } from "../Services/ProviderWorkerBroker";

const PROVIDER_WORKER_EVENT_BUFFER_CAPACITY = 2_048;

interface ExpectedWorker {
  readonly fence: ProviderWorkerFence;
  readonly ready: Deferred.Deferred<void, ProviderWorkerBrokerError>;
  lastSequence: number;
}

interface ActiveWorker {
  readonly fence: ProviderWorkerFence;
  readonly connection: ProviderWorkerConnection;
  lastSequence: number;
  lastSeenAt: number;
}

interface PendingRequest {
  readonly workerKey: string;
  readonly deferred: Deferred.Deferred<unknown, ProviderWorkerBrokerError>;
}

export interface ProviderWorkerBrokerOptions {
  readonly requestTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
}

const registrationError = (operation: string, fence: ProviderWorkerFence, detail: string) =>
  new ProviderWorkerBrokerError({ operation, detail, sandboxId: fence.sandboxId });

export const makeProviderWorkerBroker = (options?: ProviderWorkerBrokerOptions) =>
  Effect.gen(function* () {
    const expected = new Map<string, ExpectedWorker>();
    const active = new Map<string, ActiveWorker>();
    const pending = new Map<string, PendingRequest>();
    const events = yield* Queue.bounded<ProviderWorkerClientFrame & { readonly type: "event" }>(
      PROVIDER_WORKER_EVENT_BUFFER_CAPACITY,
    );
    const requestTimeout = Duration.millis(options?.requestTimeoutMs ?? 120_000);
    const connectionTimeout = Duration.millis(options?.connectionTimeoutMs ?? 30_000);

    const expectWorker: ProviderWorkerBrokerShape["expectWorker"] = (fence) =>
      Effect.gen(function* () {
        const key = providerWorkerFenceKey(fence);
        if (expected.has(key) || active.has(key)) {
          return yield* registrationError(
            "expectWorker",
            fence,
            "A worker is already reserved or connected for this runtime generation.",
          );
        }
        expected.set(key, {
          fence,
          ready: yield* Deferred.make<void, ProviderWorkerBrokerError>(),
          lastSequence: 0,
        });
      });

    const register: ProviderWorkerBrokerShape["register"] = (fence, connection) =>
      Effect.gen(function* () {
        const key = providerWorkerFenceKey(fence);
        const reservation = expected.get(key);
        if (!reservation || !sameProviderWorkerFence(reservation.fence, fence)) {
          yield* connection.close();
          return yield* registrationError(
            "register",
            fence,
            "Worker registration does not match an expected runtime generation.",
          );
        }
        if (active.has(key)) {
          yield* connection.close();
          return yield* registrationError(
            "register",
            fence,
            "A worker is already connected for this runtime generation.",
          );
        }
        active.set(key, {
          fence,
          connection,
          lastSequence: reservation.lastSequence,
          lastSeenAt: Date.now(),
        });
        yield* Deferred.succeed(reservation.ready, undefined);
        return reservation.lastSequence;
      });

    const waitForConnection: ProviderWorkerBrokerShape["waitForConnection"] = (fence) =>
      Effect.gen(function* () {
        const key = providerWorkerFenceKey(fence);
        if (active.has(key)) return;
        const reservation = expected.get(key);
        if (!reservation || !sameProviderWorkerFence(reservation.fence, fence)) {
          return yield* registrationError(
            "waitForConnection",
            fence,
            "No worker reservation exists for this runtime generation.",
          );
        }
        const connected = yield* Deferred.await(reservation.ready).pipe(
          Effect.timeoutOption(connectionTimeout),
        );
        if (Option.isNone(connected)) {
          return yield* registrationError(
            "connection.timeout",
            fence,
            "Timed out waiting for the Railway provider worker to connect.",
          );
        }
      });

    const request: ProviderWorkerBrokerShape["request"] = (fence, method, params) =>
      Effect.gen(function* () {
        const key = providerWorkerFenceKey(fence);
        const worker = active.get(key);
        if (!worker || !sameProviderWorkerFence(worker.fence, fence)) {
          return yield* registrationError(
            "request",
            fence,
            "The expected provider worker is not connected.",
          );
        }
        const requestId = randomUUID();
        const deferred = yield* Deferred.make<unknown, ProviderWorkerBrokerError>();
        pending.set(requestId, { workerKey: key, deferred });
        const frame = {
          protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
          ...fence,
          type: "request",
          requestId,
          method,
          params,
        } as ProviderWorkerServerFrame;

        return yield* worker.connection.send(frame).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOption(requestTimeout),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  registrationError(
                    "request.timeout",
                    fence,
                    `Provider worker request '${method}' timed out.`,
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
        );
      });

    const requireActive = (frame: ProviderWorkerClientFrame) => {
      const key = providerWorkerFenceKey(frame);
      const worker = active.get(key);
      return worker && sameProviderWorkerFence(worker.fence, frame)
        ? Effect.succeed({ key, worker })
        : Effect.fail(
            registrationError(
              "accept",
              frame,
              "Frame came from a stale or unregistered worker generation.",
            ),
          );
    };

    const acknowledgeSequence = (worker: ActiveWorker, sequence: number) =>
      worker.connection.send({
        protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
        ...worker.fence,
        type: "heartbeat",
        sentAt: new Date().toISOString(),
        acknowledgedSequence: sequence,
      });

    const accept: ProviderWorkerBrokerShape["accept"] = (frame) =>
      frame.type === "register"
        ? Effect.fail(
            registrationError(
              "accept",
              frame,
              "Registration frames must be handled by the authenticated route.",
            ),
          )
        : requireActive(frame).pipe(
            Effect.flatMap(({ key, worker }) => {
              worker.lastSeenAt = Date.now();
              switch (frame.type) {
                case "heartbeat":
                  return Effect.void;
                case "response": {
                  const entry = pending.get(frame.requestId);
                  if (!entry || entry.workerKey !== key) {
                    return Effect.fail(
                      registrationError(
                        "response",
                        frame,
                        "Response does not match an in-flight request for this worker.",
                      ),
                    );
                  }
                  return frame.ok
                    ? Deferred.succeed(entry.deferred, frame.result).pipe(Effect.asVoid)
                    : Deferred.fail(
                        entry.deferred,
                        registrationError("worker.response", frame, frame.error.message),
                      ).pipe(Effect.asVoid);
                }
                case "event":
                  if (frame.sequence <= worker.lastSequence) {
                    return acknowledgeSequence(worker, worker.lastSequence);
                  }
                  if (frame.sequence !== worker.lastSequence + 1) {
                    return Effect.fail(
                      registrationError(
                        "event.sequence",
                        frame,
                        `Expected worker event sequence ${String(worker.lastSequence + 1)}, received ${String(frame.sequence)}.`,
                      ),
                    );
                  }
                  return Queue.offer(events, frame).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        worker.lastSequence = frame.sequence;
                        const reservation = expected.get(key);
                        if (reservation) reservation.lastSequence = frame.sequence;
                      }),
                    ),
                    Effect.andThen(acknowledgeSequence(worker, frame.sequence)),
                  );
              }
            }),
          );

    const disconnect: ProviderWorkerBrokerShape["disconnect"] = (fence) =>
      Effect.gen(function* () {
        const key = providerWorkerFenceKey(fence);
        const worker = active.get(key);
        if (!worker || !sameProviderWorkerFence(worker.fence, fence)) return;
        active.delete(key);
        const failure = registrationError(
          "disconnect",
          fence,
          "Provider worker disconnected before the request completed.",
        );
        yield* Effect.forEach(
          Array.from(pending.entries()),
          ([requestId, entry]) =>
            entry.workerKey === key
              ? Deferred.fail(entry.deferred, failure).pipe(
                  Effect.tap(() => Effect.sync(() => pending.delete(requestId))),
                  Effect.asVoid,
                )
              : Effect.void,
          { discard: true },
        );
      });

    return {
      expectWorker,
      register,
      waitForConnection,
      request,
      accept,
      disconnect,
      streamEvents: Stream.fromQueue(events).pipe(Stream.map((frame) => frame.event)),
    } satisfies ProviderWorkerBrokerShape;
  });

export const ProviderWorkerBrokerLive = Layer.effect(
  ProviderWorkerBroker,
  makeProviderWorkerBroker(),
);
