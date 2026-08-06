import path from "node:path";

import type { ProjectRepositoryBinding } from "@synara/contracts";

export const GITEA_CHECKOUT_TOKEN_ENV_KEY = "SYNARA_GITEA_CHECKOUT_TOKEN";
export const GITEA_CHECKOUT_ROOT = "/workspace/repository";

const COMMIT_MARKER = "__SYNARA_CHECKOUT_COMMIT__=";

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

export function makeGiteaCheckoutPlan(input: {
  readonly binding: ProjectRepositoryBinding;
  readonly repository: GiteaCheckoutRepositoryConfig;
  readonly checkoutRoot?: string;
}): GiteaCheckoutPlan {
  if (!matchesRepository(input.binding, input.repository)) {
    throw new Error("The project repository binding does not match the configured Gitea repository.");
  }

  const checkoutRoot = input.checkoutRoot ?? GITEA_CHECKOUT_ROOT;
  const companyCwd = path.posix.join(checkoutRoot, input.binding.path);
  const repositoryUrl = `${input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const sparsePattern = `/${input.binding.path}/`;
  const git = `git -C ${shellQuote(checkoutRoot)}`;
  const command = [
    "set -eu",
    `mkdir -p ${shellQuote(checkoutRoot)}`,
    `${git} init`,
    `${git} remote add origin ${shellQuote(repositoryUrl)}`,
    `${git} config core.sparseCheckout true`,
    `mkdir -p ${shellQuote(path.posix.join(checkoutRoot, ".git/info"))}`,
    `printf '%s\\n' ${shellQuote(sparsePattern)} > ${shellQuote(path.posix.join(checkoutRoot, ".git/info/sparse-checkout"))}`,
    `GIT_TERMINAL_PROMPT=0 ${git} -c http.extraHeader=\"Authorization: token $${GITEA_CHECKOUT_TOKEN_ENV_KEY}\" fetch --depth=1 origin ${shellQuote(input.binding.ref)}`,
    `${git} checkout --detach FETCH_HEAD`,
    `test -f ${shellQuote(path.posix.join(companyCwd, "company.json"))}`,
    `printf '${COMMIT_MARKER}%s\\n' \"$(${git} rev-parse HEAD)\"`,
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
