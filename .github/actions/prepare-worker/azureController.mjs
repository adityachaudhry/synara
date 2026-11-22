/**
 * The controller's settings when it runs on Azure Container Apps: the container app's environment,
 * where Railway keeps them as service variables. Plain entries are read as they are; entries backed
 * by a Container Apps secret are resolved only when asked for (inline secret value, or the Key Vault
 * secret it references), and masked in the Actions log.
 */
import { execFileSync } from "node:child_process";

/** Every controller setting the worker preparation and the pool cleanup read. */
export const DAYTONA_SETTING_KEYS = [
  "SYNARA_WORKSPACE_RUNTIME",
  "SYNARA_PUBLIC_URL",
  "SYNARA_DAYTONA_API_KEY",
  "SYNARA_DAYTONA_API_URL",
  "SYNARA_DAYTONA_TARGET",
  "SYNARA_DAYTONA_FALLBACK_TARGET",
  "SYNARA_DAYTONA_SNAPSHOT",
  "SYNARA_DAYTONA_FALLBACK_SNAPSHOT",
  "SYNARA_DAYTONA_WARM_POOL_SIZE",
  "SYNARA_DAYTONA_EXCLUSIVE_POOL_OWNER",
];

/** Settings the worker preparation publishes; on Azure the deploy sets them on the new revision. */
export const CONTROLLER_ENV_UPDATES_FILE = ".controller-env-updates";

export function azureControllerTarget(env = process.env) {
  const resourceGroup = env.WORKER_RESOURCE_GROUP?.trim();
  if (!resourceGroup)
    throw new Error("WORKER_RESOURCE_GROUP names the controller's resource group on Azure.");
  return { resourceGroup, containerApp: env.WORKER_CONTAINER_APP?.trim() || "synara-controller" };
}

function az(args) {
  return execFileSync("az", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Reads secret values without letting a failure print them (the error keeps only az's stderr). */
function azSecret(args, what) {
  try {
    return az(args);
  } catch (cause) {
    // Deliberately no `cause`: it carries az's stdout, which can hold secret values.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `Could not read ${what}: ${String(cause?.stderr ?? "")
        .trim()
        .slice(-500)}`,
    );
  }
}

export function readAzureControllerVariables({
  resourceGroup,
  containerApp,
  secretKeys = DAYTONA_SETTING_KEYS,
}) {
  const app = ["--name", containerApp, "--resource-group", resourceGroup];
  const containers = JSON.parse(az(["containerapp", "show", ...app, "--output", "json"])).properties
    .template.containers;
  const container =
    containers.find((candidate) => candidate.name === containerApp) ?? containers[0];
  const variables = {};
  const secretRefs = new Map();
  for (const entry of container?.env ?? []) {
    if (entry.secretRef) secretRefs.set(entry.name, entry.secretRef);
    else variables[entry.name] = entry.value ?? "";
  }
  const wanted = secretKeys.filter((key) => secretRefs.has(key));
  if (!wanted.length) return variables;
  const secrets = JSON.parse(
    azSecret(
      ["containerapp", "secret", "list", ...app, "--show-values", "--output", "json"],
      "the container app's secrets",
    ),
  );
  for (const key of wanted) {
    const name = secretRefs.get(key);
    const secret = secrets.find((candidate) => candidate.name === name);
    let value = secret?.value;
    if (!value && secret?.keyVaultUrl) {
      value = azSecret(
        [
          "keyvault",
          "secret",
          "show",
          "--id",
          secret.keyVaultUrl,
          "--query",
          "value",
          "--output",
          "tsv",
        ],
        `Key Vault secret for ${key}`,
      ).trim();
    }
    if (!value) throw new Error(`${key} refers to secret ${name}, which has no readable value.`);
    if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::add-mask::${value}\n`);
    variables[key] = value;
  }
  return variables;
}
