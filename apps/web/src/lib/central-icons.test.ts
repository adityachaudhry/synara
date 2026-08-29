import { describe, expect, it } from "vitest";

import { getCentralIconUrl } from "./central-icons";

describe("central icon package assets", () => {
  it("resolves both icon variants without root-absolute public URLs", () => {
    const reversed = getCentralIconUrl("arrow-up", "reversed");
    const fill = getCentralIconUrl("arrow-up", "fill");

    expect(reversed).toBeTruthy();
    expect(fill).toBeTruthy();
    expect(reversed).not.toMatch(/^\/central-icons-/);
    expect(fill).not.toMatch(/^\/central-icons-/);
  });
});
