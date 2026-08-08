// FILE: AppHistoryProvider.browser.tsx
// Purpose: Verifies that an embedding host can supply Synara's route history.
// Layer: Web browser tests
// Depends on: React context, TanStack memory history, and appNavigation

import { createMemoryHistory } from "@tanstack/react-router";
import { createElement, type PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import { AppHistoryProvider, useAppHistory } from "~/appNavigation";

describe("AppHistoryProvider", () => {
  it("supplies host-owned memory history without changing the browser URL", async () => {
    const history = createMemoryHistory({ initialEntries: ["/settings"] });
    const browserUrl = window.location.href;
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(AppHistoryProvider, { history }, children);

    const hook = await renderHook(() => useAppHistory(), { wrapper });

    expect(hook.result.current).toBe(history);
    expect(hook.result.current.location.pathname).toBe("/settings");
    expect(window.location.href).toBe(browserUrl);

    await hook.unmount();
  });
});
