import { controllerEnvironmentName } from "../controllerEnvironment.ts";
import type { SandboxPurpose } from "./Services/RailwaySandboxClient.ts";
import { domainAllowListValue, resolveSandboxNetworkPolicy } from "./sandboxNetwork.ts";

export type DaytonaSandboxRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly apiKey: string;
      readonly apiUrl: string;
      readonly target: string;
      readonly snapshot: string;
      readonly fallbackTarget?: string | undefined;
      readonly fallbackSnapshot?: string | undefined;
      readonly warmPoolSize: number;
      readonly idleTimeoutMinutes: number;
      readonly maxActiveSandboxes: number;
      /** Labels every sandbox `env=<name>`; dev and production share one Daytona organization. */
      readonly environmentName: string;
      /** Comma-separated outbound allow-list; undefined only when explicitly disabled. */
      readonly domainAllowList: string | undefined;
      /** Wall-clock lifetime by purpose (0 disables). Sandboxes are disposable, so expiry only forces a replacement. */
      readonly ttlMinutes: Readonly<Record<SandboxPurpose, number>>;
    };

const DEFAULT_TTL_MINUTES: Readonly<Record<SandboxPurpose, number>> = { chat: 720, diligence: 360, eval: 120 };

const ttlMinutes = (environment: Readonly<Record<string, string | undefined>>) => {
  const resolved: Record<SandboxPurpose, number> = { ...DEFAULT_TTL_MINUTES };
  for (const purpose of Object.keys(DEFAULT_TTL_MINUTES) as SandboxPurpose[]) {
    const raw = environment[`SYNARA_DAYTONA_TTL_MINUTES_${purpose.toUpperCase()}`]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 7 * 24 * 60) {
      throw new Error(`SYNARA_DAYTONA_TTL_MINUTES_${purpose.toUpperCase()} must be whole minutes between 0 and 10080.`);
    }
    resolved[purpose] = value;
  }
  return resolved;
};

export function resolveDaytonaSandboxRuntimeConfig(environment: Readonly<Record<string, string | undefined>>): DaytonaSandboxRuntimeConfig {
  if (environment.SYNARA_WORKSPACE_RUNTIME !== "daytona") return { enabled: false };
  const apiKey = environment.SYNARA_DAYTONA_API_KEY?.trim();
  const snapshot = environment.SYNARA_DAYTONA_SNAPSHOT?.trim();
  const target = environment.SYNARA_DAYTONA_TARGET?.trim() || "us";
  const fallbackTarget = environment.SYNARA_DAYTONA_FALLBACK_TARGET?.trim();
  const fallbackSnapshot = environment.SYNARA_DAYTONA_FALLBACK_SNAPSHOT?.trim();
  const warmPoolSize = Number(environment.SYNARA_DAYTONA_WARM_POOL_SIZE ?? "0");
  const apiUrl = environment.SYNARA_DAYTONA_API_URL?.trim() || "https://app.daytona.io/api";
  const idleTimeoutMinutes = Number(environment.SYNARA_DAYTONA_IDLE_TIMEOUT_MINUTES ?? "30");
  const maxActiveSandboxes = Number(environment.SYNARA_DAYTONA_MAX_ACTIVE_SANDBOXES ?? "100");
  const url = new URL(apiUrl);
  if (!apiKey || !snapshot || url.protocol !== "https:" || url.username || url.password ||
      !/^[a-z0-9-]+$/u.test(target) || !Number.isInteger(idleTimeoutMinutes) ||
      idleTimeoutMinutes < 1 || idleTimeoutMinutes > 120 ||
      (fallbackTarget && (!/^[a-z0-9-]+$/u.test(fallbackTarget) || fallbackTarget === target || !fallbackSnapshot)) ||
      (!fallbackTarget && fallbackSnapshot) || !Number.isInteger(warmPoolSize) || warmPoolSize < 0 || warmPoolSize > 5 ||
      !Number.isInteger(maxActiveSandboxes) || maxActiveSandboxes < 1) {
    throw new Error("Daytona requires an API key, prepared snapshot, HTTPS API URL, target, idle timeout, and positive sandbox limit.");
  }
  return {
    enabled: true, apiKey, apiUrl, target, snapshot,
    ...(fallbackTarget ? { fallbackTarget, fallbackSnapshot } : {}),
    warmPoolSize, idleTimeoutMinutes, maxActiveSandboxes,
    environmentName: controllerEnvironmentName(environment),
    domainAllowList: domainAllowListValue(resolveSandboxNetworkPolicy(environment)),
    ttlMinutes: ttlMinutes(environment),
  };
}
