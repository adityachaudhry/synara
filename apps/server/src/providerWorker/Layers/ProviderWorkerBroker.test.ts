import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  type ProviderWorkerServerFrame,
} from "@synara/contracts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderWorkerBrokerError } from "../Errors";
import type { ProviderWorkerConnection } from "../Services/ProviderWorkerBroker";
import { makeProviderWorkerBroker } from "./ProviderWorkerBroker";

const fence = {
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
} as const;

function makeConnection() {
  const sent: ProviderWorkerServerFrame[] = [];
  let closeCount = 0;
  const connection: ProviderWorkerConnection = {
    send: (frame) => Effect.sync(() => sent.push(frame)),
    close: () =>
      Effect.sync(() => {
        closeCount += 1;
      }),
  };
  return {
    connection,
    sent,
    get closeCount() {
      return closeCount;
    },
  };
}

describe("ProviderWorkerBroker", () => {
  it("correlates a worker response with one in-flight request", async () => {
    const broker = await Effect.runPromise(makeProviderWorkerBroker({ requestTimeoutMs: 1_000 }));
    const fake = makeConnection();
    await Effect.runPromise(broker.expectWorker(fence));
    await Effect.runPromise(broker.register(fence, fake.connection));

    const request = Effect.runPromise(
      broker.request(fence, "session.has", { threadId: "thread-1" }),
    );
    await viWaitFor(() => fake.sent.length === 1);
    const frame = fake.sent[0];
    expect(frame?.type).toBe("request");
    if (!frame || frame.type !== "request") throw new Error("request frame not sent");

    await Effect.runPromise(
      broker.accept({
        protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
        ...fence,
        type: "response",
        requestId: frame.requestId,
        ok: true,
        result: true,
      }),
    );

    await expect(request).resolves.toBe(true);
  });

  it("rejects unreserved and duplicate worker registrations", async () => {
    const broker = await Effect.runPromise(makeProviderWorkerBroker());
    const first = makeConnection();
    const second = makeConnection();

    const unreserved = await Effect.runPromise(
      broker.register(fence, first.connection).pipe(Effect.result),
    );
    expect(unreserved._tag).toBe("Failure");

    await Effect.runPromise(broker.expectWorker(fence));
    await Effect.runPromise(broker.register(fence, first.connection));
    const duplicate = await Effect.runPromise(
      broker.register(fence, second.connection).pipe(Effect.result),
    );
    expect(duplicate._tag).toBe("Failure");
    if (duplicate._tag === "Failure") {
      expect(duplicate.failure).toBeInstanceOf(ProviderWorkerBrokerError);
      expect(duplicate.failure.operation).toBe("register");
    }
    expect(second.closeCount).toBe(1);
  });

  it("fails outstanding requests when the worker disconnects", async () => {
    const broker = await Effect.runPromise(makeProviderWorkerBroker({ requestTimeoutMs: 1_000 }));
    const fake = makeConnection();
    await Effect.runPromise(broker.expectWorker(fence));
    await Effect.runPromise(broker.register(fence, fake.connection));

    const pending = Effect.runPromise(
      broker.request(fence, "session.has", { threadId: "thread-1" }).pipe(Effect.result),
    );
    await viWaitFor(() => fake.sent.length === 1);
    await Effect.runPromise(broker.disconnect(fence));

    const result = await pending;
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("disconnect");
  });

  it("publishes canonical events once and rejects sequence gaps", async () => {
    const broker = await Effect.runPromise(makeProviderWorkerBroker());
    const fake = makeConnection();
    await Effect.runPromise(broker.expectWorker(fence));
    await Effect.runPromise(broker.register(fence, fake.connection));
    const nextEvent = Effect.runPromise(Stream.runHead(broker.streamEvents));

    const frame = {
      protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
      ...fence,
      type: "event" as const,
      sequence: 1,
      event: {
        eventId: "event-1",
        provider: "pi" as const,
        type: "session.state.changed" as const,
        threadId: "thread-1" as never,
        createdAt: "2026-08-05T01:00:00.000Z",
        payload: { state: "ready" as const },
      },
    };
    await Effect.runPromise(broker.accept(frame));
    const event = await nextEvent;
    expect(Option.getOrUndefined(event)?.eventId).toBe("event-1");
    expect(fake.sent.at(-1)).toMatchObject({
      type: "heartbeat",
      acknowledgedSequence: 1,
    });

    fake.sent.length = 0;
    await Effect.runPromise(broker.accept(frame));
    expect(fake.sent.at(-1)).toMatchObject({
      type: "heartbeat",
      acknowledgedSequence: 1,
    });
    const gap = await Effect.runPromise(
      broker.accept({
        ...frame,
        sequence: 3,
        event: { ...frame.event, eventId: "event-3" as never },
      }).pipe(Effect.result),
    );
    expect(gap._tag).toBe("Failure");
  });

  it("preserves the acknowledged event sequence across worker reconnects", async () => {
    const broker = await Effect.runPromise(makeProviderWorkerBroker());
    const first = makeConnection();
    await Effect.runPromise(broker.expectWorker(fence));
    await Effect.runPromise(broker.register(fence, first.connection));
    const event = {
      eventId: "event-1",
      provider: "pi" as const,
      type: "session.state.changed" as const,
      threadId: "thread-1" as never,
      createdAt: "2026-08-05T01:00:00.000Z",
      payload: { state: "ready" as const },
    };
    const firstRead = Effect.runPromise(Stream.runHead(broker.streamEvents));
    await Effect.runPromise(
      broker.accept({
        protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
        ...fence,
        type: "event",
        sequence: 1,
        event,
      }),
    );
    await firstRead;
    await Effect.runPromise(broker.disconnect(fence));

    const second = makeConnection();
    await Effect.runPromise(broker.register(fence, second.connection));
    const secondRead = Effect.runPromise(Stream.runHead(broker.streamEvents));
    await Effect.runPromise(
      broker.accept({
        protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
        ...fence,
        type: "event",
        sequence: 1,
        event,
      }),
    );
    await Effect.runPromise(
      broker.accept({
        protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
        ...fence,
        type: "event",
        sequence: 2,
        event: { ...event, eventId: "event-2" as never },
      }),
    );

    expect(Option.getOrUndefined(await secondRead)?.eventId).toBe("event-2");
  });

  it("times out a request and removes its correlation", async () => {
    const broker = await Effect.runPromise(makeProviderWorkerBroker({ requestTimeoutMs: 5 }));
    const fake = makeConnection();
    await Effect.runPromise(broker.expectWorker(fence));
    await Effect.runPromise(broker.register(fence, fake.connection));

    const result = await Effect.runPromise(
      broker.request(fence, "session.has", { threadId: "thread-1" }).pipe(Effect.result),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("request.timeout");
  });

  it("retires the exact worker fence and removes its reconnect reservation", async () => {
    const broker = await Effect.runPromise(makeProviderWorkerBroker());
    const fake = makeConnection();
    await Effect.runPromise(broker.expectWorker(fence));
    await Effect.runPromise(broker.register(fence, fake.connection));

    await Effect.runPromise(broker.retire(fence, "session stopped"));

    expect(fake.sent.at(-1)).toMatchObject({
      ...fence,
      type: "retire",
      reason: "session stopped",
    });
    expect(fake.closeCount).toBe(1);
    await expect(Effect.runPromise(broker.waitForConnection(fence))).rejects.toMatchObject({
      operation: "waitForConnection",
    });
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
  throw new Error("condition was not reached");
}
