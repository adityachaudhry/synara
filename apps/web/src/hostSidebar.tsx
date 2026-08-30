import { createContext, useContext, type ReactNode } from "react";

export interface SynaraHostSidebar {
  readonly widthPx: number;
  readonly lockedOpen?: boolean;
  readonly showProjectTitle?: boolean;
  readonly projectThreadsOnly?: boolean;
  readonly brandIconUrl?: string;
  readonly simplifiedComposer?: boolean;
  readonly chatFontSizePx?: number;
  readonly filesPane?: ReactNode;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
}

const HostSidebarContext = createContext<SynaraHostSidebar | null>(null);

export function SynaraHostSidebarProvider({
  value,
  children,
}: {
  readonly value: SynaraHostSidebar | null;
  readonly children: ReactNode;
}) {
  return <HostSidebarContext.Provider value={value}>{children}</HostSidebarContext.Provider>;
}

export function useSynaraHostSidebar(): SynaraHostSidebar | null {
  return useContext(HostSidebarContext);
}

export function resolveHostSidebarPresentation(
  sidebar: Pick<SynaraHostSidebar, "widthPx" | "lockedOpen" | "showProjectTitle"> | null,
) {
  const lockedOpen = sidebar?.lockedOpen === true;
  return {
    width:
      sidebar && Number.isFinite(sidebar.widthPx) && sidebar.widthPx > 0
        ? `${sidebar.widthPx}px`
        : undefined,
    collapsible: lockedOpen ? ("none" as const) : ("offcanvas" as const),
    resizable: !lockedOpen,
    showSeamRail: !lockedOpen,
    showProjectTitle: sidebar?.showProjectTitle !== false,
  };
}
