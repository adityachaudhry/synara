import { describe, expect, it } from "vitest";

import { resolveDistributedPiRuntimeConfig } from "./distributedRuntimeConfig";

describe("resolveDistributedPiRuntimeConfig", () => {
  it("stays disabled when Railway is not configured", () => {
    expect(resolveDistributedPiRuntimeConfig({ environment: {} })).toEqual({ enabled: false });
  });

  it("requires a worker control URL when Railway is enabled", () => {
    expect(() =>
      resolveDistributedPiRuntimeConfig({
        environment: {
          SYNARA_RAILWAY_SANDBOX_TOKEN: "token",
          SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID: "environment",
        },
      }),
    ).toThrow(/SYNARA_PROVIDER_WORKER_CONTROL_URL/);
  });

  it("forwards only an explicit provider credential allowlist", () => {
    const config = resolveDistributedPiRuntimeConfig({
      environment: {
        SYNARA_RAILWAY_SANDBOX_TOKEN: "railway-secret",
        SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID: "environment",
        SYNARA_PROVIDER_WORKER_CONTROL_URL:
          "http://synara.railway.internal:3000/internal/provider-worker",
        OPENAI_API_KEY: "openai-secret",
        SYNARA_PROVIDER_WORKER_REPOSITORY_AUTHORIZATION: "token repository-secret",
        RANDOM_SECRET: "must-not-forward",
      },
    });

    expect(config).toMatchObject({
      enabled: true,
      controlUrl: "ws://synara.railway.internal:3000/internal/provider-worker",
      workerEnvironment: { OPENAI_API_KEY: "openai-secret" },
      repositoryAuthorization: "token repository-secret",
    });
    if (!config.enabled) throw new Error("expected enabled configuration");
    expect(JSON.stringify(config.workerEnvironment)).not.toContain("railway-secret");
    expect(JSON.stringify(config.workerEnvironment)).not.toContain("repository-secret");
    expect(JSON.stringify(config.workerEnvironment)).not.toContain("must-not-forward");
  });
});
