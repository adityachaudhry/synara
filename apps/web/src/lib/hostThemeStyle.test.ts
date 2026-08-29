import { describe, expect, it } from "vitest";

import { createHostThemeStyle } from "./hostThemeStyle";

describe("createHostThemeStyle", () => {
  it("maps semantic host values onto existing Synara tokens", () => {
    expect(
      createHostThemeStyle({
        fontFamilySans: 'Inter, "Segoe UI", sans-serif',
        colorSurface: "#ffffff",
        colorSurfaceSubtle: "#fafafa",
        colorText: "#0a0a0b",
        colorTextMuted: "#71717a",
        colorBorder: "#e4e4e7",
        colorBrand: "#d90a2e",
        colorSelection: "#fceaed",
        colorSelectionText: "#d90a2e",
        colorFocusRing: "#d90a2e",
        controlRadiusPx: 8,
        toolbarHeightPx: 56,
        controlHeightPx: 36,
        threadRowHeightPx: 36,
        threadActionSizePx: 28,
      }),
    ).toMatchObject({
      "--font-ui-family": 'Inter, "Segoe UI", sans-serif',
      "--background": "#ffffff",
      "--color-background-surface": "#ffffff",
      "--secondary": "#fafafa",
      "--foreground": "#0a0a0b",
      "--muted-foreground": "#71717a",
      "--border": "#e4e4e7",
      "--brand": "#d90a2e",
      "--sidebar-accent-active": "#fceaed",
      "--sidebar-accent-foreground": "#d90a2e",
      "--ring": "#d90a2e",
      "--radius": "8px",
      "--app-chat-header-height": "56px",
      "--app-header-control-height": "36px",
      "--app-density-row-height": "36px",
      "--app-sidebar-row-action-size": "28px",
    });
  });

  it("ignores malformed values", () => {
    expect(
      createHostThemeStyle({
        colorSurface: "",
        toolbarHeightPx: Number.NaN,
        controlHeightPx: -4,
      }),
    ).toEqual({});
  });
});
