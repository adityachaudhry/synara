import type { ModelSelection, ProviderKind } from "@synara/contracts";

import type { TabConfig } from "./pi-link/messages";

export type SynaraWebSocketUrlResolver = () => string | Promise<string>;

export interface SynaraProject {
  readonly projectId: string;
  readonly name: string;
  readonly defaultModelSelection?: ModelSelection;
  readonly customModelsByProvider?: Partial<Record<ProviderKind, readonly string[]>>;
}

/** Pi Link: the workspace talks to Glasswing's agent service through a shared worker. */
export type SynaraPiLinkConfig = TabConfig & {
  /** The company's thread list (agent service shape) the host fetched with the page, for first paint. */
  readonly initialCompanyThreads?: unknown;
};

export interface SynaraRuntimeConfig {
  readonly httpBaseUrl?: string;
  readonly resolveWebSocketUrl?: SynaraWebSocketUrlResolver;
  readonly project?: SynaraProject;
  readonly piLink?: SynaraPiLinkConfig;
}

let runtimeConfig: SynaraRuntimeConfig = {};

export function configureSynaraRuntime(config: SynaraRuntimeConfig): void {
  runtimeConfig = {
    ...(config.httpBaseUrl ? { httpBaseUrl: config.httpBaseUrl.replace(/\/$/, "") } : {}),
    ...(config.resolveWebSocketUrl
      ? { resolveWebSocketUrl: config.resolveWebSocketUrl }
      : {}),
    ...(config.project ? { project: config.project } : {}),
    ...(config.piLink ? { piLink: config.piLink } : {}),
  };
}

export function readSynaraRuntimeConfig(): SynaraRuntimeConfig {
  return runtimeConfig;
}

export function resolveSynaraHttpUrl(rawPath: string, pageOrigin: string): string {
  if (/^https?:\/\//i.test(rawPath)) return rawPath;
  const sourceUrl = new URL(rawPath, pageOrigin);
  if (!runtimeConfig.httpBaseUrl) return sourceUrl.toString();

  const baseUrl = new URL(runtimeConfig.httpBaseUrl, pageOrigin);
  const basePath = baseUrl.pathname.replace(/\/$/, "");
  baseUrl.pathname = `${basePath}${sourceUrl.pathname}`;
  baseUrl.search = sourceUrl.search;
  baseUrl.hash = sourceUrl.hash;
  return baseUrl.toString();
}

export function resetSynaraRuntimeConfigForTest(): void {
  runtimeConfig = {};
}
