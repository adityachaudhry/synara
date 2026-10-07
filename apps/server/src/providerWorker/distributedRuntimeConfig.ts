import {
  resolveDaytonaSandboxRuntimeConfig,
  type DaytonaSandboxRuntimeConfig,
} from "../workspaceRuntime/daytonaSandboxConfig.ts";
import type { DockerWorkspaceConfig } from "../workspaceRuntime/Layers/DockerWorkspaceRuntime";
import { isTrustedPrivateWorkerUrl, privateWorkerHosts } from "./privateNetwork.ts";

/**
 * Sandboxes for durable Pi threads: Daytona in deployed environments, Docker locally.
 * Sandboxes receive no credentials or model keys; the agent loop runs in the controller.
 */
export type DistributedPiRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly daytona: DaytonaSandboxRuntimeConfig;
      readonly docker?: DockerWorkspaceConfig;
      readonly templateCheckpointName?: string;
      readonly repositoryOriginOverride?: { readonly sourceOrigin: string; readonly origin: string };
      readonly networkIsolation: "ISOLATED" | "PRIVATE";
      readonly repositoryAuthorization?: string;
    };

export function resolveDistributedPiRuntimeConfig(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
}): DistributedPiRuntimeConfig {
  const environment = input.environment;
  const docker =
    environment.SYNARA_WORKSPACE_RUNTIME === "docker"
      ? {
          image: environment.SYNARA_DOCKER_IMAGE || "synara-local-worker:latest",
          instance: environment.SYNARA_DOCKER_INSTANCE || "local",
          ...(environment.SYNARA_DOCKER_LOG_DIR ? { diagnosticsDirectory: environment.SYNARA_DOCKER_LOG_DIR } : {}),
        }
      : undefined;
  const daytona = resolveDaytonaSandboxRuntimeConfig(environment);
  if (!daytona.enabled && !docker) return { enabled: false };

  const networkIsolation =
    environment.SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION?.trim().toUpperCase() || (docker ? "PRIVATE" : "ISOLATED");
  if (networkIsolation !== "ISOLATED" && networkIsolation !== "PRIVATE") {
    throw new Error("SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION must be ISOLATED or PRIVATE.");
  }
  if (docker && networkIsolation !== "PRIVATE") {
    throw new Error("Local Docker sandboxes require PRIVATE networking.");
  }
  if (daytona.enabled && networkIsolation !== "ISOLATED") {
    throw new Error("Daytona sandboxes require SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION=ISOLATED.");
  }

  const trustedEnvironment = { ...environment, SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION: networkIsolation };
  const privateHosts = daytona.enabled ? [] : privateWorkerHosts(environment);
  if (privateHosts.length && networkIsolation !== "PRIVATE") {
    throw new Error("Private sandbox hosts require SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION=PRIVATE.");
  }
  let repositoryOriginOverride: { readonly sourceOrigin: string; readonly origin: string } | undefined;
  const privateRepositoryOrigin = daytona.enabled ? undefined : environment.SYNARA_PROVIDER_WORKER_REPOSITORY_ORIGIN?.trim();
  if (privateRepositoryOrigin) {
    const origin = new URL(privateRepositoryOrigin);
    const source = new URL(environment.SYNARA_GITEA_ORIGIN ?? "");
    if (!["http:", "https:"].includes(origin.protocol) || !isTrustedPrivateWorkerUrl(origin, trustedEnvironment) ||
      origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
      source.protocol !== "https:" || source.username || source.password || source.search || source.hash || source.pathname !== "/") {
      throw new Error("The sandbox repository origin must map the configured public Gitea origin to an explicitly trusted private origin.");
    }
    repositoryOriginOverride = { sourceOrigin: source.origin, origin: origin.origin };
  }
  const templateCheckpointName = daytona.enabled ? daytona.snapshot : undefined;

  return {
    enabled: true,
    daytona,
    ...(docker ? { docker } : {}),
    ...(templateCheckpointName ? { templateCheckpointName } : {}),
    networkIsolation,
    ...(repositoryOriginOverride ? { repositoryOriginOverride } : {}),
    ...(environment.SYNARA_PROVIDER_WORKER_REPOSITORY_AUTHORIZATION?.trim()
      ? { repositoryAuthorization: environment.SYNARA_PROVIDER_WORKER_REPOSITORY_AUTHORIZATION.trim() }
      : {}),
  };
}
