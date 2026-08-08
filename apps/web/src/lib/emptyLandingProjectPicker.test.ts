import { describe, expect, it } from "vitest";

import { resolveEmptyLandingProjectPickerMode } from "./emptyLandingProjectPicker";

describe("resolveEmptyLandingProjectPickerMode", () => {
  it("moves a local draft when its heading project changes", () => {
    expect(
      resolveEmptyLandingProjectPickerMode({
        isCenteredEmptyLanding: true,
        isLocalDraftThread: true,
        isServerThread: false,
        hasMessages: false,
        hasLatestTurn: false,
        projectKind: "project",
      }),
    ).toBe("move-draft");
  });

  it("opens a replacement draft when a prewarmed empty server thread changes projects", () => {
    expect(
      resolveEmptyLandingProjectPickerMode({
        isCenteredEmptyLanding: true,
        isLocalDraftThread: false,
        isServerThread: true,
        hasMessages: false,
        hasLatestTurn: false,
        projectKind: "project",
      }),
    ).toBe("replace-server-thread");
  });

  it("hides the project picker after conversation content exists", () => {
    expect(
      resolveEmptyLandingProjectPickerMode({
        isCenteredEmptyLanding: false,
        isLocalDraftThread: false,
        isServerThread: true,
        hasMessages: true,
        hasLatestTurn: true,
        projectKind: "project",
      }),
    ).toBe("hidden");
  });
});
