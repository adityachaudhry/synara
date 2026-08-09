const SIDEBAR_BACKGROUND_CLASS = "bg-[var(--app-shell-background)]";
const MAIN_CONTENT_BASE_CLASS = "relative flex min-h-0 min-w-0 flex-1";

/**
 * Standalone Synara owns the viewport; the embeddable React app owns only the
 * height offered by its host. Keeping this decision at the route shell prevents
 * viewport units inside an embed from clipping its lower navigation.
 */
export function resolveChatRouteShellClassNames(embedded: boolean): {
  readonly sidebarProvider: string;
  readonly mainContent: string;
  readonly contentViewportHeight: "h-full" | undefined;
  readonly routeInset: string | undefined;
} {
  return embedded
    ? {
        sidebarProvider: `h-full min-h-0 ${SIDEBAR_BACKGROUND_CLASS}`,
        mainContent: `${MAIN_CONTENT_BASE_CLASS} h-full`,
        contentViewportHeight: "h-full",
        routeInset: "h-full min-h-0 overflow-hidden overscroll-y-none text-foreground",
      }
    : {
        sidebarProvider: `min-h-svh ${SIDEBAR_BACKGROUND_CLASS}`,
        mainContent: `${MAIN_CONTENT_BASE_CLASS} h-svh`,
        contentViewportHeight: undefined,
        routeInset: undefined,
      };
}
