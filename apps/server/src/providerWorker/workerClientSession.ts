import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  ProviderWorkerServerFrame,
  type ProviderRuntimeEvent,
  type ProviderWorkerRegister,
  type ProviderWorkerResponse,
} from "@synara/contracts";
import { Effect, Schema } from "effect";

import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import { PROVIDER_WORKER_PROTOCOL_REJECTED_CLOSE_CODE } from "./closeCodes";
import { ProviderWorkerTransportError } from "./Errors";
import { sameProviderWorkerFence, type ProviderWorkerFence } from "./fence";
import type { ProviderWorkerSocket } from "./providerWorkerConnection";
import { dispatchProviderWorkerRequest } from "./workerDispatch";
import type { ProviderWorkerOutbox } from "./workerOutbox";

const clientError = (operation: string, detail: string, cause?: unknown) =>
  new ProviderWorkerTransportError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const decodeServerFrame = (raw: string | Uint8Array) =>
  Effect.try({
    try: () => JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)),
    catch: (cause) => clientError("decode.json", "Control-plane frame is not valid JSON.", cause),
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(ProviderWorkerServerFrame)(value)),
    Effect.mapError((cause) =>
      cause instanceof ProviderWorkerTransportError
        ? cause
        : clientError("decode.schema", "Control-plane frame does not match the protocol.", cause),
    ),
  );

export function makeProviderWorkerClientSession<TError>(input: {
  readonly fence: ProviderWorkerFence;
  readonly bootstrapCredential: string;
  readonly adapter: ProviderAdapterShape<TError>;
  readonly outbox: ProviderWorkerOutbox;
  readonly socket: ProviderWorkerSocket;
}) {
  let registered = false;
  let retired = false;

  const send = (frame: object) => input.socket.sendRaw(JSON.stringify(frame));

  const publishEvent = (event: ProviderRuntimeEvent) =>
    Effect.try({
      try: () => input.outbox.push(event),
      catch: (cause) =>
        cause instanceof ProviderWorkerTransportError
          ? cause
          : clientError("event.outbox", "Failed to retain provider event.", cause),
    }).pipe(
      Effect.flatMap((frame) => (registered ? send(frame) : Effect.void)),
    );

  const handleRequest = (frame: Extract<typeof ProviderWorkerServerFrame.Type, { type: "request" }>) =>
    Effect.logInfo("provider worker request received", {
      method: frame.method,
      requestId: frame.requestId,
    }).pipe(
      Effect.andThen(dispatchProviderWorkerRequest(input.adapter, frame)),
      Effect.matchEffect({
        onSuccess: (result) =>
          Effect.logInfo("provider worker request completed", {
            method: frame.method,
            requestId: frame.requestId,
            ok: true,
          }).pipe(
            Effect.andThen(
              send({
                protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
                ...input.fence,
                type: "response",
                requestId: frame.requestId,
                ok: true,
                result: result ?? null,
              } satisfies ProviderWorkerResponse),
            ),
          ),
        onFailure: () =>
          Effect.logWarning("provider worker request completed", {
            method: frame.method,
            requestId: frame.requestId,
            ok: false,
          }).pipe(
            Effect.andThen(
              send({
                protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
                ...input.fence,
                type: "response",
                requestId: frame.requestId,
                ok: false,
                error: {
                  code: "provider_request_failed",
                  message: `Provider worker request '${frame.method}' failed.`,
                  retryable: false,
                },
              } satisfies ProviderWorkerResponse),
            ),
          ),
      }),
    );

  const handleFrame = (raw: string | Uint8Array) =>
    decodeServerFrame(raw).pipe(
      Effect.flatMap((frame) =>
        Effect.gen(function* () {
          if (!sameProviderWorkerFence(input.fence, frame)) {
            return yield* clientError(
              "frame.fence",
              "Control-plane frame does not match this worker generation.",
            );
          }
          if (!registered) {
            if (frame.type !== "registered") {
              return yield* clientError(
                "register.ack",
                "The first control-plane frame must acknowledge registration.",
              );
            }
            input.outbox.acknowledge(frame.acknowledgedSequence);
            registered = true;
            yield* Effect.forEach(input.outbox.pending(), send, { discard: true });
            return;
          }

          switch (frame.type) {
            case "registered":
              return yield* clientError(
                "register.duplicate",
                "Control plane acknowledged registration twice on one socket.",
              );
            case "heartbeat":
              if (frame.acknowledgedSequence !== undefined) {
                input.outbox.acknowledge(frame.acknowledgedSequence);
              }
              return;
            case "retire":
              retired = true;
              yield* input.adapter.stopAll().pipe(
                Effect.mapError((cause) =>
                  clientError("retire", "Failed to stop Pi sessions during retirement.", cause),
                ),
              );
              yield* input.socket.close(1000, "Provider worker retired");
              return;
            case "request":
              yield* handleRequest(frame);
              return;
          }
        }),
      ),
      Effect.tapError(() =>
        input.socket.close(
          PROVIDER_WORKER_PROTOCOL_REJECTED_CLOSE_CODE,
          "Provider worker server frame rejected",
        ),
      ),
    );

  const registration: ProviderWorkerRegister = {
    protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
    ...input.fence,
    type: "register",
    bootstrapCredential: input.bootstrapCredential,
    lastAcknowledgedSequence: input.outbox.lastAcknowledgedSequence(),
  };

  return {
    publishEvent,
    run: input.socket.run(handleFrame, send(registration)).pipe(
      Effect.mapError((cause) =>
        cause instanceof ProviderWorkerTransportError
          ? cause
          : clientError("socket", "Provider worker socket failed.", cause),
      ),
    ),
    isRetired: () => retired,
  };
}
