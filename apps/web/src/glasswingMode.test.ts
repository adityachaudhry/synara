import { describe, expect, it } from "vitest";
import {
  GLASSWING_MODE_ATTRIBUTE,
  applyGlasswingModeAttribute,
  readGlasswingMode,
  resolveGlasswingChromePresentation,
  resolveGlasswingModeThemeState,
} from "./glasswingMode";
import { DEFAULT_THEME_STATE, GLASSWING_THEME_STATE } from "./theme/theme.logic";

describe("Glasswing Mode", () => {
  it("hides Synara-only chrome while preserving it outside Glasswing mode", () => {
    expect(resolveGlasswingChromePresentation(true)).toEqual({
      sidebarThreadsTitle: "GlasswingOS",
      showKanbanNavigation: false,
      showPullRequestNavigation: false,
      showHandoffAction: false,
      showSearchAction: false,
      showActivityAction: false,
      showAutomationsAction: false,
      showProjectActions: false,
      showEnvironmentControls: false,
      showComposerRuntimeMode: false,
      showComposerWorkspaceTray: false,
      showComposerVoiceInput: false,
    });
    expect(resolveGlasswingChromePresentation(false)).toEqual({
      sidebarThreadsTitle: "Synara",
      showKanbanNavigation: true,
      showPullRequestNavigation: true,
      showHandoffAction: true,
      showSearchAction: true,
      showActivityAction: true,
      showAutomationsAction: true,
      showProjectActions: true,
      showEnvironmentControls: true,
      showComposerRuntimeMode: true,
      showComposerWorkspaceTray: true,
      showComposerVoiceInput: true,
    });
  });

  it("uses the project-scoped chrome in standalone Glasswing mode", () => {
    expect(resolveGlasswingChromePresentation(true)).toMatchObject({
      sidebarThreadsTitle: "GlasswingOS",
      showKanbanNavigation: false,
      showPullRequestNavigation: false,
      showHandoffAction: false,
      showSearchAction: false,
      showActivityAction: false,
      showAutomationsAction: false,
      showProjectActions: false,
      showEnvironmentControls: false,
      showComposerRuntimeMode: false,
      showComposerWorkspaceTray: false,
      showComposerVoiceInput: false,
    });
  });

  it("defaults on for missing or unreadable settings", () => {
    expect(readGlasswingMode({ getItem: () => null })).toBe(true);
    expect(readGlasswingMode({ getItem: () => "not-json" })).toBe(true);
  });

  it("only disables when the persisted setting is explicitly false", () => {
    expect(readGlasswingMode({ getItem: () => JSON.stringify({ glasswingMode: false }) })).toBe(
      false,
    );
    expect(readGlasswingMode({ getItem: () => JSON.stringify({ glasswingMode: true }) })).toBe(true);
    expect(readGlasswingMode({ getItem: () => JSON.stringify({}) })).toBe(true);
  });

  it("projects the Glasswing pack without overwriting mode or font preferences", () => {
    const underlying = {
      ...DEFAULT_THEME_STATE,
      mode: "dark" as const,
      systemUiFont: false,
    };

    expect(resolveGlasswingModeThemeState(underlying, false)).toBe(underlying);
    expect(resolveGlasswingModeThemeState(underlying, true)).toEqual({
      ...GLASSWING_THEME_STATE,
      mode: "dark",
      systemUiFont: false,
    });
  });

  it("writes one stable root attribute for future mode-specific styling", () => {
    const attributes = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };

    applyGlasswingModeAttribute(root, true);
    expect(attributes.get(GLASSWING_MODE_ATTRIBUTE)).toBe("true");

    applyGlasswingModeAttribute(root, false);
    expect(attributes.get(GLASSWING_MODE_ATTRIBUTE)).toBe("false");
  });
});
