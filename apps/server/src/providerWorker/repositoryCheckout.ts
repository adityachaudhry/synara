import path from "node:path";
import { repositoryLfsScript } from "./repositoryLfs.ts";

import type { ProjectRepositoryBinding } from "@synara/contracts";
import {
  isProviderPersistencePathSafe,
  type ProviderPersistenceCandidateSelection,
} from "../providerPersistence.ts";

export const REPOSITORY_CHECKOUT_ROOT = "/workspace/repository";
export const REPOSITORY_CREDENTIAL_CONFIG_PATH = "/tmp/synara-repository-credential.gitconfig";

const COMMIT_MARKER = "__SYNARA_CHECKOUT_COMMIT__=";
const CHECKOUT_MODE_MARKER = "__SYNARA_CHECKOUT_MODE__=";
const PREVIOUS_COMMIT_MARKER = "__SYNARA_PREVIOUS_COMMIT__=";
const CHANGED_FILES_MARKER = "__SYNARA_CHANGED_FILES__=";
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function hydrateLfs(checkoutRoot: string, companyPath: string, repositoryUrl: string, sourceOrigin: string, credentialConfigPath?: string): string {
  const script = repositoryLfsScript({ checkoutRoot, companyPath, repositoryUrl, sourceOrigin, ...(credentialConfigPath ? { credentialConfigPath } : {}) });
  return `GIT_TERMINAL_PROMPT=0 ${credentialConfigPath ? `GIT_CONFIG_GLOBAL=${shellQuote(credentialConfigPath)} ` : ""}node -e ${shellQuote(script)}`;
}

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
  readonly repositoryOrigin?: string;
}) {
  const checkoutRoot = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  const cwd = path.posix.join(checkoutRoot, input.binding.path);
  const repositoryUrl = `${input.repositoryOrigin ?? input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const git = `git -C ${shellQuote(checkoutRoot)}`;
  const authenticatedGit = input.credentialConfigPath
    ? `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=${shellQuote(input.credentialConfigPath)} ${git}`
    : `GIT_TERMINAL_PROMPT=0 ${git}`;
  const sparseGit = `${authenticatedGit} -c core.sparseCheckout=true -c core.sparseCheckoutCone=true`;
  const sparsePath = path.posix.join(checkoutRoot, ".git", "info", "sparse-checkout");
  const command = [
    "set -eu; export GIT_LFS_SKIP_SMUDGE=1",
    `mkdir -p ${shellQuote(checkoutRoot)}`,
    `${input.credentialConfigPath ? `GIT_CONFIG_GLOBAL=${shellQuote(input.credentialConfigPath)} ` : ""}GIT_TERMINAL_PROMPT=0 git clone --no-checkout --depth=1 --filter=blob:none --config core.sparseCheckout=true --config core.sparseCheckoutCone=true ${shellQuote(repositoryUrl)} ${shellQuote(checkoutRoot)}`,
    `mkdir -p ${shellQuote(path.posix.dirname(sparsePath))}`,
    `printf '%s' ${shellQuote(sparseCheckoutPattern(input.binding.path))} > ${shellQuote(sparsePath)}`,
    `if ${authenticatedGit} fetch --depth=1 --no-tags --filter=blob:none origin ${shellQuote(input.binding.ref)}; then printf '${CHECKOUT_MODE_MARKER}partial\\n'; else ${authenticatedGit} fetch --depth=1 --no-tags origin ${shellQuote(input.binding.ref)} && printf '${CHECKOUT_MODE_MARKER}shallow\\n'; fi`,
    `source_commit="$(${git} rev-parse FETCH_HEAD)"`,
    `${sparseGit} checkout --detach FETCH_HEAD`,
    `test "$(${git} rev-parse HEAD)" = "$source_commit"`,
    hydrateLfs(checkoutRoot, input.binding.path, repositoryUrl, input.binding.origin, input.credentialConfigPath),
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
  readonly persistedFiles?: ReadonlyArray<ProviderPersistenceCandidateSelection>;
  readonly credentialConfigPath?: string;
  readonly checkoutRoot?: string;
  readonly repositoryOrigin?: string;
}) {
  if (!/^[0-9a-f]{40}$/u.test(input.commit)) {
    throw new Error("Repository reconciliation requires a full commit SHA.");
  }
  const checkoutRoot = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  const repositoryUrl = `${input.repositoryOrigin ?? input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const git = `git -C ${shellQuote(checkoutRoot)}`;
  const authenticatedGit = input.credentialConfigPath
    ? `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=${shellQuote(input.credentialConfigPath)} ${git} -c core.sparseCheckout=true -c core.sparseCheckoutCone=true -c remote.origin.url=${shellQuote(repositoryUrl)} -c remote.origin.promisor=true`
    : `GIT_TERMINAL_PROMPT=0 ${git} -c core.sparseCheckout=true -c core.sparseCheckoutCone=true -c remote.origin.url=${shellQuote(repositoryUrl)} -c remote.origin.promisor=true`;
  const persistedFiles = input.persistedFiles ?? [];
  if (persistedFiles.some((file) => !isProviderPersistencePathSafe(file.path))) {
    throw new Error("Repository reconciliation received an unsafe persisted path.");
  }
  const checkoutPathspecs = persistedFiles
    .filter((file) => file.source === "checkout")
    .map((file) => path.posix.join(input.binding.path, file.path));
  const stashSelected =
    checkoutPathspecs.length === 0
      ? "stash_created=0"
      : [
          `stash_before="$(${git} rev-parse -q --verify refs/stash || true)"`,
          `${git} stash push --include-untracked --message ${shellQuote(`synara-persist-${input.commit.slice(0, 12)}`)} -- ${checkoutPathspecs.map(shellQuote).join(" ")} >/dev/null`,
          `stash_after="$(${git} rev-parse -q --verify refs/stash || true)"`,
          `if [ "$stash_after" != "$stash_before" ]; then stash_created=1; else stash_created=0; fi`,
        ].join("; ");
  const restoreSelectedOnFailure = `if [ "$stash_created" = 1 ]; then ${git} stash pop --index --quiet >/dev/null 2>&1 || true; fi`;
  const discardSelectedOnSuccess = `if [ "$stash_created" = 1 ]; then ${git} stash drop --quiet 'stash@{0}' >/dev/null 2>&1 || true; fi`;
  const command = [
    "set -eu; export GIT_LFS_SKIP_SMUDGE=1",
    `previous="$(${git} rev-parse HEAD)"`,
    `${authenticatedGit} fetch --no-tags --filter=blob:none ${shellQuote(repositoryUrl)} ${shellQuote(input.commit)}`,
    stashSelected,
    `if ! ${authenticatedGit} merge --ff-only --no-edit FETCH_HEAD; then ${restoreSelectedOnFailure}; exit 1; fi`,
    `test "$(${git} rev-parse HEAD)" = ${shellQuote(input.commit)}`,
    hydrateLfs(checkoutRoot, input.binding.path, repositoryUrl, input.binding.origin, input.credentialConfigPath),
    discardSelectedOnSuccess,
    `printf '${PREVIOUS_COMMIT_MARKER}%s\\n' "$previous"`,
    `printf '${COMMIT_MARKER}%s\\n' "$(${git} rev-parse HEAD)"`,
  ].join("; ");
  return { command, cwd: path.posix.join(checkoutRoot, input.binding.path) } as const;
}

export function makeRepositoryCredentialConfig(
  binding: ProjectRepositoryBinding,
  authorization: string,
  repositoryOrigin = binding.origin,
): string {
  const origin = new URL(repositoryOrigin);
  const scopedOrigin = `${origin.origin}/`;
  return `[http ${JSON.stringify(scopedOrigin)}]\n\textraHeader = Authorization: ${authorization}\n`;
}

/** Refresh a warm/restored checkout without resetting or stashing the agent's drafts. */
export function makeRepositoryRefreshPlan(input: {
  readonly binding: ProjectRepositoryBinding;
  readonly credentialConfigPath?: string;
  readonly checkoutRoot?: string;
  readonly repositoryOrigin?: string;
}) {
  const checkoutRoot = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  const repositoryUrl = `${input.repositoryOrigin ?? input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const git = `git -C ${shellQuote(checkoutRoot)}`;
  const authenticatedGit = input.credentialConfigPath
    ? `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=${shellQuote(input.credentialConfigPath)} ${git} -c core.sparseCheckout=true -c core.sparseCheckoutCone=true -c remote.origin.url=${shellQuote(repositoryUrl)} -c remote.origin.promisor=true`
    : `GIT_TERMINAL_PROMPT=0 ${git} -c core.sparseCheckout=true -c core.sparseCheckoutCone=true -c remote.origin.url=${shellQuote(repositoryUrl)} -c remote.origin.promisor=true`;
  const changed = `const cp=require("node:child_process");process.stdout.write(${JSON.stringify(CHANGED_FILES_MARKER)}+cp.execFileSync("git",["-C",${JSON.stringify(checkoutRoot)},"diff","--name-only","-z",process.argv[1],process.argv[2],"--",${JSON.stringify(input.binding.path)}]).toString("base64")+"\\n")`;
  return {
    cwd: path.posix.join(checkoutRoot, input.binding.path),
    command: [
      "set -eu; export GIT_LFS_SKIP_SMUDGE=1",
      `previous="$(${git} rev-parse HEAD)"`,
      `if ${git} remote get-url origin >/dev/null 2>&1; then ${git} remote set-url origin ${shellQuote(repositoryUrl)}; fi`,
      `${authenticatedGit} fetch --no-tags --filter=blob:none ${shellQuote(repositoryUrl)} ${shellQuote(input.binding.ref)}`,
      `source_commit="$(${git} rev-parse FETCH_HEAD)"`,
      `${authenticatedGit} merge --ff-only --no-edit "$source_commit"`,
      `test "$(${git} rev-parse HEAD)" = "$source_commit"`,
      hydrateLfs(checkoutRoot, input.binding.path, repositoryUrl, input.binding.origin, input.credentialConfigPath),
      `printf '${PREVIOUS_COMMIT_MARKER}%s\\n' "$previous"`,
      `printf '${COMMIT_MARKER}%s\\n' "$source_commit"`,
      `printf '${CHECKOUT_MODE_MARKER}partial\\n'`,
      `node -e ${shellQuote(changed)} "$previous" "$source_commit"`,
    ].join(" && "),
  };
}

export function parseRepositoryRefreshResult(stdout: string) {
  const commits = parseRepositoryReconcileResult(stdout);
  const encoded = stdout.match(new RegExp(`(?:^|\\n)${CHANGED_FILES_MARKER}([^\\n]*)(?:\\n|$)`, "u"))?.[1];
  if (encoded === undefined) throw new Error("Repository refresh did not report changed files.");
  return { ...commits, changedFiles: Buffer.from(encoded, "base64").toString("utf8").split("\0").filter(Boolean) };
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
