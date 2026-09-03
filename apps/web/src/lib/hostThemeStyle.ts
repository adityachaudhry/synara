import type { SynaraHostTheme } from "../SynaraApp";

export type HostThemeStyle = Record<`--${string}`, string>;

function assignString(
  style: HostThemeStyle,
  value: string | undefined,
  properties: readonly `--${string}`[],
): void {
  if (typeof value !== "string" || value.trim().length === 0) return;
  for (const property of properties) style[property] = value.trim();
}

function assignPixels(
  style: HostThemeStyle,
  value: number | undefined,
  properties: readonly `--${string}`[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
  for (const property of properties) style[property] = `${value}px`;
}

export function createHostThemeStyle(
  theme: SynaraHostTheme | null | undefined,
): HostThemeStyle {
  const style: HostThemeStyle = {};
  if (!theme) return style;

  assignString(style, theme.fontFamilySans, ["--font-ui-family", "--theme-font-ui-family"]);
  assignString(style, theme.fontFamilySerif, ["--font-display-family"]);
  assignString(style, theme.colorSurface, [
    "--background",
    "--card",
    "--popover",
    "--sidebar",
    "--color-background-surface",
    "--color-background-surface-under",
    "--app-shell-background",
    "--app-sidebar-surface",
  ]);
  assignString(style, theme.colorSurfaceSubtle, [
    "--secondary",
    "--muted",
    "--accent",
    "--sidebar-accent",
    "--color-background-button-secondary",
    "--color-background-button-secondary-hover",
  ]);
  assignString(style, theme.colorText, [
    "--foreground",
    "--card-foreground",
    "--popover-foreground",
    "--secondary-foreground",
    "--accent-foreground",
    "--sidebar-foreground",
    "--color-text-foreground",
  ]);
  assignString(style, theme.colorTextMuted, [
    "--muted-foreground",
    "--color-text-foreground-secondary",
  ]);
  assignString(style, theme.colorBorder, [
    "--border",
    "--input",
    "--sidebar-border",
    "--app-surface-divider",
  ]);
  assignString(style, theme.colorBrand, ["--brand", "--destructive", "--color-primary"]);
  assignString(style, theme.colorSelection, ["--sidebar-accent-active"]);
  assignString(style, theme.colorSelectionText, ["--sidebar-accent-foreground"]);
  assignString(style, theme.colorFocusRing, ["--ring", "--sidebar-ring"]);
  assignString(style, theme.colorCurrentUserMessage, ["--app-current-user-message-background"]);
  assignString(style, theme.colorCurrentUserMessageText, ["--app-user-message-text"]);
  assignString(style, theme.colorOtherUserMessage, ["--app-other-user-message-background"]);
  assignString(style, theme.colorComposerBorder, ["--app-composer-border"]);
  assignPixels(style, theme.composerBorderWidthPx, ["--app-composer-border-width"]);
  assignPixels(style, theme.controlRadiusPx, ["--radius", "--app-header-control-radius"]);
  assignPixels(style, theme.toolbarHeightPx, ["--app-chat-header-height"]);
  assignPixels(style, theme.controlHeightPx, ["--app-header-control-height"]);
  assignPixels(style, theme.threadRowHeightPx, ["--app-density-row-height"]);
  assignPixels(style, theme.threadActionSizePx, ["--app-sidebar-row-action-size"]);
  assignPixels(style, theme.chatFontSizePx, ["--app-font-size-chat"]);
  assignPixels(style, theme.chatMetaFontSizePx, ["--app-font-size-chat-meta"]);
  return style;
}
