export type DaytonaSandboxRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly apiKey: string;
      readonly apiUrl: string;
      readonly target: string;
      readonly snapshot: string;
      readonly idleTimeoutMinutes: number;
      readonly maxActiveSandboxes: number;
    };

export function resolveDaytonaSandboxRuntimeConfig(environment: Readonly<Record<string, string | undefined>>): DaytonaSandboxRuntimeConfig {
  if (environment.SYNARA_WORKSPACE_RUNTIME !== "daytona") return { enabled: false };
  const apiKey = environment.SYNARA_DAYTONA_API_KEY?.trim();
  const snapshot = environment.SYNARA_DAYTONA_SNAPSHOT?.trim();
  const target = environment.SYNARA_DAYTONA_TARGET?.trim() || "us";
  const apiUrl = environment.SYNARA_DAYTONA_API_URL?.trim() || "https://app.daytona.io/api";
  const idleTimeoutMinutes = Number(environment.SYNARA_DAYTONA_IDLE_TIMEOUT_MINUTES ?? "30");
  const maxActiveSandboxes = Number(environment.SYNARA_DAYTONA_MAX_ACTIVE_SANDBOXES ?? "100");
  const url = new URL(apiUrl);
  if (!apiKey || !snapshot || url.protocol !== "https:" || url.username || url.password ||
      !/^[a-z0-9-]+$/u.test(target) || !Number.isInteger(idleTimeoutMinutes) ||
      idleTimeoutMinutes < 1 || idleTimeoutMinutes > 120 ||
      !Number.isInteger(maxActiveSandboxes) || maxActiveSandboxes < 1) {
    throw new Error("Daytona requires an API key, prepared snapshot, HTTPS API URL, target, idle timeout, and positive sandbox limit.");
  }
  return { enabled: true, apiKey, apiUrl, target, snapshot, idleTimeoutMinutes, maxActiveSandboxes };
}
