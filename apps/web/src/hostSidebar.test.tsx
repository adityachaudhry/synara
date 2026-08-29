import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  resolveHostSidebarPresentation,
  SynaraHostSidebarProvider,
  useSynaraHostSidebar,
} from "./hostSidebar";

function HostSidebarProbe() {
  const sidebar = useSynaraHostSidebar();
  return (
    <div
      data-footer={sidebar?.footer ? "yes" : "no"}
      data-header={sidebar?.header ? "yes" : "no"}
      data-locked={sidebar?.lockedOpen}
      data-project-title={sidebar?.showProjectTitle}
      data-width={sidebar?.widthPx}
    />
  );
}

describe("host sidebar composition", () => {
  it("carries every host-owned sidebar option through context", () => {
    const markup = renderToStaticMarkup(
      <SynaraHostSidebarProvider
        value={{
          widthPx: 312,
          lockedOpen: true,
          showProjectTitle: false,
          header: <span>Host header</span>,
          footer: <span>Host footer</span>,
        }}
      >
        <HostSidebarProbe />
      </SynaraHostSidebarProvider>,
    );

    expect(markup).toContain('data-width="312"');
    expect(markup).toContain('data-locked="true"');
    expect(markup).toContain('data-project-title="false"');
    expect(markup).toContain('data-header="yes"');
    expect(markup).toContain('data-footer="yes"');
  });

  it("locks and sizes the existing sidebar while preserving standalone defaults", () => {
    expect(resolveHostSidebarPresentation(null)).toEqual({
      width: undefined,
      collapsible: "offcanvas",
      resizable: true,
      showSeamRail: true,
      showProjectTitle: true,
    });
    expect(
      resolveHostSidebarPresentation({
        widthPx: 312,
        lockedOpen: true,
        showProjectTitle: false,
      }),
    ).toEqual({
      width: "312px",
      collapsible: "none",
      resizable: false,
      showSeamRail: false,
      showProjectTitle: false,
    });
  });
});
