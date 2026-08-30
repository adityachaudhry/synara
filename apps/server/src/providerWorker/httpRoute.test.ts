import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderWorkerTransportError } from "./Errors";
import { mapProviderWorkerSocketRunError } from "./httpRoute";

describe("provider worker HTTP route", () => {
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
