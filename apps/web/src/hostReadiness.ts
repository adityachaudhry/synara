// FILE: hostReadiness.ts
// Purpose: Lets the embedded app tell its host when the workspace is on screen: the
// store can hold the threads (from the host's own shell snapshot) before the router
// has loaded and rendered the view that shows them.

import { useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useLayoutEffect } from "react";

/** Provided by SynaraApp; called once the router has rendered its matched view. */
export const HostRouteRenderedContext = createContext<(() => void) | null>(null);

/** For the views a host opens on (the project feed, a thread): reports when one has
 *  rendered, which is when the host's workspace is on screen. */
export function useReportHostViewRendered(): void {
  const report = useContext(HostRouteRenderedContext);
  useLayoutEffect(() => {
    report?.();
  }, [report]);
}

/** For the chat layout, covering any other view: reports once the router is idle,
 *  i.e. the matched view's code has loaded and it rendered in the same commit. */
export function useReportHostRouteRendered(): void {
  const report = useContext(HostRouteRenderedContext);
  const idle = useRouterState({ select: (state) => state.status === "idle" });
  useLayoutEffect(() => {
    if (idle) report?.();
  }, [idle, report]);
}
