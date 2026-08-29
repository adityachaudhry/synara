import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { SynaraHostPortalProvider } from "~/hostPortal";

function PortalFixture() {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <SynaraHostPortalProvider value={containerRef}>
      <div data-synara-app-root>
        <Dialog defaultOpen>
          <DialogPopup showCloseButton={false}>Contained dialog</DialogPopup>
        </Dialog>
        <div ref={containerRef} data-synara-portal-container />
      </div>
    </SynaraHostPortalProvider>
  );
}

describe("embedded portal containment", () => {
  it("mounts shared overlays inside the Synara root", async () => {
    const screen = await render(<PortalFixture />);
    const popup = screen.getByText("Contained dialog").element();

    expect(popup.closest("[data-synara-portal-container]")).not.toBeNull();
    expect(popup.closest("[data-synara-app-root]")).not.toBeNull();
  });
});
