import { PROVIDER_WORKER_PROTOCOL_VERSION } from "@synara/contracts";
import { Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeProviderWorkerBootstrapAuthority } from "./Layers/ProviderWorkerBootstrapAuthority";
import { makeProviderWorkerBroker } from "./Layers/ProviderWorkerBroker";
import {
  runProviderWorkerConnection,
  type ProviderWorkerSocket,
} from "./providerWorkerConnection";

const fence = {
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
} as const;

const registerFrame = (credential: string) =>
  JSON.stringify({
    protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
    ...fence,
    type: "register",
    bootstrapCredential: credential,
  });

const makeSocket = (frames: ReadonlyArray<string>, holdOpen = false) =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>();
    const sent: string[] = [];
    const closeEvents: Array<{ code: number; reason: string }> = [];
    const socket: ProviderWorkerSocket = {
      run: (handler) =>
        Effect.forEach(frames, handler, { discard: true }).pipe(
          Effect.andThen(holdOpen ? Deferred.await(closed) : Effect.void),
        ),
      sendRaw: (frame) => Effect.sync(() => sent.push(frame)),
      close: (code, reason) =>
        Effect.sync(() => closeEvents.push({ code, reason })).pipe(
          Effect.andThen(Deferred.succeed(closed, undefined)),
          Effect.asVoid,
        ),
    };
    return { socket, sent, closeEvents };
  });

describe("runProviderWorkerConnection", () => {
  it("authenticates registration and returns the replay acknowledgement", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* makeProviderWorkerBootstrapAuthority();
        const broker = yield* makeProviderWorkerBroker();
        const credential = yield* authority.issue(fence);
        yield* broker.expectWorker(fence);
        const fake = yield* makeSocket([registerFrame(credential)]);

        yield* runProviderWorkerConnection({
          socket: fake.socket,
          authority,
          broker,
          registrationTimeoutMs: 100,
        });
        return fake;
      }).pipe(Effect.scoped),
    );

    expect(result.closeEvents).toEqual([]);
    expect(JSON.parse(result.sent[0] ?? "{}")).toMatchObject({
      type: "registered",
      acknowledgedSequence: 0,
      ...fence,
    });
  });

  it("disconnects a registered fence when its socket closes so it can reconnect", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* makeProviderWorkerBootstrapAuthority();
        const broker = yield* makeProviderWorkerBroker();
        const credential = yield* authority.issue(fence);
        yield* broker.expectWorker(fence);
        const first = yield* makeSocket([registerFrame(credential)]);
        const second = yield* makeSocket([registerFrame(credential)]);

        yield* runProviderWorkerConnection({
          socket: first.socket,
          authority,
          broker,
          registrationTimeoutMs: 100,
        });
        const secondExit = yield* runProviderWorkerConnection({
          socket: second.socket,
          authority,
          broker,
          registrationTimeoutMs: 100,
        }).pipe(Effect.result);
        return { second, secondExit };
      }).pipe(Effect.scoped),
    );

    expect(result.secondExit._tag).toBe("Success");
    expect(JSON.parse(result.second.sent[0] ?? "{}")).toMatchObject({
      type: "registered",
      ...fence,
    });
  });

  it("closes a worker that presents the wrong bootstrap credential", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* makeProviderWorkerBootstrapAuthority();
        const broker = yield* makeProviderWorkerBroker();
        yield* authority.issue(fence);
        yield* broker.expectWorker(fence);
        const fake = yield* makeSocket([registerFrame("wrong-credential")]);
        const exit = yield* runProviderWorkerConnection({
          socket: fake.socket,
          authority,
          broker,
          registrationTimeoutMs: 100,
        }).pipe(Effect.result);
        return { fake, exit };
      }).pipe(Effect.scoped),
    );

    expect(result.exit._tag).toBe("Failure");
    expect(result.fake.closeEvents).toEqual([
      { code: 4400, reason: "Provider worker protocol rejected" },
    ]);
  });

  it("rejects malformed JSON before it reaches the broker", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* makeProviderWorkerBootstrapAuthority();
        const broker = yield* makeProviderWorkerBroker();
        const fake = yield* makeSocket(["not-json"]);
        const exit = yield* runProviderWorkerConnection({
          socket: fake.socket,
          authority,
          broker,
          registrationTimeoutMs: 100,
        }).pipe(Effect.result);
        return { fake, exit };
      }).pipe(Effect.scoped),
    );

    expect(result.exit._tag).toBe("Failure");
    expect(result.fake.sent).toEqual([]);
    expect(result.fake.closeEvents[0]?.code).toBe(4400);
  });

  it("closes idle sockets that do not register before the deadline", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* makeProviderWorkerBootstrapAuthority();
        const broker = yield* makeProviderWorkerBroker();
        const fake = yield* makeSocket([], true);
        const exit = yield* runProviderWorkerConnection({
          socket: fake.socket,
          authority,
          broker,
          registrationTimeoutMs: 5,
        }).pipe(Effect.result);
        return { fake, exit };
      }).pipe(Effect.scoped),
    );

    expect(result.exit._tag).toBe("Failure");
    expect(result.fake.closeEvents[0]).toEqual({
      code: 4400,
      reason: "Provider worker registration timed out",
    });
  });
});
