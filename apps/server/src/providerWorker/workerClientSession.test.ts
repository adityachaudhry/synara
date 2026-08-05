import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  type ProviderRuntimeEvent,
  type ProviderWorkerServerFrame,
} from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import type { ProviderWorkerSocket } from "./providerWorkerConnection";
import { makeProviderWorkerClientSession } from "./workerClientSession";
import { makeProviderWorkerOutbox } from "./workerOutbox";

const fence = {
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
} as const;

const event: ProviderRuntimeEvent = {
  eventId: "event-1" as never,
  provider: "pi",
  type: "session.state.changed",
  threadId: "thread-1" as never,
  createdAt: "2026-08-05T01:00:00.000Z",
  payload: { state: "ready" },
};

function frame(value: Omit<ProviderWorkerServerFrame, keyof typeof fence | "protocolVersion">) {
  return JSON.stringify({
    protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
    ...fence,
    ...value,
  });
}

function makeAdapter() {
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
    hasSession: () => Effect.succeed(true),
    readThread: () => Effect.die("unused"),
    rollbackThread: () => Effect.die("unused"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  } as ProviderAdapterShape<never>;
}

function makeSocket(frames: ReadonlyArray<string>) {
  const sent: unknown[] = [];
  const closes: unknown[] = [];
  const socket: ProviderWorkerSocket = {
    run: (handler, onOpen) =>
      (onOpen ?? Effect.void).pipe(
        Effect.andThen(Effect.forEach(frames, handler, { discard: true })),
      ),
    sendRaw: (raw) => Effect.sync(() => sent.push(JSON.parse(raw))),
    close: (code, reason) => Effect.sync(() => closes.push({ code, reason })),
  };
  return { socket, sent, closes };
}

describe("ProviderWorkerClientSession", () => {
  it("registers, replays retained events, and dispatches adapter requests", async () => {
    const fake = makeSocket([
      frame({ type: "registered", acknowledgedSequence: 0 }),
      frame({
        type: "request",
        requestId: "request-1",
        method: "session.has",
        params: { threadId: "thread-1" },
      }),
      frame({
        type: "heartbeat",
        sentAt: "2026-08-05T01:00:01.000Z",
        acknowledgedSequence: 1,
      }),
    ]);
    const outbox = makeProviderWorkerOutbox(fence);
    outbox.push(event);
    const session = makeProviderWorkerClientSession({
      fence,
      bootstrapCredential: "bootstrap-secret",
      adapter: makeAdapter(),
      outbox,
      socket: fake.socket,
    });

    await Effect.runPromise(session.run);

    expect(fake.sent[0]).toMatchObject({ type: "register", ...fence });
    expect(fake.sent[0]).toMatchObject({ bootstrapCredential: "bootstrap-secret" });
    expect(fake.sent[1]).toMatchObject({ type: "event", sequence: 1 });
    expect(fake.sent[2]).toMatchObject({
      type: "response",
      requestId: "request-1",
      ok: true,
      result: true,
    });
    expect(outbox.pending()).toEqual([]);
  });

  it("rejects a server frame from another lifecycle generation", async () => {
    const fake = makeSocket([
      JSON.stringify({
        protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
        ...fence,
        lifecycleGeneration: "generation-2",
        type: "registered",
        acknowledgedSequence: 0,
      }),
    ]);
    const session = makeProviderWorkerClientSession({
      fence,
      bootstrapCredential: "bootstrap-secret",
      adapter: makeAdapter(),
      outbox: makeProviderWorkerOutbox(fence),
      socket: fake.socket,
    });

    const result = await Effect.runPromise(session.run.pipe(Effect.result));

    expect(result._tag).toBe("Failure");
    expect(fake.closes).toEqual([
      { code: 4400, reason: "Provider worker server frame rejected" },
    ]);
  });
});
