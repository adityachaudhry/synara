import {
  resolveRailwaySandboxRuntimeConfig,
  type RailwaySandboxRuntimeConfig,
} from "../workspaceRuntime/railwaySandboxConfig";
import type { DockerWorkspaceConfig } from "../workspaceRuntime/Layers/DockerWorkspaceRuntime";
import { isTrustedPrivateWorkerUrl, privateWorkerHosts } from "./privateNetwork.ts";

const DEFAULT_FORWARD_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "PERPLEXITY_API_KEY",
  "GLASSWING_CRUNCHBASE_MCP_URL",
  "GLASSWING_CRUNCHBASE_MCP_TOKEN",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
] as const;

export type DistributedPiRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly railway: RailwaySandboxRuntimeConfig;
      readonly docker?: DockerWorkspaceConfig;
      readonly controlUrl: string;
      readonly templateCheckpointName?: string;
      readonly repositoryOriginOverride?: { readonly sourceOrigin: string; readonly origin: string };
      readonly networkIsolation: "ISOLATED" | "PRIVATE";
      readonly workerEnvironment: Readonly<Record<string, string>>;
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
          ...(environment.SYNARA_DOCKER_LOG_DIR
            ? { diagnosticsDirectory: environment.SYNARA_DOCKER_LOG_DIR }
            : {}),
        }
      : undefined;
  const railway: RailwaySandboxRuntimeConfig = docker
    ? { enabled: false }
    : resolveRailwaySandboxRuntimeConfig({
        token: environment.SYNARA_RAILWAY_SANDBOX_TOKEN,
        environmentId: environment.SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID,
        authType: environment.SYNARA_RAILWAY_SANDBOX_AUTH_TYPE,
        region: environment.SYNARA_RAILWAY_SANDBOX_REGION,
        idleTimeoutMinutes: environment.SYNARA_RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES,
        maxActiveSandboxes: environment.SYNARA_RAILWAY_MAX_ACTIVE_SANDBOXES,
      });
  if (!railway.enabled && !docker) return { enabled: false };

  const rawControlUrl = environment.SYNARA_PROVIDER_WORKER_CONTROL_URL?.trim();
  if (!rawControlUrl) {
    throw new Error(
      "SYNARA_PROVIDER_WORKER_CONTROL_URL is required when distributed runtime is enabled.",
    );
  }
  const controlUrl = new URL(rawControlUrl);
  if (controlUrl.protocol === "http:") controlUrl.protocol = "ws:";
  if (controlUrl.protocol === "https:") controlUrl.protocol = "wss:";
  if (controlUrl.protocol !== "ws:" && controlUrl.protocol !== "wss:") {
    throw new Error("SYNARA_PROVIDER_WORKER_CONTROL_URL must use http, https, ws, or wss.");
  }
  if (controlUrl.username || controlUrl.password || controlUrl.search || controlUrl.hash) {
    throw new Error(
      "SYNARA_PROVIDER_WORKER_CONTROL_URL must not contain credentials, query, or fragment.",
    );
  }

  const configuredKeys = environment.SYNARA_PROVIDER_WORKER_FORWARD_ENV_KEYS?.split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const keys = configuredKeys?.length ? configuredKeys : DEFAULT_FORWARD_ENV_KEYS;
  const workerEnvironment: Record<string, string> = {};
  for (const key of keys) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || key.startsWith("SYNARA_")) {
      throw new Error(
        "SYNARA_PROVIDER_WORKER_FORWARD_ENV_KEYS accepts uppercase non-SYNARA environment keys only.",
      );
    }
    const value = environment[key]?.trim();
    if (value) workerEnvironment[key] = value;
  }
  for (const key of ["SYNARA_RELEASE", "SYNARA_COMMIT"] as const) {
    const value = environment[key]?.trim();
    if (value) workerEnvironment[key] = value;
  }

  const networkIsolationInput =
    environment.SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION?.trim().toUpperCase() ||
    (docker ? "PRIVATE" : "ISOLATED");
  if (networkIsolationInput !== "ISOLATED" && networkIsolationInput !== "PRIVATE") {
    throw new Error("SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION must be ISOLATED or PRIVATE.");
  }
  if (docker && networkIsolationInput !== "PRIVATE") {
    throw new Error(
      "Local Docker requires PRIVATE networking for its host callback; it does not implement Railway ISOLATED networking.",
    );
  }

  const trustedEnvironment = { ...environment, SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION: networkIsolationInput };
  const privateHosts = privateWorkerHosts(environment);
  if (privateHosts.length && networkIsolationInput !== "PRIVATE") {
    throw new Error("Private worker hosts require SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION=PRIVATE.");
  }
  const isLocalControl = ["localhost", "127.0.0.1", "[::1]"].includes(controlUrl.hostname) ||
    (docker !== undefined && controlUrl.hostname === "host.docker.internal");
  if (controlUrl.protocol === "ws:" && !isLocalControl && !isTrustedPrivateWorkerUrl(controlUrl, trustedEnvironment)) {
    throw new Error("Worker control URLs require WSS or an explicitly trusted private host.");
  }
  if (privateHosts.length) {
    workerEnvironment.SYNARA_PROVIDER_WORKER_PRIVATE_HOSTS = privateHosts.join(",");
    workerEnvironment.SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION = networkIsolationInput;
  }
  let repositoryOriginOverride: { readonly sourceOrigin: string; readonly origin: string } | undefined;
  const privateRepositoryOrigin = environment.SYNARA_PROVIDER_WORKER_REPOSITORY_ORIGIN?.trim();
  if (privateRepositoryOrigin) {
    const origin = new URL(privateRepositoryOrigin);
    const source = new URL(environment.SYNARA_GITEA_ORIGIN ?? "");
    if (!["http:", "https:"].includes(origin.protocol) || !isTrustedPrivateWorkerUrl(origin, trustedEnvironment) ||
      origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
      source.protocol !== "https:" || source.username || source.password || source.search || source.hash || source.pathname !== "/") {
      throw new Error("The worker repository origin must map the configured public Gitea origin to an explicitly trusted private origin.");
    }
    repositoryOriginOverride = { sourceOrigin: source.origin, origin: origin.origin };
  }

  return {
    enabled: true,
    railway,
    ...(docker ? { docker } : {}),
    controlUrl: controlUrl.toString(),
    ...(environment.SYNARA_PROVIDER_WORKER_TEMPLATE_CHECKPOINT?.trim()
      ? { templateCheckpointName: environment.SYNARA_PROVIDER_WORKER_TEMPLATE_CHECKPOINT.trim() }
      : {}),
    networkIsolation: networkIsolationInput,
    ...(repositoryOriginOverride ? { repositoryOriginOverride } : {}),
    workerEnvironment,
    ...(environment.SYNARA_PROVIDER_WORKER_REPOSITORY_AUTHORIZATION?.trim()
      ? {
          repositoryAuthorization:
            environment.SYNARA_PROVIDER_WORKER_REPOSITORY_AUTHORIZATION.trim(),
        }
      : {}),
  };
}
