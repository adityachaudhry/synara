import {
  resolveRailwaySandboxRuntimeConfig,
  type RailwaySandboxRuntimeConfig,
} from "../workspaceRuntime/railwaySandboxConfig";

const DEFAULT_FORWARD_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
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
      readonly railway: Extract<RailwaySandboxRuntimeConfig, { readonly enabled: true }>;
      readonly controlUrl: string;
      readonly workerEnvironment: Readonly<Record<string, string>>;
    };

export function resolveDistributedPiRuntimeConfig(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
}): DistributedPiRuntimeConfig {
  const environment = input.environment;
  const railway = resolveRailwaySandboxRuntimeConfig({
    token: environment.SYNARA_RAILWAY_SANDBOX_TOKEN,
    environmentId: environment.SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID,
    authType: environment.SYNARA_RAILWAY_SANDBOX_AUTH_TYPE,
    region: environment.SYNARA_RAILWAY_SANDBOX_REGION,
    idleTimeoutMinutes: environment.SYNARA_RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES,
    networkIsolation: environment.SYNARA_RAILWAY_SANDBOX_NETWORK_ISOLATION,
  });
  if (!railway.enabled) return { enabled: false };

  const rawControlUrl = environment.SYNARA_PROVIDER_WORKER_CONTROL_URL?.trim();
  if (!rawControlUrl) {
    throw new Error(
      "SYNARA_PROVIDER_WORKER_CONTROL_URL is required when Railway Sandbox runtime is enabled.",
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

  return {
    enabled: true,
    railway,
    controlUrl: controlUrl.toString(),
    workerEnvironment,
  };
}
