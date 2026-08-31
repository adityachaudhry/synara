import { readFileSync, unlinkSync } from "node:fs";

import { Schema } from "effect";

const uuid = Schema.is(Schema.String.check(Schema.isUUID(undefined)));

export interface ProviderWorkerConfigInput {
  readonly controlUrl?: string;
  readonly bootstrapCredential?: string;
  readonly sandboxId?: string;
  readonly workerId?: string;
  readonly lifecycleGeneration?: string;
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly agentGatewayUrl?: string;
  readonly agentGatewayBearerToken?: string;
}

export const PROVIDER_WORKER_CONFIG_PATH = "/opt/synara/provider-worker.json";

export function parseProviderWorkerConfigFile(raw: string): ProviderWorkerConfigInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error("Provider worker configuration file is not valid JSON.", { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider worker configuration file must contain an object.");
  }
  const result: Record<string, string | undefined> = {};
  for (const key of [
    "controlUrl",
    "bootstrapCredential",
    "sandboxId",
    "workerId",
    "lifecycleGeneration",
    "cwd",
    "homeDir",
    "agentGatewayUrl",
    "agentGatewayBearerToken",
  ] as const) {
    const field = (value as Record<string, unknown>)[key];
    if (field !== undefined && typeof field !== "string") {
      throw new Error(`Provider worker configuration file field '${key}' must be a string.`);
    }
    result[key] = field;
  }
  return result;
}

export function readAndConsumeProviderWorkerConfigFile(path: string) {
  const raw = readFileSync(path, "utf8");
  try {
    return resolveProviderWorkerConfig(parseProviderWorkerConfigFile(raw));
  } finally {
    unlinkSync(path);
  }
}

function required(input: ProviderWorkerConfigInput, key: keyof ProviderWorkerConfigInput): string {
  const value = input[key]?.trim();
  if (!value) throw new Error(`Provider worker configuration requires ${key}.`);
  return value;
}

export function resolveProviderWorkerConfig(input: ProviderWorkerConfigInput) {
  const rawControlUrl = required(input, "controlUrl");
  const url = new URL(rawControlUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Provider worker controlUrl must use http, https, ws, or wss.");
  }
  const sandboxId = required(input, "sandboxId");
  const workerId = required(input, "workerId");
  if (!uuid(sandboxId)) throw new Error("Provider worker sandboxId must be a UUID.");
  if (!uuid(workerId)) throw new Error("Provider worker workerId must be a UUID.");
  const lifecycleGeneration = required(input, "lifecycleGeneration");
  const bootstrapCredential = required(input, "bootstrapCredential");
  const cwd = input.cwd?.trim() || "/workspace";
  const homeDir = input.homeDir?.trim() || "/tmp/synara-provider-worker";
  const agentGatewayUrl = input.agentGatewayUrl?.trim();
  const agentGatewayBearerToken = input.agentGatewayBearerToken?.trim();
  if ((agentGatewayUrl === undefined) !== (agentGatewayBearerToken === undefined)) {
    throw new Error(
      "Provider worker configuration requires both agentGatewayUrl and agentGatewayBearerToken.",
    );
  }
  if (agentGatewayUrl !== undefined) {
    const gatewayUrl = new URL(agentGatewayUrl);
    if (gatewayUrl.protocol !== "http:" && gatewayUrl.protocol !== "https:") {
      throw new Error("Provider worker agentGatewayUrl must use http or https.");
    }
  }

  return {
    controlUrl: url.toString(),
    bootstrapCredential,
    sandboxId,
    workerId,
    lifecycleGeneration,
    cwd,
    homeDir,
    ...(agentGatewayUrl === undefined || agentGatewayBearerToken === undefined
      ? {}
      : {
          agentGatewayConnection: {
            url: agentGatewayUrl,
            bearerToken: agentGatewayBearerToken,
          },
        }),
    safeDescription: {
      controlOrigin: url.origin,
      sandboxId,
      workerId,
      lifecycleGeneration,
      cwd,
    },
  } as const;
}
