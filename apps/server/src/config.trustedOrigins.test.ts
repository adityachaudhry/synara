// FILE: config.trustedOrigins.test.ts
// Purpose: Pins parsing and validation of embedding-host origins.
// Layer: Server configuration tests

import { describe, expect, it } from "vitest";

import { resolveTrustedAppOrigins } from "./config";

describe("resolveTrustedAppOrigins", () => {
  it("normalizes a comma-separated list into exact origins", () => {
    expect(
      [...resolveTrustedAppOrigins(" https://app.glasswing.vc, http://localhost:3000 ")],
    ).toEqual(["https://app.glasswing.vc", "http://localhost:3000"]);
  });

  it("rejects paths, wildcards, and non-HTTP origins", () => {
    for (const value of [
      "https://app.glasswing.vc/path",
      "https://*.glasswing.vc",
      "synara://app",
    ]) {
      expect(() => resolveTrustedAppOrigins(value)).toThrow("Invalid trusted app origin");
    }
  });
});
