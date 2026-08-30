import path from "node:path";

import type { ProjectRepositoryBinding } from "@synara/contracts";

export const REPOSITORY_AUTHORIZATION_ENV_KEY =
  "SYNARA_PROVIDER_WORKER_REPOSITORY_AUTHORIZATION";
export const REPOSITORY_CHECKOUT_ROOT = "/workspace/repository";

const COMMIT_MARKER = "__SYNARA_CHECKOUT_COMMIT__=";
const CHECKOUT_MODE_MARKER = "__SYNARA_CHECKOUT_MODE__=";
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function sparseCheckoutPattern(bindingPath: string): string {
  const segments = bindingPath.split("/");
  const patterns = ["/*", "!/*/"];
  for (let index = 0; index < segments.length; index += 1) {
    const prefix = `/${segments.slice(0, index + 1).join("/")}`;
    patterns.push(`${prefix}/`);
    if (index < segments.length - 1) patterns.push(`!${prefix}/*/`);
  }
  return `${patterns.join("\n")}\n`;
}

export function makeRepositoryCheckoutPlan(input: {
  readonly binding: ProjectRepositoryBinding;
  readonly authorization?: string;
  readonly checkoutRoot?: string;
}) {
  const checkoutRoot = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  const cwd = path.posix.join(checkoutRoot, input.binding.path);
  const repositoryUrl = `${input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const git = `git -C ${shellQuote(checkoutRoot)}`;
  const authenticatedGit = input.authorization
    ? `GIT_TERMINAL_PROMPT=0 ${git} -c http.extraHeader="Authorization: $${REPOSITORY_AUTHORIZATION_ENV_KEY}"`
    : `GIT_TERMINAL_PROMPT=0 ${git}`;
  const sparseGit = `${authenticatedGit} -c core.sparseCheckout=true -c core.sparseCheckoutCone=true`;
  const sparsePath = path.posix.join(checkoutRoot, ".git", "info", "sparse-checkout");
  const command = [
    "set -eu",
    `mkdir -p ${shellQuote(checkoutRoot)}`,
    `${git} init`,
    `mkdir -p ${shellQuote(path.posix.dirname(sparsePath))}`,
    `printf '%s' ${shellQuote(sparseCheckoutPattern(input.binding.path))} > ${shellQuote(sparsePath)}`,
    `if ${authenticatedGit} fetch --depth=1 --no-tags --filter=blob:none ${shellQuote(repositoryUrl)} ${shellQuote(input.binding.ref)}; then printf '${CHECKOUT_MODE_MARKER}partial\\n'; else ${authenticatedGit} fetch --depth=1 --no-tags ${shellQuote(repositoryUrl)} ${shellQuote(input.binding.ref)} && printf '${CHECKOUT_MODE_MARKER}shallow\\n'; fi`,
    `${sparseGit} checkout --detach FETCH_HEAD`,
    `test -d ${shellQuote(cwd)}`,
    `printf '${COMMIT_MARKER}%s\\n' "$(${git} rev-parse HEAD)"`,
  ].join(" && ");

  return {
    command,
    cwd,
    environment: input.authorization
      ? { [REPOSITORY_AUTHORIZATION_ENV_KEY]: input.authorization }
      : {},
  } as const;
}

export function parseRepositoryCheckoutResult(stdout: string): {
  readonly commit: string;
  readonly checkoutMode: "partial" | "shallow";
} {
  const commit = stdout.match(
    new RegExp(`(?:^|\\n)${COMMIT_MARKER}([0-9a-f]{40})(?:\\n|$)`, "u"),
  )?.[1];
  const checkoutMode = stdout.match(
    new RegExp(`(?:^|\\n)${CHECKOUT_MODE_MARKER}(partial|shallow)(?:\\n|$)`, "u"),
  )?.[1];
  if (!commit || (checkoutMode !== "partial" && checkoutMode !== "shallow")) {
    throw new Error("Repository checkout output did not contain a verified commit and mode.");
  }
  return { commit, checkoutMode };
}
