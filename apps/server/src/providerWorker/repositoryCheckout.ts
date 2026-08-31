import path from "node:path";

import type { ProjectRepositoryBinding } from "@synara/contracts";

export const REPOSITORY_CHECKOUT_ROOT = "/workspace/repository";
export const REPOSITORY_CREDENTIAL_CONFIG_PATH =
  "/tmp/synara-repository-credential.gitconfig";

const COMMIT_MARKER = "__SYNARA_CHECKOUT_COMMIT__=";
const CHECKOUT_MODE_MARKER = "__SYNARA_CHECKOUT_MODE__=";
const PREVIOUS_COMMIT_MARKER = "__SYNARA_PREVIOUS_COMMIT__=";
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
  readonly credentialConfigPath?: string;
  readonly checkoutRoot?: string;
}) {
  const checkoutRoot = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  const cwd = path.posix.join(checkoutRoot, input.binding.path);
  const repositoryUrl = `${input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const git = `git -C ${shellQuote(checkoutRoot)}`;
  const authenticatedGit = input.credentialConfigPath
    ? `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=${shellQuote(input.credentialConfigPath)} ${git}`
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
    environment: {},
  } as const;
}

export function makeRepositoryReconcilePlan(input: {
  readonly binding: ProjectRepositoryBinding;
  readonly commit: string;
  readonly credentialConfigPath?: string;
  readonly checkoutRoot?: string;
}) {
  if (!/^[0-9a-f]{40}$/u.test(input.commit)) {
    throw new Error("Repository reconciliation requires a full commit SHA.");
  }
  const checkoutRoot = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  const repositoryUrl = `${input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const git = `git -C ${shellQuote(checkoutRoot)}`;
  const authenticatedGit = input.credentialConfigPath
    ? `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=${shellQuote(input.credentialConfigPath)} ${git}`
    : `GIT_TERMINAL_PROMPT=0 ${git}`;
  const command = [
    "set -eu",
    `previous="$(${git} rev-parse HEAD)"`,
    `${authenticatedGit} fetch --no-tags --filter=blob:none ${shellQuote(repositoryUrl)} ${shellQuote(input.commit)}`,
    `${authenticatedGit} merge --ff-only --no-edit FETCH_HEAD`,
    `printf '${PREVIOUS_COMMIT_MARKER}%s\\n' "$previous"`,
    `printf '${COMMIT_MARKER}%s\\n' "$(${git} rev-parse HEAD)"`,
  ].join(" && ");
  return { command, cwd: path.posix.join(checkoutRoot, input.binding.path) } as const;
}

export function makeRepositoryCredentialConfig(
  binding: ProjectRepositoryBinding,
  authorization: string,
): string {
  const origin = new URL(binding.origin);
  const scopedOrigin = `${origin.origin}/`;
  return `[http ${JSON.stringify(scopedOrigin)}]\n\textraHeader = Authorization: ${authorization}\n`;
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

export function parseRepositoryReconcileResult(stdout: string): {
  readonly previousCommit: string;
  readonly commit: string;
} {
  const previousCommit = stdout.match(
    new RegExp(`(?:^|\\n)${PREVIOUS_COMMIT_MARKER}([0-9a-f]{40})(?:\\n|$)`, "u"),
  )?.[1];
  const commit = stdout.match(
    new RegExp(`(?:^|\\n)${COMMIT_MARKER}([0-9a-f]{40})(?:\\n|$)`, "u"),
  )?.[1];
  if (!previousCommit || !commit) {
    throw new Error("Repository reconciliation output did not contain verified commits.");
  }
  return { previousCommit, commit };
}
