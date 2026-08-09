// FILE: SynaraApp.tsx
// Purpose: Mounts the complete Synara route tree as a reusable React component.
// Layer: Web application entrypoint
// Exports: SynaraApp and its host-facing props
// Depends on: TanStack Router, app history context, and the shared route factory

import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useMemo } from "react";

import { AppHistoryProvider, appHistory } from "./appNavigation";
import { getRouter } from "./router";
import {
  configureSynaraRuntime,
  type SynaraRuntimeConfig,
} from "./synaraRuntimeConfig";

export interface SynaraAppProps extends SynaraRuntimeConfig {
  /**
   * Embedding hosts should pass a memory history so Synara routing remains inside
   * their React surface. The standalone app defaults to its browser/hash history.
   */
  readonly history?: RouterHistory;
}

export function SynaraApp({
  history = appHistory,
  httpBaseUrl,
  resolveWebSocketUrl,
  hostProject,
  hostNavigation,
}: SynaraAppProps) {
  configureSynaraRuntime({
    ...(httpBaseUrl ? { httpBaseUrl } : {}),
    ...(resolveWebSocketUrl ? { resolveWebSocketUrl } : {}),
    ...(hostProject ? { hostProject } : {}),
    ...(hostNavigation ? { hostNavigation } : {}),
  });
  const router = useMemo(() => getRouter(history), [history]);

  return (
    <AppHistoryProvider history={history}>
      <RouterProvider router={router} />
    </AppHistoryProvider>
  );
}
