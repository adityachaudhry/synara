import { RouterProvider } from "@tanstack/react-router";
import { useMemo, useRef, type CSSProperties } from "react";

import { AppHistoryProvider, appHistory } from "./appNavigation";
import type { SynaraHistory } from "./embeddedHistory";
import { SynaraHostPortalProvider } from "./hostPortal";
import { SynaraHostSidebarProvider, type SynaraHostSidebar } from "./hostSidebar";
import { getAppTypographyScale } from "./lib/appTypography";
import { createHostThemeStyle } from "./lib/hostThemeStyle";
import { getRouter } from "./router";
import { configureSynaraRuntime, type SynaraRuntimeConfig } from "./synaraRuntimeConfig";

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
  readonly colorCurrentUserMessage?: string;
  readonly colorCurrentUserMessageText?: string;
  readonly colorOtherUserMessage?: string;
  readonly colorComposerBorder?: string;
  /** Border of the panels stacked on the composer (workflow card, subagent strip). */
  readonly colorStackedPanelBorder?: string;
  /** Agent status dots and labels in the subagent strip and workflow card. */
  readonly colorAgentRunning?: string;
  readonly colorAgentRunningText?: string;
  readonly colorAgentCompleted?: string;
  readonly colorAgentCompletedText?: string;
  readonly colorAgentFailed?: string;
  readonly colorAgentFailedText?: string;
  readonly colorAgentStopped?: string;
  readonly colorAgentStoppedText?: string;
  readonly colorAgentQueued?: string;
  /** Workflow card text tiers and the current phase in its phase rail. */
  readonly colorWorkflowText?: string;
  readonly colorWorkflowMeta?: string;
  readonly colorWorkflowFaint?: string;
  readonly colorWorkflowPhaseCurrent?: string;
  readonly colorWorkflowPhaseCurrentBackground?: string;
  /** Base font size of the workflow card (default 11). */
  readonly workflowCardFontSizePx?: number;
  readonly composerBorderWidthPx?: number;
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
  const router = useMemo(() => getRouter(history), [history]);
  const portalContainerRef = useRef<HTMLDivElement>(null);
  const style = {
    position: "relative",
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    ...embeddedTypographyStyle(embeddedBaseFontSizePx),
    ...createHostThemeStyle(hostTheme),
  } as CSSProperties;

  return (
    <SynaraHostPortalProvider value={portalContainerRef}>
      <div data-synara-app-root data-synara-host-themed={hostTheme ? "" : undefined} style={style}>
        <SynaraHostSidebarProvider value={hostSidebar ?? null}>
          <AppHistoryProvider history={history}>
            <RouterProvider router={router} />
          </AppHistoryProvider>
        </SynaraHostSidebarProvider>
        <div ref={portalContainerRef} data-synara-portal-container />
      </div>
    </SynaraHostPortalProvider>
  );
}
