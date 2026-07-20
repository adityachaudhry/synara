// FILE: glasswingMode.ts
// Purpose: Owns the persisted Glasswing presentation-mode bootstrap and theme projection.
// Layer: Web presentation state

import { APP_SETTINGS_STORAGE_KEY } from "./appSettingsStorage";
import { GLASSWING_THEME_STATE, type ThemeState } from "./theme/theme.logic";

export const GLASSWING_MODE_ATTRIBUTE = "data-glasswing-mode";
export const DEFAULT_GLASSWING_MODE = true;

type SettingsStorageReader = Pick<Storage, "getItem">;
type AttributeTarget = Pick<Element, "setAttribute">;

export function readGlasswingMode(
  storage: SettingsStorageReader | null | undefined =
    typeof localStorage === "undefined" ? null : localStorage,
): boolean {
  if (!storage) return DEFAULT_GLASSWING_MODE;

  try {
    const storedSettings = storage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!storedSettings) return DEFAULT_GLASSWING_MODE;

    const parsed = JSON.parse(storedSettings) as { glasswingMode?: unknown };
    return parsed.glasswingMode !== false;
  } catch {
    return DEFAULT_GLASSWING_MODE;
  }
}

// Deliberately fixed for the lifetime of the page. Settings can persist a new value without
// partially applying future mode-specific behavior before the requested refresh.
const glasswingModeForCurrentPage = readGlasswingMode();

export function getGlasswingModeForCurrentPage(): boolean {
  return glasswingModeForCurrentPage;
}

export function applyGlasswingModeAttribute(root: AttributeTarget, enabled: boolean): void {
  root.setAttribute(GLASSWING_MODE_ATTRIBUTE, String(enabled));
}

export function resolveGlasswingModeThemeState(
  underlyingState: ThemeState,
  enabled: boolean,
): ThemeState {
  if (!enabled) return underlyingState;

  return {
    ...GLASSWING_THEME_STATE,
    mode: underlyingState.mode,
    systemUiFont: underlyingState.systemUiFont,
  };
}
