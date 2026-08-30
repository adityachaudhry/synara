import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  type ProviderWorkerRequest,
} from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import { dispatchProviderWorkerRequest } from "./workerDispatch";

const fence = {
  protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
} as const;

function request(method: ProviderWorkerRequest["method"], params: unknown) {
  return {
    ...fence,
    type: "request",
    requestId: "request-1",
    method,
    params,
  } as ProviderWorkerRequest;
}

function makeAdapter(overrides: Partial<ProviderAdapterShape<never>> = {}) {
  return {
    provider: "pi",
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: () => Effect.die("unused"),
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    readThread: () => Effect.die("unused"),
    rollbackThread: () => Effect.die("unused"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
    ...overrides,
  } as ProviderAdapterShape<never>;
}

describe("dispatchProviderWorkerRequest", () => {
  it("delegates a session query to the existing adapter contract", async () => {
    const adapter = makeAdapter({ hasSession: () => Effect.succeed(true) });

    const result = await Effect.runPromise(
      dispatchProviderWorkerRequest(
        adapter,
        request("session.has", { threadId: "thread-1" }),
      ),
    );

    expect(result).toBe(true);
  });

  it("preserves interrupt arguments exactly", async () => {
    const calls: unknown[] = [];
    const adapter = makeAdapter({
      interruptTurn: (threadId, turnId, providerThreadId) =>
        Effect.sync(() => calls.push({ threadId, turnId, providerThreadId })),
    });

    await Effect.runPromise(
      dispatchProviderWorkerRequest(
        adapter,
        request("turn.interrupt", {
          threadId: "thread-1",
          turnId: "turn-1",
          providerThreadId: "pi-thread-1",
        }),
      ),
    );

    expect(calls).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-1",
        providerThreadId: "pi-thread-1",
      },
    ]);
  });

});
