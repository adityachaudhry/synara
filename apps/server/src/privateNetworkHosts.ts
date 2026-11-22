/**
 * Which hostnames belong to the deployment's private network.
 *
 * - `SYNARA_PRIVATE_HOST_SUFFIXES`: comma-separated DNS suffixes whose names are private.
 *   Unset means `.railway.internal`; set to an empty value for none.
 * - `SYNARA_PRIVATE_HOSTS`: comma-separated exact private names, empty by default. Azure Container
 *   Apps reach each other by single-label app name (`synara-controller,glasswing-api,gitea`).
 *
 * Invalid entries are ignored, so a typo narrows the private set rather than widening it.
 */
type Environment = Readonly<Record<string, string | undefined>>;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`, "u");
const SUFFIX = new RegExp(`^(?:\\.${LABEL})+$`, "u");
const DEFAULT_SUFFIXES: ReadonlyArray<string> = [".railway.internal"];
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

const entries = (raw: string | undefined) => [
  ...new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  ),
];

export function privateHostSuffixes(environment: Environment = process.env): ReadonlyArray<string> {
  const raw = environment.SYNARA_PRIVATE_HOST_SUFFIXES;
  if (raw === undefined) return DEFAULT_SUFFIXES;
  return entries(raw).filter((suffix) => SUFFIX.test(suffix));
}

export function privateExactHosts(environment: Environment = process.env): ReadonlyArray<string> {
  return entries(environment.SYNARA_PRIVATE_HOSTS).filter((host) => HOSTNAME.test(host));
}

/** Whether a bare hostname (no port) names a host on the private network. */
export function isPrivateNetworkHostname(
  hostname: string,
  environment: Environment = process.env,
): boolean {
  const name = hostname.trim().toLowerCase();
  if (!HOSTNAME.test(name)) return false;
  if (privateExactHosts(environment).includes(name)) return true;
  return privateHostSuffixes(environment).some(
    (suffix) => name.length > suffix.length && name.endsWith(suffix),
  );
}

/**
 * Whether a request's `Host` header names this controller on the private network (or loopback).
 * It reads only the header: every request reaches the server through the local socat proxy, so
 * the peer address is always loopback. That is safe only because the platform's public ingress
 * routes by `Host`, so a public request cannot arrive carrying a private name.
 */
export function isPrivateRequestHost(
  host: string | undefined,
  environment: Environment = process.env,
): boolean {
  const name = (host ?? "").trim().toLowerCase().replace(/:\d+$/u, "");
  return LOOPBACK_HOSTS.has(name) || isPrivateNetworkHostname(name, environment);
}
