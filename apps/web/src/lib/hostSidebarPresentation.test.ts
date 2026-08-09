import { describe, expect, it } from "vitest";

import { resolveHostSidebarPresentation } from "./hostSidebarPresentation";

describe("resolveHostSidebarPresentation", () => {
  it("locks a host sidebar to its requested screen width without collapse or resize controls", () => {
    const presentation = resolveHostSidebarPresentation(
      { widthPx: 320, lockedOpen: true },
      1.3,
    );

    expect(presentation).toEqual({
      collapsible: "none",
      resizable: false,
      showSeamRail: false,
      width: `${320 / 1.3}px`,
    });
  });

  it("preserves the standalone sidebar presentation when no host adapter is supplied", () => {
    expect(resolveHostSidebarPresentation(null, undefined)).toEqual({
      collapsible: "offcanvas",
      resizable: true,
      showSeamRail: true,
      width: null,
    });
  });

  it("ignores invalid host widths instead of poisoning the sidebar CSS variable", () => {
    expect(resolveHostSidebarPresentation({ widthPx: 0, lockedOpen: true }, 1.3)).toEqual({
      collapsible: "none",
      resizable: false,
      showSeamRail: false,
      width: null,
    });
  });
});
