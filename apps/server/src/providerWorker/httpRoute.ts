import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { ProviderWorkerTransportError } from "./Errors";
import { runProviderWorkerConnection, type ProviderWorkerSocket } from "./providerWorkerConnection";
import {
  ProviderWorkerBootstrapAuthority,
  type ProviderWorkerBootstrapAuthorityShape,
} from "./Services/ProviderWorkerBootstrapAuthority";
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

export function authenticateProviderWorkerUpgrade(
  headers: Readonly<Record<string, string | undefined>>,
  authority: ProviderWorkerBootstrapAuthorityShape,
) {
  if (headers.origin !== undefined) {
    return Effect.fail(
      new ProviderWorkerTransportError({
        operation: "upgrade.origin",
        detail: "Browser-origin provider worker connections are forbidden.",
      }),
    );
  }
  const match = /^Bearer ([^\s]+)$/iu.exec(headers.authorization ?? "");
  if (!match?.[1]) {
    return Effect.fail(
      new ProviderWorkerTransportError({
        operation: "upgrade.auth",
        detail: "Provider worker authorization is required.",
      }),
    );
  }
  return authority.authorize(match[1]).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderWorkerTransportError({
          operation: "upgrade.auth",
          detail: "Provider worker authorization failed.",
          cause,
        }),
    ),
  );
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
        const authenticatedFence = yield* authenticateProviderWorkerUpgrade(
          request.headers,
          authority,
        ).pipe(Effect.option);
        if (authenticatedFence._tag === "None") {
          return HttpServerResponse.empty({ status: 401 });
        }
        const effectSocket = yield* request.upgrade;
        const socket = yield* makeProviderWorkerSocket(effectSocket);
        yield* runProviderWorkerConnection({
          socket,
          authenticatedFence: authenticatedFence.value,
          broker,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("provider worker websocket closed", {
              operation: error.operation,
              detail: error.detail,
            }),
          ),
        );
        return HttpServerResponse.empty({ status: 204 });
      }),
    );
  }),
);
