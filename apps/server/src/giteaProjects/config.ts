import path from "node:path";

const CONFIG_KEYS = [
  "SYNARA_GITEA_ORIGIN",
  "SYNARA_GITEA_OWNER",
  "SYNARA_GITEA_REPOSITORY",
  "SYNARA_GITEA_REF",
  "SYNARA_GITEA_COMPANIES_ROOT",
  "SYNARA_GITEA_READ_USER",
  "SYNARA_GITEA_READ_TOKEN",
  "SYNARA_GITEA_PROJECT_ROOT",
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

export type GiteaCompanyCatalogConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly origin: string;
      readonly owner: string;
      readonly repository: string;
      readonly ref: string;
      readonly companiesRoot: string;
      readonly readUser: string;
      readonly readToken: string;
      readonly projectRoot: string;
    };

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function requireSafeIdentifier(key: ConfigKey, value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value)) {
    throw new Error(`${key} must be a safe repository identifier.`);
  }
  return value;
}

function requireSafeRef(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("@{")
  ) {
    throw new Error("SYNARA_GITEA_REF must be a safe Git ref.");
  }
  return value;
}

function requireHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SYNARA_GITEA_ORIGIN must be an HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.origin !== value
  ) {
    throw new Error("SYNARA_GITEA_ORIGIN must be a credential-free HTTPS origin.");
  }
  return value;
}

export function resolveGiteaCompanyCatalogConfig(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
}): GiteaCompanyCatalogConfig {
  const values = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, trimmed(input.environment[key])]),
  ) as Record<ConfigKey, string | undefined>;
  if (CONFIG_KEYS.every((key) => values[key] === undefined)) return { enabled: false };

  const missing = CONFIG_KEYS.filter((key) => values[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Incomplete Gitea company catalog configuration; missing ${missing.join(", ")}.`);
  }

  const origin = requireHttpsOrigin(values.SYNARA_GITEA_ORIGIN!);
  const owner = requireSafeIdentifier("SYNARA_GITEA_OWNER", values.SYNARA_GITEA_OWNER!);
  const repository = requireSafeIdentifier(
    "SYNARA_GITEA_REPOSITORY",
    values.SYNARA_GITEA_REPOSITORY!,
  );
  const ref = requireSafeRef(values.SYNARA_GITEA_REF!);
  const companiesRoot = requireSafeIdentifier(
    "SYNARA_GITEA_COMPANIES_ROOT",
    values.SYNARA_GITEA_COMPANIES_ROOT!,
  );
  const projectRoot = values.SYNARA_GITEA_PROJECT_ROOT!;
  if (!path.posix.isAbsolute(projectRoot) || path.posix.normalize(projectRoot) !== projectRoot) {
    throw new Error("SYNARA_GITEA_PROJECT_ROOT must be a normalized absolute POSIX path.");
  }

  return {
    enabled: true,
    origin,
    owner,
    repository,
    ref,
    companiesRoot,
    readUser: values.SYNARA_GITEA_READ_USER!,
    readToken: values.SYNARA_GITEA_READ_TOKEN!,
    projectRoot,
  };
}
