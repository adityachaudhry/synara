import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useMemo, type CSSProperties, type ReactNode } from "react";

import { AppHistoryProvider, appHistory } from "./appNavigation";
import type { SynaraHistory } from "./embeddedHistory";
import { getAppTypographyScale } from "./lib/appTypography";
import { createHostThemeStyle } from "./lib/hostThemeStyle";
import { getRouter } from "./router";
import { configureSynaraRuntime, type SynaraRuntimeConfig } from "./synaraRuntimeConfig";

export interface SynaraHostSidebar {
  readonly widthPx: number;
  readonly lockedOpen?: boolean;
  readonly showProjectTitle?: boolean;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
}

export interface SynaraHostTheme {
  readonly fontFamilySans?: string;
  readonly fontFamilySerif?: string;
  readonly colorSurface?: string;
  readonly colorSurfaceSubtle?: string;
  readonly colorText?: string;
  readonly colorTextMuted?: string;
  readonly colorBorder?: string;
  readonly colorBrand?: string;
  readonly colorSelection?: string;
  readonly colorSelectionText?: string;
  readonly colorFocusRing?: string;
  readonly controlRadiusPx?: number;
  readonly toolbarHeightPx?: number;
  readonly controlHeightPx?: number;
  readonly threadRowHeightPx?: number;
  readonly threadActionSizePx?: number;
  readonly chatFontSizePx?: number;
  readonly chatMetaFontSizePx?: number;
}

export interface SynaraAppProps extends SynaraRuntimeConfig {
  readonly history?: SynaraHistory;
  readonly hostSidebar?: SynaraHostSidebar;
  readonly hostTheme?: SynaraHostTheme;
  readonly embeddedBaseFontSizePx?: number;
}

function embeddedTypographyStyle(value: number | undefined): CSSProperties | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const scale = getAppTypographyScale(value);
  return {
    "--app-font-size-base": `${scale.basePx}px`,
    "--app-font-size-ui": `${scale.uiPx}px`,
    "--app-font-size-ui-lg": `${scale.uiLgPx}px`,
    "--app-font-size-ui-sm": `${scale.uiSmPx}px`,
    "--app-font-size-ui-xs": `${scale.uiXsPx}px`,
    "--app-font-size-ui-2xs": `${scale.ui2XsPx}px`,
    "--app-font-size-ui-meta": `${scale.uiMetaPx}px`,
    "--app-font-size-ui-timestamp": `${scale.uiTimestampPx}px`,
    "--app-font-size-chat": `${scale.chatPx}px`,
    "--app-font-size-chat-code": `${scale.chatCodePx}px`,
    "--app-font-size-chat-meta": `${scale.chatMetaPx}px`,
    "--app-font-size-chat-tiny": `${scale.chatTinyPx}px`,
  } as CSSProperties;
}

export function SynaraApp({
  history = appHistory,
  httpBaseUrl,
  resolveWebSocketUrl,
  project,
  hostSidebar,
  hostTheme,
  embeddedBaseFontSizePx,
}: SynaraAppProps) {
  configureSynaraRuntime({
    ...(httpBaseUrl ? { httpBaseUrl } : {}),
    ...(resolveWebSocketUrl ? { resolveWebSocketUrl } : {}),
    ...(project ? { project } : {}),
  });
  const routerHistory = history as RouterHistory;
  const router = useMemo(() => getRouter(routerHistory), [routerHistory]);
  const style = {
    position: "relative",
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    ...(hostSidebar ? { "--sidebar-width": `${hostSidebar.widthPx}px` } : {}),
    ...createHostThemeStyle(hostTheme),
    ...embeddedTypographyStyle(embeddedBaseFontSizePx),
  } as CSSProperties;

  return (
    <div data-synara-app-root data-synara-host-themed={hostTheme ? "" : undefined} style={style}>
      <AppHistoryProvider history={routerHistory}>
        <RouterProvider router={router} />
      </AppHistoryProvider>
    </div>
  );
}
