import { describe, expect, it } from "vitest";

import { isAllowedGlasswingEmail, toEffectCookieTuples } from "./SuperTokensAuth";

describe("SuperTokensAuth", () => {
  it("accepts Glasswing addresses case-insensitively and rejects suffix tricks", () => {
    expect(isAllowedGlasswingEmail("Person@Glasswing.VC")).toBe(true);
    expect(isAllowedGlasswingEmail("person@glasswing.vc.evil.test")).toBe(false);
    expect(isAllowedGlasswingEmail("glasswing.vc@example.test")).toBe(false);
  });

  it("preserves cookie attributes returned by SuperTokens", () => {
    expect(
      toEffectCookieTuples([
        {
          key: "sAccessToken",
          value: "token",
          domain: undefined,
          secure: true,
          httpOnly: true,
          expires: 1_800_000_000_000,
          path: "/",
          sameSite: "lax",
        },
      ]),
    ).toEqual([
      [
        "sAccessToken",
        "token",
        {
          secure: true,
          httpOnly: true,
          expires: new Date(1_800_000_000_000),
          path: "/",
          sameSite: "lax",
        },
      ],
    ]);
  });
});
