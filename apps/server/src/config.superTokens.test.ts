import { describe, expect, it } from "vitest";

import { resolveSuperTokensRuntimeConfig } from "./config";

describe("resolveSuperTokensRuntimeConfig", () => {
  it("keeps SuperTokens disabled when every setting is absent", () => {
    expect(resolveSuperTokensRuntimeConfig({})).toEqual({ enabled: false });
  });

  it("fails closed when configuration is partial", () => {
    expect(() =>
      resolveSuperTokensRuntimeConfig({ coreUrl: new URL("http://supertokens:3567") }),
    ).toThrow(/SUPERTOKENS_API_KEY/);
  });

  it("normalizes complete configuration", () => {
    expect(
      resolveSuperTokensRuntimeConfig({
        coreUrl: new URL("http://supertokens:3567"),
        apiKey: " v4-secret ",
        apiDomain: new URL("https://synara.example.test/"),
        websiteDomain: new URL("https://synara.example.test/"),
      }),
    ).toEqual({
      enabled: true,
      coreUrl: "http://supertokens:3567",
      apiKey: "v4-secret",
      apiDomain: "https://synara.example.test",
      websiteDomain: "https://synara.example.test",
    });
  });
});
