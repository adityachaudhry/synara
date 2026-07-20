// FILE: RightDockLauncher.browser.tsx
// Purpose: Browser regressions for the right-dock pane launcher.
// Layer: Chat right-dock UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RightDock } from "./RightDock";

describe("RightDockLauncher", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the panes supported by its host and opens the selected pane", async () => {
    const onSelectPane = vi.fn();
    await page.viewport(1280, 800);

    await render(
      <RightDock
        state={{ open: true, panes: [], activePaneId: null }}
        minWidth={320}
        defaultWidth="28rem"
        shouldAcceptWidth={() => true}
        addMenuKinds={["browser", "explorer", "terminal"]}
        onClosePane={vi.fn()}
        onCollapse={vi.fn()}
        onOpenChange={vi.fn()}
        onAddPane={onSelectPane}
        renderPane={() => null}
      />,
    );

    expect(page.getByRole("button", { name: "Browser" })).toBeVisible();
    expect(page.getByRole("button", { name: "Explorer" })).toBeVisible();
    expect(page.getByRole("button", { name: "Terminal" })).toBeVisible();
    expect(document.body.textContent).not.toContain("Pull request");

    await page.getByRole("button", { name: "Explorer" }).click();
    expect(onSelectPane).toHaveBeenCalledExactlyOnceWith("explorer");
  });
});
