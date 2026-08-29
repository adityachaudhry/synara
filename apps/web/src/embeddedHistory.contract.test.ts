import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("public embedded history contract", () => {
  it("exports TanStack's complete RouterHistory without an unsafe app cast", async () => {
    const [historySource, appSource] = await Promise.all([
      fs.readFile(new URL("./embeddedHistory.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("./SynaraApp.tsx", import.meta.url), "utf8"),
    ]);

    expect(historySource).toContain("export type SynaraHistory = RouterHistory");
    expect(appSource).not.toContain("history as RouterHistory");
  });
});
