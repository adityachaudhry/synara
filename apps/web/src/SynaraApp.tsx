import { OrchestrationShellSnapshot } from "@synara/contracts";
import { RouterProvider } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { AppHistoryProvider, appHistory } from "./appNavigation";
import type { SynaraHistory } from "./embeddedHistory";
import { SynaraHostPortalProvider } from "./hostPortal";
import { HostRouteRenderedContext } from "./hostReadiness";
import { SynaraHostSidebarProvider, type SynaraHostSidebar } from "./hostSidebar";
import { getAppTypographyScale } from "./lib/appTypography";
import { createHostThemeStyle } from "./lib/hostThemeStyle";
import { getRouter } from "./router";
import { useStore } from "./store";
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
  readonly colorWorkflowTitle?: string;
  readonly colorWorkflowLink?: string;
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
  /**
   * The shell (projects and thread rows) as the host fetched it while it rendered the
   * page (GET /api/orchestration/shell-snapshot with the same session), as JSON. The
   * app shows those threads before its socket connects; it may arrive after mount.
   */
  readonly initialShellSnapshot?: unknown;
}

const decodeShellSnapshot = Schema.decodeUnknownOption(OrchestrationShellSnapshot);

/**
 * Applies the host's copy of the shell as soon as it is here, so the first paint has
 * the threads. The store keeps whichever snapshot is newer, so the socket's own
 * subscription takes over and an older copy arriving late changes nothing.
 */
function HostShellSnapshot({ snapshot }: { snapshot: unknown }) {
  useLayoutEffect(() => {
    if (snapshot === undefined || snapshot === null) return;
    const decoded = decodeShellSnapshot(snapshot);
    if (Option.isSome(decoded)) useStore.getState().syncServerShellSnapshot(decoded.value);
  }, [snapshot]);
  return null;
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

/**
 * Tells the host page when the workspace is on screen: it has its threads and the
 * router has rendered the view that shows them. Until then the app shows a bare splash
 * (or nothing on a thread link), which the host cannot tell from a hang. The root
 * carries `data-synara-readiness` always and `data-synara-hydrated` once ready.
 */
function HostReadinessSignal({
  rootRef,
  routeRendered,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  routeRendered: boolean;
}) {
  const hydrated = useStore((store) => store.threadsHydrated) && routeRendered;
  useEffect(() => {
    rootRef.current?.toggleAttribute("data-synara-hydrated", hydrated);
  }, [hydrated, rootRef]);
  return null;
}

export function SynaraApp({
  history = appHistory,
  httpBaseUrl,
  resolveWebSocketUrl,
  project,
  hostSidebar,
  hostTheme,
  embeddedBaseFontSizePx,
  initialShellSnapshot,
}: SynaraAppProps) {
  configureSynaraRuntime({
    ...(httpBaseUrl ? { httpBaseUrl } : {}),
    ...(resolveWebSocketUrl ? { resolveWebSocketUrl } : {}),
    ...(project ? { project } : {}),
  });
  const router = useMemo(() => getRouter(history), [history]);
  const [routeRendered, setRouteRendered] = useState(false);
  const reportRouteRendered = useCallback(() => setRouteRendered(true), []);
  const portalContainerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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
      <div
        ref={rootRef}
        data-synara-app-root
        data-synara-readiness=""
        data-synara-host-themed={hostTheme ? "" : undefined}
        style={style}
      >
        <HostShellSnapshot snapshot={initialShellSnapshot} />
        <HostReadinessSignal rootRef={rootRef} routeRendered={routeRendered} />
        <SynaraHostSidebarProvider value={hostSidebar ?? null}>
          <AppHistoryProvider history={history}>
            <HostRouteRenderedContext.Provider value={reportRouteRendered}>
              <RouterProvider router={router} />
            </HostRouteRenderedContext.Provider>
          </AppHistoryProvider>
        </SynaraHostSidebarProvider>
        <div ref={portalContainerRef} data-synara-portal-container />
      </div>
    </SynaraHostPortalProvider>
  );
}
