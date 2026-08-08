// FILE: synaraRuntimeConfig.ts
// Purpose: Holds the small host adapter surface for embedded Synara runtimes.
// Layer: Web runtime adapter
// Exports: configuration and HTTP URL resolution used by the shared React app

export type SynaraWebSocketUrlResolver = () => string | Promise<string>;

export interface SynaraRuntimeConfig {
  /** Prefix used to proxy Synara's HTTP routes through the embedding host. */
  readonly httpBaseUrl?: string;
  /** Called for every WebSocket connection so one-time tickets are never reused. */
  readonly resolveWebSocketUrl?: SynaraWebSocketUrlResolver;
}

let runtimeConfig: SynaraRuntimeConfig = {};

export function configureSynaraRuntime(config: SynaraRuntimeConfig): void {
  runtimeConfig = {
    ...(config.httpBaseUrl ? { httpBaseUrl: config.httpBaseUrl.replace(/\/$/, "") } : {}),
    ...(config.resolveWebSocketUrl
      ? { resolveWebSocketUrl: config.resolveWebSocketUrl }
      : {}),
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
