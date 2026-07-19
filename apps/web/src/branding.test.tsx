// FILE: branding.test.tsx
// Purpose: Locks the Glasswing product identity used by browser chrome and shared brand surfaces.
// Layer: Web branding tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { APP_BASE_NAME } from "./branding";
import { GlasswingBrand } from "./components/GlasswingBrand";
import { CODE_THEME_OPTIONS, DEFAULT_THEME_STATE } from "./theme/theme.logic";
import { THEME_SEED_CATALOG } from "./theme/theme.seed.generated";

describe("Glasswing branding", () => {
  it("uses Glasswing AI as the product name", () => {
    expect(APP_BASE_NAME).toBe("Glasswing AI");
  });

  it("renders the official Glasswing mark and wordmark variants", () => {
    const mark = renderToStaticMarkup(<GlasswingBrand variant="mark" />);
    const wordmark = renderToStaticMarkup(<GlasswingBrand variant="wordmark" />);

    expect(mark).toContain('/brand/glasswing-mark.svg');
    expect(mark).toContain('alt="Glasswing AI"');
    expect(wordmark).toContain('/brand/glasswing-logo.svg');
    expect(wordmark).toContain('alt="Glasswing AI"');
  });

  it("uses the Glasswing red for the default theme accent", () => {
    expect(THEME_SEED_CATALOG.synara?.light?.accent).toBe("#d90a2e");
    expect(THEME_SEED_CATALOG.synara?.dark?.accent).toBe("#e52d4f");
    expect(DEFAULT_THEME_STATE.codeThemeIds).toEqual({ dark: "synara", light: "synara" });
    expect(DEFAULT_THEME_STATE.chromeThemes.light.accent).toBe("#d90a2e");
    expect(DEFAULT_THEME_STATE.chromeThemes.dark.accent).toBe("#e52d4f");
    expect(CODE_THEME_OPTIONS.find(({ id }) => id === "synara")?.label).toBe("Glasswing");
  });
});
