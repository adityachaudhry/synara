import path from "node:path";
import { repositoryLfsScript, repositoryS3LfsUnmountScript } from "./repositoryLfs.ts";

import type { ProjectRepositoryBinding } from "@synara/contracts";
import {
  isProviderPersistencePathSafe,
  type ProviderPersistenceCandidateSelection,
} from "../providerPersistence.ts";

export const REPOSITORY_CHECKOUT_ROOT = "/workspace/repository";
export const REPOSITORY_CREDENTIAL_CONFIG_PATH = "/root/.synara-repository-credential.gitconfig";

const COMMIT_MARKER = "__SYNARA_CHECKOUT_COMMIT__=";
const CHECKOUT_MODE_MARKER = "__SYNARA_CHECKOUT_MODE__=";
const PREVIOUS_COMMIT_MARKER = "__SYNARA_PREVIOUS_COMMIT__=";
const CHANGED_FILES_MARKER = "__SYNARA_CHANGED_FILES__=";
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

// Inherited by nested Git/LFS processes, including plans with a temporary credential config.
export const PRIVILEGED_GIT_ENV = "export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=http:https GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false";

/** Keep imported configuration as recovery data; root Git reads only our active configuration. */
export function preparePrivilegedRepository(checkoutRoot: string, repositoryUrl: string): string {
  const url = new URL(repositoryUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Privileged repository access requires an HTTP(S) URL without credentials.");
  const config = `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n\thooksPath = /dev/null\n\tfsmonitor = false\n[remote "origin"]\n\turl = ${JSON.stringify(repositoryUrl)}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tpromisor = true\n\tpartialclonefilter = blob:none\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n`;
  const script = `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=${JSON.stringify(checkoutRoot)},config=${JSON.stringify(config)},metadata=path.join(root,'.git');
function directory(file){const st=fs.lstatSync(file);if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(file)!==file)throw Error('Unsupported repository directory; original retained');}
for(let dir=root;dir!=='/';dir=path.dirname(dir))directory(dir);
directory(metadata);
function metadataTree(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),st=fs.lstatSync(file);if(st.isDirectory()&&!st.isSymbolicLink())metadataTree(file);else if(!st.isFile()||st.nlink!==1)throw Error('Unsupported private Git link; original retained');}}
metadataTree(metadata);
for(const rel of ['commondir','worktrees','objects/info/alternates','objects/info/http-alternates','info/grafts'])if(fs.existsSync(path.join(metadata,rel)))throw Error('Unsupported private Git layout; original retained');
const active=path.join(metadata,'config');
for(const name of ['config','config.worktree']){const file=path.join(metadata,name);if(!fs.existsSync(file))continue;const st=fs.lstatSync(file);if(!st.isFile()||st.nlink!==1||fs.realpathSync(file)!==file)throw Error('Unsafe private Git config; original retained');}
const entries=cp.execFileSync('git',['config','--file',active,'--no-includes','--null','--list']).toString().split('\\0').filter(Boolean);
for(const entry of entries){const i=entry.indexOf('\\n'),key=entry.slice(0,i),value=entry.slice(i+1);if((key==='core.repositoryformatversion'&&value!=='0')||key.startsWith('extensions.'))throw Error('Unsupported private Git format; original retained');}
const original=fs.readFileSync(active);
if(!original.equals(Buffer.from(config))){const saved=active+'.synara-original-'+crypto.createHash('sha256').update(original).digest('hex');if(!fs.existsSync(saved))fs.writeFileSync(saved,original,{flag:'wx',mode:0o600});else if(!fs.lstatSync(saved).isFile()||fs.lstatSync(saved).nlink!==1||!fs.readFileSync(saved).equals(original))throw Error('Private Git config recovery copy conflicts; original retained');const temporary=active+'.synara-'+crypto.randomUUID();fs.writeFileSync(temporary,config,{flag:'wx',mode:0o644});fs.renameSync(temporary,active);}
`;
  return `{ ${PRIVILEGED_GIT_ENV}; node -e ${shellQuote(script)}; }`;
}

export function hydrateLfs(checkoutRoot: string, companyPath: string, repositoryUrl: string, sourceOrigin: string, credentialConfigPath?: string, mountRoot?: string, onlyPath?: string): string {
  const script = repositoryLfsScript({ checkoutRoot, companyPath, repositoryUrl, sourceOrigin,
    ...(credentialConfigPath ? { credentialConfigPath } : {}), ...(mountRoot ? { mountRoot } : {}), ...(onlyPath ? { onlyPath } : {}) });
  return `${preparePrivilegedRepository(checkoutRoot, repositoryUrl)} && GIT_TERMINAL_PROMPT=0 ${credentialConfigPath ? `GIT_CONFIG_GLOBAL=${shellQuote(credentialConfigPath)} ` : ""}node -e ${shellQuote(script)}`;
}

export function uncoverLfs(checkoutRoot: string, companyPath: string, mountRoot?: string, onlyPath?: string): string {
  return mountRoot ? `node -e ${shellQuote(repositoryS3LfsUnmountScript(checkoutRoot, companyPath, onlyPath))}` : ":";
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
  readonly companyOnly?: boolean;
  readonly mountRoot?: string;
}) {
  const checkoutRoot = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  const cwd = path.posix.join(checkoutRoot, input.binding.path);
  const repositoryUrl = `${input.repositoryOrigin ?? input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const executionRef = input.companyOnly ? `workspaces/${input.binding.path.split("/").at(-1)}` : input.binding.ref;
  const git = `git -C ${shellQuote(checkoutRoot)}`;
  const authenticatedGit = input.credentialConfigPath
    ? `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=${shellQuote(input.credentialConfigPath)} ${git}`
    : `GIT_TERMINAL_PROMPT=0 ${git}`;
  const sparseGit = `${authenticatedGit} -c core.sparseCheckout=true -c core.sparseCheckoutCone=true`;
  const sparsePath = path.posix.join(checkoutRoot, ".git", "info", "sparse-checkout");
  const command = [
    `set -eu; export GIT_LFS_SKIP_SMUDGE=1; ${PRIVILEGED_GIT_ENV}`,
    `mkdir -p ${shellQuote(checkoutRoot)}`,
    `${input.credentialConfigPath ? `GIT_CONFIG_GLOBAL=${shellQuote(input.credentialConfigPath)} ` : ""}GIT_TERMINAL_PROMPT=0 git clone ${input.companyOnly ? `--single-branch --branch ${shellQuote(executionRef)} ` : ""}--no-checkout --depth=1 --filter=blob:none --config core.sparseCheckout=true --config core.sparseCheckoutCone=true ${shellQuote(repositoryUrl)} ${shellQuote(checkoutRoot)}`,
    preparePrivilegedRepository(checkoutRoot, repositoryUrl),
    `mkdir -p ${shellQuote(path.posix.dirname(sparsePath))}`,
    `printf '%s' ${shellQuote(sparseCheckoutPattern(input.binding.path))} > ${shellQuote(sparsePath)}`,
    input.companyOnly
      ? `printf '${CHECKOUT_MODE_MARKER}company\\n'`
      : `if ${authenticatedGit} fetch --depth=1 --no-tags --filter=blob:none origin ${shellQuote(executionRef)}; then printf '${CHECKOUT_MODE_MARKER}partial\\n'; else ${authenticatedGit} fetch --depth=1 --no-tags origin ${shellQuote(executionRef)} && printf '${CHECKOUT_MODE_MARKER}shallow\\n'; fi`,
    `source_commit="$(${git} rev-parse ${input.companyOnly ? "HEAD" : "FETCH_HEAD"})"`,
    `${sparseGit} checkout --detach "$source_commit"`,
    `test "$(${git} rev-parse HEAD)" = "$source_commit"`,
    hydrateLfs(checkoutRoot, input.binding.path, repositoryUrl, input.binding.origin, input.credentialConfigPath, input.mountRoot),
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
  readonly mountRoot?: string;
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
    `set -eu; export GIT_LFS_SKIP_SMUDGE=1; ${preparePrivilegedRepository(checkoutRoot, repositoryUrl)}`,
    `previous="$(${git} rev-parse HEAD)"`,
    `${authenticatedGit} fetch --no-tags --filter=blob:none ${shellQuote(repositoryUrl)} ${shellQuote(input.commit)}`,
    uncoverLfs(checkoutRoot, input.binding.path, input.mountRoot),
    stashSelected,
    `if ! ${authenticatedGit} merge --ff-only --no-edit FETCH_HEAD; then ${restoreSelectedOnFailure}; exit 1; fi`,
    `test "$(${git} rev-parse HEAD)" = ${shellQuote(input.commit)}`,
    hydrateLfs(checkoutRoot, input.binding.path, repositoryUrl, input.binding.origin, input.credentialConfigPath, input.mountRoot),
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
  readonly companyOnly?: boolean;
  readonly mountRoot?: string;
}) {
  const checkoutRoot = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  const repositoryUrl = `${input.repositoryOrigin ?? input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const executionRef = input.companyOnly ? `workspaces/${input.binding.path.split("/").at(-1)}` : input.binding.ref;
  const git = `git -C ${shellQuote(checkoutRoot)}`;
  const authenticatedGit = input.credentialConfigPath
    ? `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=${shellQuote(input.credentialConfigPath)} ${git} -c core.sparseCheckout=true -c core.sparseCheckoutCone=true -c remote.origin.url=${shellQuote(repositoryUrl)} -c remote.origin.promisor=true`
    : `GIT_TERMINAL_PROMPT=0 ${git} -c core.sparseCheckout=true -c core.sparseCheckoutCone=true -c remote.origin.url=${shellQuote(repositoryUrl)} -c remote.origin.promisor=true`;
  const changed = `const cp=require("node:child_process");process.stdout.write(${JSON.stringify(CHANGED_FILES_MARKER)}+cp.execFileSync("git",["-C",${JSON.stringify(checkoutRoot)},"diff","--name-only","-z",process.argv[1],process.argv[2],"--",${JSON.stringify(input.binding.path)}]).toString("base64")+"\\n")`;
  return {
    cwd: path.posix.join(checkoutRoot, input.binding.path),
    command: [
      `set -eu; export GIT_LFS_SKIP_SMUDGE=1; ${preparePrivilegedRepository(checkoutRoot, repositoryUrl)}`,
      `previous="$(${git} rev-parse HEAD)"`,
      `if ${git} remote get-url origin >/dev/null 2>&1; then ${git} remote set-url origin ${shellQuote(repositoryUrl)}; fi`,
      `${authenticatedGit} fetch --no-tags --filter=blob:none ${shellQuote(repositoryUrl)} ${shellQuote(executionRef)}`,
      `source_commit="$(${git} rev-parse FETCH_HEAD)"`,
      `if [ "$previous" != "$source_commit" ]; then ${uncoverLfs(checkoutRoot, input.binding.path, input.mountRoot)} && ${authenticatedGit} merge --ff-only --no-edit "$source_commit"; fi`,
      `test "$(${git} rev-parse HEAD)" = "$source_commit"`,
      hydrateLfs(checkoutRoot, input.binding.path, repositoryUrl, input.binding.origin, input.credentialConfigPath, input.mountRoot),
      `printf '${PREVIOUS_COMMIT_MARKER}%s\\n' "$previous"`,
      `printf '${COMMIT_MARKER}%s\\n' "$source_commit"`,
      `printf '${CHECKOUT_MODE_MARKER}${input.companyOnly ? "company" : "partial"}\\n'`,
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
  readonly checkoutMode: "partial" | "shallow" | "company";
} {
  const commit = stdout.match(
    new RegExp(`(?:^|\\n)${COMMIT_MARKER}([0-9a-f]{40})(?:\\n|$)`, "u"),
  )?.[1];
  const checkoutMode = stdout.match(
    new RegExp(`(?:^|\\n)${CHECKOUT_MODE_MARKER}(partial|shallow|company)(?:\\n|$)`, "u"),
  )?.[1];
  if (!commit || (checkoutMode !== "partial" && checkoutMode !== "shallow" && checkoutMode !== "company")) {
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
