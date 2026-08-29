export type SynaraWebSocketUrlResolver = () => string | Promise<string>;

export interface SynaraProject {
  readonly projectId: string;
  readonly name: string;
}

export interface SynaraRuntimeConfig {
  readonly httpBaseUrl?: string;
  readonly resolveWebSocketUrl?: SynaraWebSocketUrlResolver;
  readonly project?: SynaraProject;
}

let runtimeConfig: SynaraRuntimeConfig = {};

export function configureSynaraRuntime(config: SynaraRuntimeConfig): void {
  runtimeConfig = {
    ...(config.httpBaseUrl ? { httpBaseUrl: config.httpBaseUrl.replace(/\/$/, "") } : {}),
    ...(config.resolveWebSocketUrl
      ? { resolveWebSocketUrl: config.resolveWebSocketUrl }
      : {}),
    ...(config.project ? { project: config.project } : {}),
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
