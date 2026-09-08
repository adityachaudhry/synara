const PRIVATE_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.railway\.internal$/u;

export function privateWorkerHosts(environment: Readonly<Record<string, string | undefined>>): ReadonlyArray<string> {
  const hosts = [...new Set(environment.SYNARA_PROVIDER_WORKER_PRIVATE_HOSTS?.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean) ?? [])];
  if (hosts.some((host) => !PRIVATE_HOST.test(host) || host.includes(".."))) {
    throw new Error("SYNARA_PROVIDER_WORKER_PRIVATE_HOSTS requires exact Railway private hostnames.");
  }
  return hosts;
}

export function isTrustedPrivateWorkerUrl(url: URL, environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.SYNARA_PROVIDER_WORKER_NETWORK_ISOLATION?.trim().toUpperCase() === "PRIVATE" &&
    privateWorkerHosts(environment).includes(url.hostname.toLowerCase());
}
