export interface RailwaySandboxRuntimeConfigInput {
  readonly token?: string;
  readonly environmentId?: string;
  readonly authType?: string;
  readonly region?: string;
  readonly idleTimeoutMinutes?: string;
  readonly networkIsolation?: string;
}

export type RailwaySandboxRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly token: string;
      readonly environmentId: string;
      readonly authType: "bearer" | "project-token";
      readonly region?: string;
      readonly idleTimeoutMinutes: number;
      readonly networkIsolation: "PRIVATE" | "ISOLATED";
    };

export type RailwaySandboxRuntimeConfigDescription =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly environmentId: string;
      readonly authType: "bearer" | "project-token";
      readonly region?: string;
      readonly idleTimeoutMinutes: number;
      readonly networkIsolation: "PRIVATE" | "ISOLATED";
    };

const TOKEN_ENV_KEY = "SYNARA_RAILWAY_SANDBOX_TOKEN";
const ENVIRONMENT_ID_ENV_KEY = "SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID";

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveRailwaySandboxRuntimeConfig(
  input: RailwaySandboxRuntimeConfigInput,
): RailwaySandboxRuntimeConfig {
  const token = trimmed(input.token);
  const environmentId = trimmed(input.environmentId);
  const authTypeInput = trimmed(input.authType);
  const region = trimmed(input.region);
  const idleTimeoutInput = trimmed(input.idleTimeoutMinutes);
  const networkIsolationInput = trimmed(input.networkIsolation);
  const hasAnyConfiguration =
    token !== undefined ||
    environmentId !== undefined ||
    authTypeInput !== undefined ||
    region !== undefined ||
    idleTimeoutInput !== undefined ||
    networkIsolationInput !== undefined;

  if (!hasAnyConfiguration) {
    return { enabled: false };
  }

  const missing = [
    ...(token === undefined ? [TOKEN_ENV_KEY] : []),
    ...(environmentId === undefined ? [ENVIRONMENT_ID_ENV_KEY] : []),
  ];
  if (missing.length > 0) {
    throw new Error(`Incomplete Railway Sandbox configuration; missing ${missing.join(", ")}.`);
  }

  const authType = authTypeInput ?? "bearer";
  if (authType !== "bearer" && authType !== "project-token") {
    throw new Error(
      "SYNARA_RAILWAY_SANDBOX_AUTH_TYPE must be bearer or project-token.",
    );
  }

  const idleTimeoutMinutes = idleTimeoutInput === undefined ? 30 : Number(idleTimeoutInput);
  if (
    !Number.isInteger(idleTimeoutMinutes) ||
    idleTimeoutMinutes < 1 ||
    idleTimeoutMinutes > 120
  ) {
    throw new Error(
      "SYNARA_RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES must be an integer from 1 through 120.",
    );
  }

  const networkIsolation = networkIsolationInput ?? "PRIVATE";
  if (networkIsolation !== "PRIVATE" && networkIsolation !== "ISOLATED") {
    throw new Error(
      "SYNARA_RAILWAY_SANDBOX_NETWORK_ISOLATION must be PRIVATE or ISOLATED.",
    );
  }

  return {
    enabled: true,
    token,
    environmentId,
    authType,
    ...(region === undefined ? {} : { region }),
    idleTimeoutMinutes,
    networkIsolation,
  };
}

export function describeRailwaySandboxRuntimeConfig(
  config: RailwaySandboxRuntimeConfig,
): RailwaySandboxRuntimeConfigDescription {
  if (!config.enabled) {
    return config;
  }

  return {
    enabled: true,
    environmentId: config.environmentId,
    authType: config.authType,
    ...(config.region === undefined ? {} : { region: config.region }),
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    networkIsolation: config.networkIsolation,
  };
}
