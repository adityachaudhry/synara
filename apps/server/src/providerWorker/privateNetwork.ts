import { isPrivateNetworkHostname } from "../privateNetworkHosts.ts";

/** Hosts explicitly trusted over plain HTTP; each must be a private network name (privateNetworkHosts.ts). */
export function privateWorkerHosts(environment: Readonly<Record<string, string | undefined>>): ReadonlyArray<string> {
  const hosts = [...new Set(environment.SYNARA_PROVIDER_WORKER_PRIVATE_HOSTS?.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean) ?? [])];
  if (hosts.some((host) => !isPrivateNetworkHostname(host, environment))) {
    throw new Error("SYNARA_PROVIDER_WORKER_PRIVATE_HOSTS requires exact private network hostnames.");
  }
  return hosts;
}

export function isTrustedPrivateWorkerUrl(url: URL, environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION?.trim().toUpperCase() === "PRIVATE" &&
    privateWorkerHosts(environment).includes(url.hostname.toLowerCase());
}
