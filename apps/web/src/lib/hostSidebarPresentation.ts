// FILE: hostSidebarPresentation.ts
// Purpose: Resolves the embedded host rail into concrete Synara shell behavior.
// Layer: Web presentation policy

import type { SynaraHostSidebar } from "../hostSidebar";

export interface HostSidebarPresentation {
  readonly width: string | null;
  readonly collapsible: "offcanvas" | "none";
  readonly resizable: boolean;
  readonly showSeamRail: boolean;
}

export function resolveHostSidebarPresentation(
  hostSidebar: Pick<SynaraHostSidebar, "widthPx" | "lockedOpen"> | null,
  displayScale: number | undefined,
): HostSidebarPresentation {
  if (!hostSidebar) {
    return {
      width: null,
      collapsible: "offcanvas",
      resizable: true,
      showSeamRail: true,
    };
  }

  const scale =
    typeof displayScale === "number" && Number.isFinite(displayScale) && displayScale > 0
      ? displayScale
      : 1;
  const width =
    Number.isFinite(hostSidebar.widthPx) && hostSidebar.widthPx > 0
      ? `${hostSidebar.widthPx / scale}px`
      : null;
  const lockedOpen = hostSidebar.lockedOpen === true;

  return {
    width,
    collapsible: lockedOpen ? "none" : "offcanvas",
    resizable: !lockedOpen,
    showSeamRail: !lockedOpen,
  };
}
