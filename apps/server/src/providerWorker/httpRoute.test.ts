import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderWorkerBrokerError, ProviderWorkerTransportError } from "./Errors";
import {
  mapProviderWorkerSocketRunError,
  providerWorkerTransportDiagnostic,
} from "./httpRoute";

describe("provider worker HTTP route", () => {
  it("retains the exact nested broker rejection in its structured diagnostic", () => {
    const brokerFailure = new ProviderWorkerBrokerError({
      operation: "event.sequence",
      detail: "Expected worker event sequence 7, received 8.",
      sandboxId: "sandbox-1",
    });
    const transportFailure = new ProviderWorkerTransportError({
      operation: "frame.accept",
      detail: "Worker frame was rejected.",
      cause: brokerFailure,
    });

    expect(providerWorkerTransportDiagnostic(transportFailure)).toEqual({
      operation: "frame.accept",
      detail: "Worker frame was rejected.",
      causeTag: "ProviderWorkerBrokerError",
      causeOperation: "event.sequence",
      causeDetail: "Expected worker event sequence 7, received 8.",
      sandboxId: "sandbox-1",
    });
  });

  it("preserves structured protocol failures from the connection handler", () => {
    const failure = new ProviderWorkerTransportError({
      operation: "register.auth",
      detail: "Worker authentication failed.",
    });

    expect(mapProviderWorkerSocketRunError(failure)).toBe(failure);
  });

  it("wraps raw socket failures as read transport errors", () => {
    const failure = new Error("socket closed");
    const mapped = mapProviderWorkerSocketRunError(failure);

    expect(mapped).toMatchObject({
      operation: "read",
      detail: "Provider worker WebSocket read failed.",
      cause: failure,
    });
  });
});
