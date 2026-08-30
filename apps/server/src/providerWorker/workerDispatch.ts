import type { ProviderWorkerRequest } from "@synara/contracts";
import { Effect } from "effect";

import { ProviderAdapterRequestError } from "../provider/Errors";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";

const unsupported = (method: ProviderWorkerRequest["method"]) =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: "pi",
      method,
      detail: `The Pi adapter does not implement worker method '${method}'.`,
    }),
  );

export function dispatchProviderWorkerRequest<TError>(
  adapter: ProviderAdapterShape<TError>,
  request: ProviderWorkerRequest,
): Effect.Effect<unknown, TError | ProviderAdapterRequestError> {
  switch (request.method) {
    case "session.start":
      return adapter.startSession(request.params);
    case "turn.send":
      return adapter.sendTurn(request.params);
    case "turn.steer":
      return adapter.steerTurn
        ? adapter.steerTurn(request.params)
        : unsupported(request.method);
    case "turn.interrupt":
      return adapter.interruptTurn(
        request.params.threadId,
        request.params.turnId,
        request.params.providerThreadId,
      );
    case "request.respond":
      return adapter.respondToRequest(
        request.params.threadId,
        request.params.requestId,
        request.params.decision,
      );
    case "userInput.respond":
      return adapter.respondToUserInput(
        request.params.threadId,
        request.params.requestId,
        request.params.answers,
      );
    case "session.stop":
      return adapter.stopSession(request.params.threadId);
    case "session.list":
      return adapter.listSessions();
    case "session.has":
      return adapter.hasSession(request.params.threadId);
    case "thread.read":
      return adapter.readThread(request.params.threadId);
    case "thread.rollback":
      return adapter.rollbackThread(request.params.threadId, request.params.numTurns);
    case "thread.compact":
      return adapter.compactThread
        ? adapter.compactThread(request.params.threadId)
        : unsupported(request.method);
    case "runtime.stopAll":
      return adapter.stopAll();
  }
}
