import { describe, expect, it } from "vitest";

import { resolveChatRouteShellClassNames } from "./chatRouteLayout";

describe("resolveChatRouteShellClassNames", () => {
  it("fills the host container in embedded mode", () => {
    const classes = resolveChatRouteShellClassNames(true);

    expect(classes.sidebarProvider).toContain("h-full");
    expect(classes.sidebarProvider).toContain("min-h-0");
    expect(classes.sidebarProvider).not.toContain("min-h-svh");
    expect(classes.mainContent).toContain("h-full");
    expect(classes.mainContent).not.toContain("h-svh");
    expect(classes.contentViewportHeight).toBe("h-full");
    expect(classes.routeInset).toContain("h-full");
    expect(classes.routeInset).not.toContain("h-dvh");
  });

  it("keeps viewport sizing in standalone mode", () => {
    const classes = resolveChatRouteShellClassNames(false);

    expect(classes.sidebarProvider).toContain("min-h-svh");
    expect(classes.mainContent).toContain("h-svh");
    expect(classes.contentViewportHeight).toBeUndefined();
    expect(classes.routeInset).toBeUndefined();
  });
});
