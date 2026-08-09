// FILE: SynaraApp.tsx
// Purpose: Mounts the complete Synara route tree as a reusable React component.
// Layer: Web application entrypoint
// Exports: SynaraApp and its host-facing props
// Depends on: TanStack Router, app history context, and the shared route factory

import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useMemo } from "react";

import { AppHistoryProvider, appHistory } from "./appNavigation";
import { createEmbeddedDisplayScaleStyle } from "./lib/embeddedDisplayScale";
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
  displayScale,
}: SynaraAppProps) {
  configureSynaraRuntime({
    ...(httpBaseUrl ? { httpBaseUrl } : {}),
    ...(resolveWebSocketUrl ? { resolveWebSocketUrl } : {}),
    ...(hostProject ? { hostProject } : {}),
    ...(hostNavigation ? { hostNavigation } : {}),
    ...(displayScale === undefined ? {} : { displayScale }),
  });
  const router = useMemo(() => getRouter(history), [history]);
  const app = (
    <AppHistoryProvider history={history}>
      <RouterProvider router={router} />
    </AppHistoryProvider>
  );
  const displayScaleStyle = createEmbeddedDisplayScaleStyle(displayScale);

  if (!displayScaleStyle) return app;

  return (
    <div
      className="relative min-h-0 min-w-0"
      data-synara-display-scale={displayScaleStyle.zoom}
      style={displayScaleStyle}
    >
      {app}
    </div>
  );
}
