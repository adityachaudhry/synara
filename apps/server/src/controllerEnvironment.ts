/**
 * The deployment environment this controller serves (`dev`, `production`, ...).
 *
 * It separates environments that share one Daytona organization and one backup bucket
 * layout: sandbox labels and backup keys carry it. `SYNARA_ENVIRONMENT` overrides
 * Railway's own `RAILWAY_ENVIRONMENT_NAME`; local runs default to `local`.
 */
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u;

export function controllerEnvironmentName(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw =
    environment.SYNARA_ENVIRONMENT?.trim() ||
    environment.RAILWAY_ENVIRONMENT_NAME?.trim() ||
    "local";
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new Error(
      "SYNARA_ENVIRONMENT (or RAILWAY_ENVIRONMENT_NAME) must name the environment with letters, digits and dashes.",
    );
  }
  return name;
}
