import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderWorkerTransportError } from "./Errors";
import { authenticateProviderWorkerUpgrade, mapProviderWorkerSocketRunError } from "./httpRoute";
import { makeProviderWorkerBootstrapAuthority } from "./Layers/ProviderWorkerBootstrapAuthority";

const fence = {
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
} as const;

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

  it("authenticates the worker before upgrade using a non-URL bearer credential", async () => {
    const authority = await Effect.runPromise(makeProviderWorkerBootstrapAuthority());
    const credential = await Effect.runPromise(authority.issue(fence));

    await expect(
      Effect.runPromise(
        authenticateProviderWorkerUpgrade(
          { authorization: `Bearer ${credential}` },
          authority,
        ),
      ),
    ).resolves.toEqual(fence);
  });

  it("rejects browser-origin and unauthenticated upgrades before socket allocation", async () => {
    const authority = await Effect.runPromise(makeProviderWorkerBootstrapAuthority());
    const credential = await Effect.runPromise(authority.issue(fence));

    await expect(
      Effect.runPromise(
        authenticateProviderWorkerUpgrade(
          { authorization: `Bearer ${credential}`, origin: "https://browser.example" },
          authority,
        ),
      ),
    ).rejects.toMatchObject({ operation: "upgrade.origin" });
    await expect(
      Effect.runPromise(authenticateProviderWorkerUpgrade({}, authority)),
    ).rejects.toMatchObject({ operation: "upgrade.auth" });
  });
});
