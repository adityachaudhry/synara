/**
 * Outbound network policy for Daytona sandboxes.
 *
 * A sandbox needs only the company Git host (clone, fetch, LFS batch) and the S3 host (the
 * read-only LFS mount, Gitea LFS direct downloads and signed Outbox artifact uploads). Model,
 * web and research calls run in the controller, so the sandbox gets nothing else by default.
 *
 * - `SYNARA_DAYTONA_DOMAIN_ALLOW_LIST`: an explicit comma-separated list that replaces the
 *   derived one, or `off` to create sandboxes without an allow-list (incident escape hatch).
 * - `SYNARA_DAYTONA_EXTRA_ALLOWED_DOMAINS`: hosts added to the derived list.
 */
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u;

export type SandboxNetworkPolicy =
  | { readonly unrestricted: true }
  | { readonly unrestricted?: false; readonly domainAllowList: readonly string[] };

const hostOf = (value: string) => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

export function resolveSandboxNetworkPolicy(environment: Readonly<Record<string, string | undefined>>): SandboxNetworkPolicy {
  const override = environment.SYNARA_DAYTONA_DOMAIN_ALLOW_LIST?.trim();
  if (override?.toLowerCase() === "off") return { unrestricted: true };
  const entries = override
    ? override.split(",")
    : [
        environment.SYNARA_GITEA_ORIGIN,
        ...(environment.SYNARA_EXTERNAL_REPOSITORY_ALLOWED_ORIGINS?.split(",") ?? []),
        environment.SYNARA_GITEA_LFS_S3_ENDPOINT,
        ...(environment.SYNARA_DAYTONA_EXTRA_ALLOWED_DOMAINS?.split(",") ?? []),
      ];
  const domains = new Set<string>();
  for (const entry of entries) {
    const value = entry?.trim();
    if (!value) continue;
    const host = value.includes("://") ? hostOf(value) : value.toLowerCase();
    if (!host || !HOST.test(host)) throw new Error(`Sandbox allow-list entry '${value}' is not a host name or URL.`);
    domains.add(host);
  }
  if (domains.size === 0) {
    throw new Error(
      "Daytona sandboxes need an outbound allow-list: configure SYNARA_GITEA_ORIGIN and SYNARA_GITEA_LFS_S3_ENDPOINT, " +
        "set SYNARA_DAYTONA_DOMAIN_ALLOW_LIST, or set it to 'off'.",
    );
  }
  return { domainAllowList: [...domains].sort() };
}

/** The comma-separated form Daytona takes; undefined when sandboxes are unrestricted. */
export const domainAllowListValue = (policy: SandboxNetworkPolicy) =>
  policy.unrestricted ? undefined : policy.domainAllowList.join(",");

export function sandboxHostAllowed(policy: SandboxNetworkPolicy, host: string): boolean {
  if (policy.unrestricted) return true;
  const candidate = host.toLowerCase();
  return policy.domainAllowList.some((entry) =>
    entry.startsWith("*.") ? candidate.endsWith(entry.slice(1)) : candidate === entry);
}
