import type { ProviderRuntimeEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { ProviderWorkerTransportError } from "./Errors";
import { makeProviderWorkerOutbox } from "./workerOutbox";

const fence = {
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
} as const;

const event = (eventId: string): ProviderRuntimeEvent => ({
  eventId: eventId as never,
  provider: "pi",
  type: "session.state.changed",
  threadId: "thread-1" as never,
  createdAt: "2026-08-05T01:00:00.000Z",
  payload: { state: "ready" },
});

describe("ProviderWorkerOutbox", () => {
  it("sequences events and retains them until acknowledged", () => {
    const outbox = makeProviderWorkerOutbox(fence, 4);

    expect(outbox.push(event("event-1")).sequence).toBe(1);
    expect(outbox.push(event("event-2")).sequence).toBe(2);
    expect(outbox.pending().map((frame) => frame.sequence)).toEqual([1, 2]);

    outbox.acknowledge(1);
    expect(outbox.pending().map((frame) => frame.sequence)).toEqual([2]);
  });

  it("ignores stale acknowledgements and rejects impossible future ones", () => {
    const outbox = makeProviderWorkerOutbox(fence, 4);
    outbox.push(event("event-1"));
    outbox.acknowledge(0);
    expect(outbox.pending()).toHaveLength(1);
    expect(() => outbox.acknowledge(2)).toThrow(ProviderWorkerTransportError);
  });

  it("fails closed instead of dropping canonical events on overflow", () => {
    const outbox = makeProviderWorkerOutbox(fence, 1);
    outbox.push(event("event-1"));

    expect(() => outbox.push(event("event-2"))).toThrow(ProviderWorkerTransportError);
    expect(outbox.pending()).toHaveLength(1);
  });
});
