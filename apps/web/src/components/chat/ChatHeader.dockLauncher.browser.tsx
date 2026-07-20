// FILE: ChatHeader.dockLauncher.browser.tsx
// Purpose: Browser regression for the Glasswing right-dock launcher control.
// Layer: Chat header UI test

import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarProvider } from "../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

describe("ChatHeader right-dock launcher", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a generic panels toggle instead of the diff toggle when requested", async () => {
    const onToggle = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await render(
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <ChatHeader
            activeThreadId={ThreadId.makeUnsafe("thread-dock-launcher")}
            activeThreadTitle="Dock launcher"
            activeThreadEntryPoint="chat"
            activeProvider="claudeAgent"
            activeProjectName={undefined}
            threadBreadcrumbs={[]}
            isGitRepo
            openInTarget={null}
            activeProjectScripts={undefined}
            preferredScriptId={null}
            keybindings={[]}
            availableEditors={[]}
            diffToggleShortcutLabel={null}
            handoffBadgeLabel={null}
            handoffActionLabel="Hand off"
            handoffDisabled
            handoffActionTargetProviders={[]}
            handoffBadgeSourceProvider={null}
            handoffBadgeTargetProvider={null}
            gitCwd={null}
            diffTotals={{ additions: 0, deletions: 0, hasChanges: false }}
            diffOpen={false}
            onRunProjectScript={vi.fn()}
            onAddProjectScript={vi.fn()}
            onUpdateProjectScript={vi.fn()}
            onDeleteProjectScript={vi.fn()}
            onToggleDiff={vi.fn()}
            onCreateHandoff={vi.fn()}
            onNavigateToThread={vi.fn()}
            onRenameThread={vi.fn()}
            {...({ dockLauncherAction: { open: false, onToggle } } as Record<string, unknown>)}
          />
        </SidebarProvider>
      </QueryClientProvider>,
    );

    const toggle = page.getByRole("button", { name: "Open panels" });
    expect(toggle).toBeVisible();
    expect(page.getByRole("button", { name: "Toggle diff panel" }).query()).toBeNull();

    await toggle.click();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
