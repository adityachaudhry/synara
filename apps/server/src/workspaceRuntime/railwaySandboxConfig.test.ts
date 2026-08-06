import { describe, expect, it } from "vitest";

import {
  describeRailwaySandboxRuntimeConfig,
  resolveRailwaySandboxRuntimeConfig,
} from "./railwaySandboxConfig";

describe("resolveRailwaySandboxRuntimeConfig", () => {
  it("disables the runtime when all values are absent", () => {
    expect(resolveRailwaySandboxRuntimeConfig({})).toEqual({ enabled: false });
  });

  it("normalizes a complete configuration", () => {
    expect(
      resolveRailwaySandboxRuntimeConfig({
        token: " secret ",
      environmentId: " env-1 ",
      authType: " bearer ",
      region: " us-east4-eqdc4a ",
      idleTimeoutMinutes: "30",
      networkIsolation: " ISOLATED ",
      workerCheckpoint: " auto ",
      }),
    ).toEqual({
      enabled: true,
      token: "secret",
      environmentId: "env-1",
      authType: "bearer",
      region: "us-east4-eqdc4a",
      idleTimeoutMinutes: 30,
      networkIsolation: "ISOLATED",
      workerCheckpoint: "auto",
    });
  });

  it("supports an environment-scoped Railway project token explicitly", () => {
    expect(
      resolveRailwaySandboxRuntimeConfig({
        token: "project-secret",
        environmentId: "env-1",
        authType: "project-token",
      }),
    ).toMatchObject({
      enabled: true,
      authType: "project-token",
    });
  });

  it("rejects unknown Railway token authentication modes", () => {
    expect(() =>
      resolveRailwaySandboxRuntimeConfig({
        token: "secret",
        environmentId: "env-1",
        authType: "magic-token",
      }),
    ).toThrow(/AUTH_TYPE/);
  });

  it("fails closed for partial configuration", () => {
    expect(() => resolveRailwaySandboxRuntimeConfig({ environmentId: "env-1" })).toThrow(
      /SYNARA_RAILWAY_SANDBOX_TOKEN/,
    );
  });

  it("rejects idle timeouts outside Railway limits", () => {
    expect(() =>
      resolveRailwaySandboxRuntimeConfig({
        token: "secret",
        environmentId: "env-1",
        idleTimeoutMinutes: "121",
      }),
    ).toThrow(/1 through 120/);
  });

  it("rejects unknown sandbox network isolation modes", () => {
    expect(() =>
      resolveRailwaySandboxRuntimeConfig({
        token: "secret",
        environmentId: "env-1",
        networkIsolation: "PUBLIC",
      }),
    ).toThrow(/NETWORK_ISOLATION/);
  });

  it("redacts the token from diagnostics", () => {
    const config = resolveRailwaySandboxRuntimeConfig({
      token: "secret",
      environmentId: "env-1",
    });

    expect(JSON.stringify(describeRailwaySandboxRuntimeConfig(config))).not.toContain("secret");
  });

  it("rejects an unsafe worker checkpoint name", () => {
    expect(() =>
      resolveRailwaySandboxRuntimeConfig({
        token: "secret",
        environmentId: "env-1",
        workerCheckpoint: "../../secret",
      }),
    ).toThrow(/WORKER_CHECKPOINT/);
  });
});
