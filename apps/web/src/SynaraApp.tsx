// FILE: SynaraApp.tsx
// Purpose: Mounts the complete Synara route tree as a reusable React component.
// Layer: Web application entrypoint
// Exports: SynaraApp and its host-facing props
// Depends on: TanStack Router, app history context, and the shared route factory

import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useMemo, type CSSProperties } from "react";

import { AppHistoryProvider, appHistory } from "./appNavigation";
import {
  SynaraHostSidebarProvider,
  type SynaraHostSidebar,
} from "./hostSidebar";
import { createEmbeddedDisplayScaleStyle } from "./lib/embeddedDisplayScale";
import { createEmbeddedTypographyStyle } from "./lib/embeddedTypography";
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
  /** Optional React-only chrome supplied by an embedding host. */
  readonly hostSidebar?: SynaraHostSidebar;
  /** Optional embedded-only typography base that does not scale layout geometry. */
  readonly embeddedBaseFontSizePx?: number;
}

export function SynaraApp({
  history = appHistory,
  httpBaseUrl,
  resolveWebSocketUrl,
  hostProject,
  hostNavigation,
  hostSidebar,
  displayScale,
  embeddedBaseFontSizePx,
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
    <SynaraHostSidebarProvider value={hostSidebar ?? null}>
      <AppHistoryProvider history={history}>
        <RouterProvider router={router} />
      </AppHistoryProvider>
    </SynaraHostSidebarProvider>
  );
  const displayScaleStyle = createEmbeddedDisplayScaleStyle(displayScale);
  const embeddedTypographyStyle = createEmbeddedTypographyStyle(embeddedBaseFontSizePx);

  if (!displayScaleStyle && !embeddedTypographyStyle) return app;

  const embeddedAppStyle: CSSProperties = {
    ...displayScaleStyle,
    ...embeddedTypographyStyle,
  };

  return (
    <div
      className="relative h-full min-h-0 w-full min-w-0"
      data-synara-display-scale={displayScaleStyle?.zoom}
      data-synara-embedded-base-font-size={
        embeddedTypographyStyle ? embeddedBaseFontSizePx : undefined
      }
      style={embeddedAppStyle}
    >
      {app}
    </div>
  );
}
