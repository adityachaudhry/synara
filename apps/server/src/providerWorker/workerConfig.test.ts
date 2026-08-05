import { describe, expect, it } from "vitest";

import { resolveProviderWorkerConfig } from "./workerConfig";

const valid = {
  controlUrl: "http://synara.railway.internal:3773/internal/provider-worker",
  bootstrapCredential: "bootstrap-secret",
  sandboxId: "ef1b4542-d435-4aae-b8bb-e531685e3cc6",
  workerId: "b15c8b3e-50f7-474f-aef6-becf83ecae31",
  lifecycleGeneration: "generation-1",
  cwd: "/workspace",
};

describe("resolveProviderWorkerConfig", () => {
  it("normalizes the private HTTP control URL to WebSocket", () => {
    const config = resolveProviderWorkerConfig(valid);

    expect(config.controlUrl).toBe(
      "ws://synara.railway.internal:3773/internal/provider-worker",
    );
    expect(config.cwd).toBe("/workspace");
  });

  it("rejects partial or invalid worker identity", () => {
    expect(() =>
      resolveProviderWorkerConfig({ ...valid, workerId: "not-a-uuid" }),
    ).toThrow(/workerId/);
    expect(() =>
      resolveProviderWorkerConfig({ ...valid, bootstrapCredential: "" }),
    ).toThrow(/bootstrapCredential/);
  });

  it("never includes the bootstrap credential in its safe description", () => {
    const config = resolveProviderWorkerConfig(valid);

    expect(JSON.stringify(config.safeDescription)).not.toContain("bootstrap-secret");
  });
});
