import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderWorkerClientFrame,
  ProviderWorkerServerFrame,
  PROVIDER_WORKER_PROTOCOL_VERSION,
} from "./providerWorker";

const fence = {
  protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
};

describe("provider worker protocol", () => {
  it("decodes a fenced registration frame", () => {
    const decoded = Schema.decodeUnknownSync(ProviderWorkerClientFrame)({
      ...fence,
      type: "register",
    });

    expect(decoded.type).toBe("register");
    expect(decoded.protocolVersion).toBe(1);
  });

  it("keeps bootstrap credentials out of protocol frames", () => {
    const decoded = Schema.decodeUnknownSync(ProviderWorkerClientFrame)({
      ...fence,
      type: "register",
      bootstrapCredential: "must-not-cross-the-protocol",
    });

    expect(JSON.stringify(decoded)).not.toContain("must-not-cross-the-protocol");
  });

  it("decodes response acknowledgement frames used to retire replay state", () => {
    const decoded = Schema.decodeUnknownSync(ProviderWorkerServerFrame)({
      ...fence,
      type: "response.ack",
      requestId: "request-1",
    });

    expect(decoded.type).toBe("response.ack");
  });

  it("decodes a supported adapter request", () => {
    const decoded = Schema.decodeUnknownSync(ProviderWorkerServerFrame)({
      ...fence,
      type: "request",
      requestId: "request-1",
      method: "session.start",
      params: {
        threadId: "thread-1",
        provider: "pi",
        runtimeMode: "full-access",
        cwd: "/workspace",
      },
    });

    expect(decoded.type).toBe("request");
    if (decoded.type === "request") expect(decoded.method).toBe("session.start");
  });

  it("decodes registration acknowledgement with the replay fence", () => {
    const decoded = Schema.decodeUnknownSync(ProviderWorkerServerFrame)({
      ...fence,
      type: "registered",
      acknowledgedSequence: 4,
    });

    expect(decoded.type).toBe("registered");
  });

  it("rejects unknown methods instead of forwarding arbitrary calls", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProviderWorkerServerFrame)({
        ...fence,
        type: "request",
        requestId: "request-1",
        method: "database.query",
        params: {},
      }),
    ).toThrow();
  });

  it("rejects unused discovery methods that stay on the local Pi adapter", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProviderWorkerServerFrame)({
        ...fence,
        type: "request",
        requestId: "request-1",
        method: "models.list",
        params: { provider: "pi" },
      }),
    ).toThrow();
  });

  it("rejects mismatched protocol versions", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProviderWorkerClientFrame)({
        ...fence,
        protocolVersion: 2,
        type: "heartbeat",
        sentAt: "2026-08-05T01:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects malformed sandbox and worker ids", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProviderWorkerClientFrame)({
        ...fence,
        sandboxId: "sandbox-one",
        workerId: "worker-one",
        type: "heartbeat",
        sentAt: "2026-08-05T01:00:00.000Z",
      }),
    ).toThrow();
  });

  it("decodes canonical provider events without creating another event model", () => {
    const decoded = Schema.decodeUnknownSync(ProviderWorkerClientFrame)({
      ...fence,
      type: "event",
      sequence: 1,
      event: {
        eventId: "event-1",
        provider: "pi",
        type: "session.state.changed",
        threadId: "thread-1",
        createdAt: "2026-08-05T01:00:00.000Z",
        payload: { state: "ready" },
      },
    });

    expect(decoded.type).toBe("event");
  });

  it("keeps worker failures structured and bounded to protocol responses", () => {
    const decoded = Schema.decodeUnknownSync(ProviderWorkerClientFrame)({
      ...fence,
      type: "response",
      requestId: "request-1",
      ok: false,
      error: {
        code: "provider_request_failed",
        message: "The provider rejected the request.",
        retryable: false,
      },
    });

    expect(decoded.type).toBe("response");
    if (decoded.type === "response") expect(decoded.ok).toBe(false);
  });
});
