import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeProviderWorkerBootstrapAuthority } from "./ProviderWorkerBootstrapAuthority";

const fence = {
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
} as const;

describe("ProviderWorkerBootstrapAuthority", () => {
  it("authorizes only the credential issued for the exact worker fence", async () => {
    const authority = await Effect.runPromise(makeProviderWorkerBootstrapAuthority());
    const credential = await Effect.runPromise(authority.issue(fence));

    await expect(
      Effect.runPromise(authority.authorize(fence, credential)),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(authority.authorize(fence, "wrong-credential")),
    ).rejects.toMatchObject({ operation: "authorize" });
    await expect(
      Effect.runPromise(
        authority.authorize({ ...fence, lifecycleGeneration: "generation-2" }, credential),
      ),
    ).rejects.toMatchObject({ operation: "authorize" });
  });

  it("allows the exact worker to reconnect until the credential is revoked", async () => {
    const authority = await Effect.runPromise(makeProviderWorkerBootstrapAuthority());
    const credential = await Effect.runPromise(authority.issue(fence));

    await Effect.runPromise(authority.authorize(fence, credential));
    await Effect.runPromise(authority.authorize(fence, credential));
    await Effect.runPromise(authority.revoke(fence));

    await expect(
      Effect.runPromise(authority.authorize(fence, credential)),
    ).rejects.toMatchObject({ operation: "authorize" });
  });

  it("rotates an old credential when the same generation is reissued", async () => {
    const authority = await Effect.runPromise(makeProviderWorkerBootstrapAuthority());
    const first = await Effect.runPromise(authority.issue(fence));
    const second = await Effect.runPromise(authority.issue(fence));

    expect(first).not.toBe(second);
    await expect(
      Effect.runPromise(authority.authorize(fence, first)),
    ).rejects.toMatchObject({ operation: "authorize" });
    await expect(
      Effect.runPromise(authority.authorize(fence, second)),
    ).resolves.toBeUndefined();
  });
});
