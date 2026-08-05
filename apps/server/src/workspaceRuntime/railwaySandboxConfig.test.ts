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
        region: " us-east4-eqdc4a ",
        idleTimeoutMinutes: "30",
      }),
    ).toEqual({
      enabled: true,
      token: "secret",
      environmentId: "env-1",
      region: "us-east4-eqdc4a",
      idleTimeoutMinutes: 30,
    });
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

  it("redacts the token from diagnostics", () => {
    const config = resolveRailwaySandboxRuntimeConfig({
      token: "secret",
      environmentId: "env-1",
    });

    expect(JSON.stringify(describeRailwaySandboxRuntimeConfig(config))).not.toContain("secret");
  });
});
