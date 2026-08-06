import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { ProviderWorkerBrokerError, ProviderWorkerTransportError } from "./Errors";
import { runProviderWorkerConnection, type ProviderWorkerSocket } from "./providerWorkerConnection";
import { ProviderWorkerBootstrapAuthority } from "./Services/ProviderWorkerBootstrapAuthority";
import { ProviderWorkerBroker } from "./Services/ProviderWorkerBroker";

export const PROVIDER_WORKER_WEBSOCKET_PATH = "/internal/provider-worker";

const toTransportError = (operation: string) => (cause: unknown) =>
  new ProviderWorkerTransportError({
    operation,
    detail: `Provider worker WebSocket ${operation} failed.`,
    cause,
  });

export function mapProviderWorkerSocketRunError(cause: unknown) {
  return cause instanceof ProviderWorkerTransportError
    ? cause
    : toTransportError("read")(cause);
}

export function providerWorkerTransportDiagnostic(error: ProviderWorkerTransportError) {
  const cause = error.cause;
  return {
    operation: error.operation,
    detail: error.detail,
    ...(cause instanceof ProviderWorkerBrokerError
      ? {
          causeTag: cause._tag,
          causeOperation: cause.operation,
          causeDetail: cause.detail,
          ...(cause.sandboxId === undefined ? {} : { sandboxId: cause.sandboxId }),
        }
      : cause instanceof Error
        ? { causeTag: cause.name, causeDetail: cause.message }
        : cause === undefined
          ? {}
          : { causeTag: typeof cause, causeDetail: String(cause) }),
  };
}

export const makeProviderWorkerSocket = Effect.fn(function* (
  socket: Socket.Socket,
): Effect.fn.Return<ProviderWorkerSocket, never, never> {
  const write = yield* socket.writer;
  return {
    run: (handler, onOpen) =>
      socket
        .runRaw(handler, { ...(onOpen === undefined ? {} : { onOpen }) })
        .pipe(Effect.mapError(mapProviderWorkerSocketRunError)),
    sendRaw: (frame) => write(frame).pipe(Effect.mapError(toTransportError("write"))),
    close: (code, reason) => write(new Socket.CloseEvent(code, reason)).pipe(Effect.ignore),
  };
});

export const providerWorkerRouteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const authority = yield* ProviderWorkerBootstrapAuthority;
    const broker = yield* ProviderWorkerBroker;
    yield* router.add(
      "GET",
      PROVIDER_WORKER_WEBSOCKET_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const effectSocket = yield* request.upgrade;
        const socket = yield* makeProviderWorkerSocket(effectSocket);
        yield* runProviderWorkerConnection({ socket, authority, broker }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "provider worker websocket closed",
              providerWorkerTransportDiagnostic(error),
            ),
          ),
        );
        return HttpServerResponse.empty({ status: 204 });
      }),
    );
  }),
);
