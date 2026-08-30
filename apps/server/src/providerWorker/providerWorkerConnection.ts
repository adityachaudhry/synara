import {
  ProviderWorkerClientFrame,
  type ProviderWorkerServerFrame,
} from "@synara/contracts";
import { Duration, Effect, Schema } from "effect";

import { PROVIDER_WORKER_PROTOCOL_REJECTED_CLOSE_CODE } from "./closeCodes";
import { ProviderWorkerBrokerError, ProviderWorkerTransportError } from "./Errors";
import { sameProviderWorkerFence, type ProviderWorkerFence } from "./fence";
import type {
  ProviderWorkerBrokerShape,
  ProviderWorkerConnection,
} from "./Services/ProviderWorkerBroker";

export interface ProviderWorkerSocket {
  readonly run: (
    handler: (frame: string | Uint8Array) => Effect.Effect<void, ProviderWorkerTransportError>,
    onOpen?: Effect.Effect<void, ProviderWorkerTransportError>,
  ) => Effect.Effect<void, ProviderWorkerTransportError>;
  readonly sendRaw: (frame: string) => Effect.Effect<void, ProviderWorkerTransportError>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
}

const transportError = (operation: string, detail: string, cause?: unknown) =>
  new ProviderWorkerTransportError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const decodeFrame = (raw: string | Uint8Array) =>
  Effect.try({
    try: () => JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)),
    catch: (cause) => transportError("decode.json", "Worker frame is not valid JSON.", cause),
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(ProviderWorkerClientFrame)(value)),
    Effect.mapError((cause) =>
      cause instanceof ProviderWorkerTransportError
        ? cause
        : transportError("decode.schema", "Worker frame does not match the protocol schema.", cause),
    ),
  );

const fenceFromFrame = (frame: {
  readonly sandboxId: string;
  readonly workerId: string;
  readonly lifecycleGeneration: string;
}): ProviderWorkerFence => ({
  sandboxId: frame.sandboxId,
  workerId: frame.workerId,
  lifecycleGeneration: frame.lifecycleGeneration,
});

export function runProviderWorkerConnection(input: {
  readonly socket: ProviderWorkerSocket;
  readonly authenticatedFence: ProviderWorkerFence;
  readonly broker: ProviderWorkerBrokerShape;
  readonly registrationTimeoutMs?: number;
}) {
  return Effect.gen(function* () {
    let registeredFence: ProviderWorkerFence | undefined;
    let registrationTimedOut = false;

    const brokerConnection: ProviderWorkerConnection = {
      send: (frame: ProviderWorkerServerFrame) =>
        input.socket.sendRaw(JSON.stringify(frame)).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderWorkerBrokerError({
                operation: "send",
                detail: "Failed to send a frame to the provider worker.",
                ...(registeredFence === undefined
                  ? {}
                  : { sandboxId: registeredFence.sandboxId }),
                cause,
              }),
          ),
        ),
      close: () => input.socket.close(1000, "Provider worker connection retired"),
    };

    const handleFrame = (raw: string | Uint8Array) =>
      decodeFrame(raw).pipe(
        Effect.flatMap((frame) =>
          Effect.gen(function* () {
            if (!registeredFence) {
              if (frame.type !== "register") {
                return yield* transportError(
                  "register",
                  "The first provider worker frame must be a registration.",
                );
              }
              const fence = fenceFromFrame(frame);
              if (!sameProviderWorkerFence(input.authenticatedFence, fence)) {
                return yield* transportError(
                  "register.fence",
                  "Worker registration does not match its authenticated generation.",
                );
              }
              yield* input.broker
                .register(fence, brokerConnection)
                .pipe(
                  Effect.mapError((cause) =>
                    transportError("register.broker", "Worker registration failed.", cause),
                  ),
                );
              registeredFence = fence;
              return;
            }
            if (frame.type === "register") {
              return yield* transportError(
                "register.duplicate",
                "A connected worker cannot register twice on one socket.",
              );
            }
            yield* input.broker.accept(frame).pipe(
              Effect.mapError((cause) =>
                transportError("frame.accept", "Worker frame was rejected.", cause),
              ),
            );
          }),
        ),
        Effect.tapError(() =>
          input.socket.close(
            PROVIDER_WORKER_PROTOCOL_REJECTED_CLOSE_CODE,
            "Provider worker protocol rejected",
          ),
        ),
      );

    yield* Effect.sleep(
      Duration.millis(input.registrationTimeoutMs ?? 10_000),
    ).pipe(
      Effect.flatMap(() => {
        if (registeredFence) return Effect.void;
        registrationTimedOut = true;
        return input.socket.close(
          PROVIDER_WORKER_PROTOCOL_REJECTED_CLOSE_CODE,
          "Provider worker registration timed out",
        );
      }),
      Effect.forkScoped,
    );

    yield* input.socket.run(handleFrame).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          registeredFence ? input.broker.disconnect(registeredFence, brokerConnection) : Effect.void,
        ),
      ),
    );
    if (!registeredFence) {
      return yield* transportError(
        registrationTimedOut ? "register.timeout" : "register.closed",
        registrationTimedOut
          ? "Provider worker did not register before the deadline."
          : "Provider worker connection closed before registration.",
      );
    }
  });
}
