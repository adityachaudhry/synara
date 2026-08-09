import path from "node:path";

import type { ProjectRepositoryBinding } from "@synara/contracts";

export const GITEA_CHECKOUT_TOKEN_ENV_KEY = "SYNARA_GITEA_CHECKOUT_TOKEN";
export const GITEA_CHECKOUT_ROOT = "/workspace/repository";

const COMMIT_MARKER = "__SYNARA_CHECKOUT_COMMIT__=";
const CHECKOUT_MODE_MARKER = "__SYNARA_CHECKOUT_MODE__=";
const REFRESH_OUTCOME_MARKER = "__SYNARA_CHECKOUT_REFRESH__=";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export interface GiteaCheckoutRepositoryConfig {
  readonly origin: string;
  readonly owner: string;
  readonly repository: string;
  readonly ref: string;
  readonly companiesRoot: string;
  readonly readToken: string;
}

function matchesRepository(
  actual: ProjectRepositoryBinding,
  expected: GiteaCheckoutRepositoryConfig,
): boolean {
  return (
    actual.origin === expected.origin &&
    actual.owner === expected.owner &&
    actual.repository === expected.repository &&
    actual.ref === expected.ref &&
    actual.path.startsWith(`${expected.companiesRoot}/`)
  );
}

export interface GiteaCheckoutPlan {
  readonly command: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

function resolveCheckout(input: {
  readonly binding: ProjectRepositoryBinding;
  readonly repository: GiteaCheckoutRepositoryConfig;
  readonly checkoutRoot?: string;
}) {
  if (!matchesRepository(input.binding, input.repository)) {
    throw new Error("The project repository binding does not match the configured Gitea repository.");
  }

  const checkoutRoot = input.checkoutRoot ?? GITEA_CHECKOUT_ROOT;
  return {
    checkoutRoot,
    companyCwd: path.posix.join(checkoutRoot, input.binding.path),
    repositoryUrl: `${input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`,
    git: `git -C ${shellQuote(checkoutRoot)}`,
  } as const;
}

export function makeGiteaCheckoutPlan(input: {
  readonly binding: ProjectRepositoryBinding;
  readonly repository: GiteaCheckoutRepositoryConfig;
  readonly checkoutRoot?: string;
}): GiteaCheckoutPlan {
  const { checkoutRoot, companyCwd, repositoryUrl, git } = resolveCheckout(input);
  const command = [
    "set -eu",
    `mkdir -p ${shellQuote(checkoutRoot)}`,
    `${git} init`,
    `${git} sparse-checkout init --cone`,
    `${git} sparse-checkout set ${shellQuote(input.binding.path)}`,
    `if GIT_TERMINAL_PROMPT=0 ${git} -c http.extraHeader=\"Authorization: token $${GITEA_CHECKOUT_TOKEN_ENV_KEY}\" fetch --depth=1 --no-tags --filter=blob:none ${shellQuote(repositoryUrl)} ${shellQuote(input.binding.ref)}; then printf '${CHECKOUT_MODE_MARKER}partial\\n'; else GIT_TERMINAL_PROMPT=0 ${git} -c http.extraHeader=\"Authorization: token $${GITEA_CHECKOUT_TOKEN_ENV_KEY}\" fetch --depth=1 --no-tags ${shellQuote(repositoryUrl)} ${shellQuote(input.binding.ref)} && printf '${CHECKOUT_MODE_MARKER}shallow\\n'; fi`,
    `GIT_TERMINAL_PROMPT=0 ${git} -c http.extraHeader="Authorization: token $${GITEA_CHECKOUT_TOKEN_ENV_KEY}" checkout --detach FETCH_HEAD`,
    `test -f ${shellQuote(path.posix.join(companyCwd, "company.json"))}`,
    `printf '${COMMIT_MARKER}%s\\n' \"$(${git} rev-parse HEAD)\"`,
  ].join(" && ");

  return {
    command,
    cwd: companyCwd,
    environment: { [GITEA_CHECKOUT_TOKEN_ENV_KEY]: input.repository.readToken },
  };
}

export function makeGiteaCheckoutRefreshPlan(input: {
  readonly binding: ProjectRepositoryBinding;
  readonly repository: GiteaCheckoutRepositoryConfig;
  readonly checkoutRoot?: string;
}): GiteaCheckoutPlan {
  const { checkoutRoot, companyCwd, repositoryUrl, git } = resolveCheckout(input);
  const companySentinel = path.posix.join(companyCwd, "company.json");
  const authenticatedGit = `GIT_TERMINAL_PROMPT=0 ${git} -c http.extraHeader="Authorization: token $${GITEA_CHECKOUT_TOKEN_ENV_KEY}"`;
  const command = [
    "set -eu",
    `test -d ${shellQuote(path.posix.join(checkoutRoot, ".git"))}`,
    `remote_commit="$(${authenticatedGit} ls-remote --exit-code ${shellQuote(repositoryUrl)} ${shellQuote(input.binding.ref)} | awk 'NR == 1 { print $1 }')"`,
    `printf '%s' "$remote_commit" | grep -Eq '^[0-9a-f]{40}$'`,
    `local_commit="$(${git} rev-parse HEAD)"`,
    `if [ "$remote_commit" = "$local_commit" ] && [ -f ${shellQuote(companySentinel)} ]; then printf '${REFRESH_OUTCOME_MARKER}unchanged\\n${COMMIT_MARKER}%s\\n' "$local_commit"; exit 0; fi`,
    `${git} sparse-checkout init --cone`,
    `${git} sparse-checkout set ${shellQuote(input.binding.path)}`,
    `if ${authenticatedGit} fetch --depth=1 --no-tags --filter=blob:none ${shellQuote(repositoryUrl)} ${shellQuote(input.binding.ref)}; then printf '${CHECKOUT_MODE_MARKER}partial\\n'; else ${authenticatedGit} fetch --depth=1 --no-tags ${shellQuote(repositoryUrl)} ${shellQuote(input.binding.ref)} && printf '${CHECKOUT_MODE_MARKER}shallow\\n'; fi`,
    `${authenticatedGit} checkout --detach FETCH_HEAD`,
    `test -f ${shellQuote(companySentinel)}`,
    `printf '${REFRESH_OUTCOME_MARKER}updated\\n${COMMIT_MARKER}%s\\n' "$(${git} rev-parse HEAD)"`,
  ].join(" && ");

  return {
    command,
    cwd: companyCwd,
    environment: { [GITEA_CHECKOUT_TOKEN_ENV_KEY]: input.repository.readToken },
  };
}

export function parseGiteaCheckoutCommit(stdout: string): string {
  const match = stdout.match(
    new RegExp(`(?:^|\\n)${COMMIT_MARKER}([0-9a-f]{40})(?:\\n|$)`, "u"),
  );
  if (!match?.[1]) {
    throw new Error("Gitea checkout output did not contain a valid commit marker.");
  }
  return match[1];
}

export function parseGiteaCheckoutResult(stdout: string): {
  readonly commit: string;
  readonly checkoutMode: "partial" | "shallow";
} {
  const commit = parseGiteaCheckoutCommit(stdout);
  const match = stdout.match(
    new RegExp(`(?:^|\\n)${CHECKOUT_MODE_MARKER}(partial|shallow)(?:\\n|$)`, "u"),
  );
  if (match?.[1] !== "partial" && match?.[1] !== "shallow") {
    throw new Error("Gitea checkout output did not contain a valid checkout mode marker.");
  }
  return { commit, checkoutMode: match[1] };
}

export type GiteaCheckoutRefreshResult =
  | {
      readonly outcome: "unchanged";
      readonly commit: string;
    }
  | {
      readonly outcome: "updated";
      readonly commit: string;
      readonly checkoutMode: "partial" | "shallow";
    };

export function parseGiteaCheckoutRefreshResult(stdout: string): GiteaCheckoutRefreshResult {
  const commit = parseGiteaCheckoutCommit(stdout);
  const outcome = stdout.match(
    new RegExp(`(?:^|\\n)${REFRESH_OUTCOME_MARKER}(unchanged|updated)(?:\\n|$)`, "u"),
  )?.[1];
  if (outcome === "unchanged") return { outcome, commit };
  if (outcome !== "updated") {
    throw new Error("Gitea checkout output did not contain a valid refresh outcome marker.");
  }
  const checkoutMode = stdout.match(
    new RegExp(`(?:^|\\n)${CHECKOUT_MODE_MARKER}(partial|shallow)(?:\\n|$)`, "u"),
  )?.[1];
  if (checkoutMode !== "partial" && checkoutMode !== "shallow") {
    throw new Error("Updated Gitea checkout output did not contain a valid checkout mode marker.");
  }
  return { outcome, commit, checkoutMode };
}
