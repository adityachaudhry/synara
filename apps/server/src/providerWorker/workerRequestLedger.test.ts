import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import { makeProviderWorkerRequestLedger } from "./workerRequestLedger";

const fence = {
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
} as const;

describe("ProviderWorkerRequestLedger", () => {
  it("replays one retained response without executing a duplicated turn", async () => {
    const sendTurn = vi.fn(() =>
      Effect.succeed({ providerThreadId: "pi-thread-1", turnId: "turn-1" as never }),
    );
    const adapter = {
      provider: "pi",
      capabilities: { sessionModelSwitch: "in-session" },
      sendTurn,
      streamEvents: Stream.empty,
    } as unknown as ProviderAdapterShape<never>;
    const ledger = makeProviderWorkerRequestLedger({ fence, adapter });
    const request = {
      protocolVersion: 1 as const,
      ...fence,
      type: "request" as const,
      requestId: "request-1",
      method: "turn.send" as const,
      params: { threadId: "thread-1" as never, prompt: "hello" },
    };

    const first = await Effect.runPromise(ledger.execute(request));
    const replay = await Effect.runPromise(ledger.execute(request));

    expect(first).toEqual(replay);
    expect(sendTurn).toHaveBeenCalledOnce();
    expect(ledger.pending()).toEqual([first]);
    ledger.acknowledge("request-1");
    expect(ledger.pending()).toEqual([]);

    const lateReplay = await Effect.runPromise(ledger.execute(request));
    expect(lateReplay).toEqual(first);
    expect(sendTurn).toHaveBeenCalledOnce();
  });
});
