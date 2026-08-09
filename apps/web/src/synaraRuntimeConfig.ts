// FILE: synaraRuntimeConfig.ts
// Purpose: Holds the small host adapter surface for embedded Synara runtimes.
// Layer: Web runtime adapter
// Exports: configuration and HTTP URL resolution used by the shared React app

import { normalizeEmbeddedDisplayScale } from "./lib/embeddedDisplayScale";

export type SynaraWebSocketUrlResolver = () => string | Promise<string>;

export interface SynaraHostProjectSelection {
  readonly name: string;
  readonly cwd: string;
}

export interface SynaraHostProject {
  readonly name: string;
  readonly slug: string;
  readonly onSelectProject?: (project: SynaraHostProjectSelection) => void;
}

export interface SynaraHostProfile {
  readonly email: string;
  readonly onSignOut: () => void | Promise<void>;
}

export interface SynaraHostNavigation {
  readonly onSelectWorkspace: () => void;
  readonly profile: SynaraHostProfile;
}

export interface SynaraRuntimeConfig {
  /** Prefix used to proxy Synara's HTTP routes through the embedding host. */
  readonly httpBaseUrl?: string;
  /** Called for every WebSocket connection so one-time tickets are never reused. */
  readonly resolveWebSocketUrl?: SynaraWebSocketUrlResolver;
  /** Optional project context supplied by a native embedding host such as Glasswing. */
  readonly hostProject?: SynaraHostProject;
  /** Optional host-owned destinations rendered by the embedded Synara shell. */
  readonly hostNavigation?: SynaraHostNavigation;
  /** Optional host-selected visual scale for the complete embedded app surface. */
  readonly displayScale?: number;
}

let runtimeConfig: SynaraRuntimeConfig = {};

export function configureSynaraRuntime(config: SynaraRuntimeConfig): void {
  runtimeConfig = {
    ...(config.httpBaseUrl ? { httpBaseUrl: config.httpBaseUrl.replace(/\/$/, "") } : {}),
    ...(config.resolveWebSocketUrl
      ? { resolveWebSocketUrl: config.resolveWebSocketUrl }
      : {}),
    ...(config.hostProject ? { hostProject: config.hostProject } : {}),
    ...(config.hostNavigation ? { hostNavigation: config.hostNavigation } : {}),
    ...(config.displayScale === undefined
      ? {}
      : { displayScale: normalizeEmbeddedDisplayScale(config.displayScale) }),
  };
}

export function readSynaraRuntimeConfig(): SynaraRuntimeConfig {
  return runtimeConfig;
}

export function resolveSynaraHttpUrl(rawPath: string, pageOrigin: string): string {
  if (/^https?:\/\//i.test(rawPath)) return rawPath;
  const sourceUrl = new URL(rawPath, pageOrigin);
  const baseUrl = runtimeConfig.httpBaseUrl
    ? new URL(runtimeConfig.httpBaseUrl, pageOrigin)
    : new URL(pageOrigin);
  if (!runtimeConfig.httpBaseUrl) return sourceUrl.toString();

  const basePath = baseUrl.pathname.replace(/\/$/, "");
  const sourcePath = sourceUrl.pathname.startsWith("/")
    ? sourceUrl.pathname
    : `/${sourceUrl.pathname}`;
  baseUrl.pathname = `${basePath}${sourcePath}`;
  baseUrl.search = sourceUrl.search;
  baseUrl.hash = sourceUrl.hash;
  return baseUrl.toString();
}

export function resetSynaraRuntimeConfigForTest(): void {
  runtimeConfig = {};
}
