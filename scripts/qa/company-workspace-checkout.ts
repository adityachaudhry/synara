/** Real Git corruption/migration trial. All repositories and edits are disposable. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { makeRepositoryCheckoutPlan, makeRepositoryRefreshPlan } from "../../apps/server/src/providerWorker/repositoryCheckout";
import { makeRepositoryIsolationPlan, makeVerifiedRepositoryRefreshPlan } from "../../apps/server/src/providerWorker/repositoryIsolation";

const root = mkdtempSync(path.join(tmpdir(), "company-checkout-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "QA", GIT_AUTHOR_EMAIL: "qa@invalid", GIT_COMMITTER_NAME: "QA", GIT_COMMITTER_EMAIL: "qa@invalid" };
const git = (args: string[], input?: string | Buffer) => execFileSync("git", args, { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const run = (command: string) => { const result = spawnSync("sh", ["-c", command], { env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }); if (result.status !== 0) throw Error(result.stderr); return result.stdout; };
const source = path.join(root, "qa", "companies.git");
const binding = { kind: "git-subdirectory" as const, origin: "https://fixture.invalid", owner: "qa", repository: "companies", ref: "main", path: "companies/chipsage" };
const input = { binding, repositoryOrigin: `file://${root}` };
try {
  mkdirSync(path.dirname(source), { recursive: true }); git(["init", "-b", "main", source]);
  const file = (slug: string, name: string, value: string) => { const target = path.join(source, "companies", slug, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, value); };
  const save = () => { git(["-C", source, "add", "."]); git(["-C", source, "commit", "-m", "fixture update"]); };
  const project = () => {
    const tree = git(["-C", source, "rev-parse", "HEAD:companies/chipsage"]);
    const group = git(["-C", source, "mktree"], `040000 tree ${tree}\tchipsage\n`);
    const top = git(["-C", source, "mktree"], `040000 tree ${group}\tcompanies\n`);
    const old = spawnSync("git", ["-C", source, "rev-parse", "--verify", "workspaces/chipsage"], { encoding: "utf8" });
    const commit = git(["-C", source, "commit-tree", top, ...(old.status === 0 ? ["-p", old.stdout.trim()] : []), "-m", "company fixture"]);
    git(["-C", source, "update-ref", "refs/heads/workspaces/chipsage", commit]);
  };
  file("chipsage", "analysis/overview.md", "Original overview\n"); file("wonder", "analysis/overview.md", "Other company\n"); save(); project();
  git(["-C", source, "config", "uploadpack.allowFilter", "true"]);
  const legacy = path.join(root, "legacy"); run(makeRepositoryCheckoutPlan({ ...input, checkoutRoot: legacy }).command);
  const verifiedCommit = git(["-C", legacy, "rev-parse", "HEAD"]);
  writeFileSync(path.join(legacy, binding.path, "analysis/overview.md"), "Unpublished analyst draft\n");
  writeFileSync(path.join(legacy, binding.path, "notes.md"), "Untracked analyst notes\n");
  git(["-C", legacy, "add", "."]); git(["-C", legacy, "commit", "-m", "Unpublished local analyst commit"]);
  writeFileSync(path.join(legacy, binding.path, "untracked.md"), "Untracked after local commit\n");
  file("chipsage", "analysis/new-source.md", "New verified source\n"); save(); project();
  const missing = git(["-C", source, "rev-parse", "HEAD:companies/wonder"]);
  rmSync(path.join(source, ".git", "objects", missing.slice(0, 2), missing.slice(2)));
  const globalAttempt = spawnSync("sh", ["-c", makeRepositoryCheckoutPlan({ ...input, checkoutRoot: path.join(root, "global-fails") }).command], { env, encoding: "utf8" });
  assert.notEqual(globalAttempt.status, 0);
  const fresh = path.join(root, "fresh"); run(makeRepositoryCheckoutPlan({ ...input, checkoutRoot: fresh, companyOnly: true }).command);
  assert.equal(readFileSync(path.join(fresh, binding.path, "analysis/new-source.md"), "utf8"), "New verified source\n");
  run(makeRepositoryIsolationPlan({ ...input, checkoutRoot: legacy, verifiedCommit }).command);
  assert.equal(readFileSync(path.join(legacy, binding.path, "analysis/overview.md"), "utf8"), "Unpublished analyst draft\n");
  assert.equal(readFileSync(path.join(legacy, binding.path, "notes.md"), "utf8"), "Untracked analyst notes\n");
  assert.equal(readFileSync(path.join(legacy, binding.path, "analysis/new-source.md"), "utf8"), "New verified source\n");
  assert.equal(readFileSync(path.join(legacy, binding.path, "untracked.md"), "utf8"), "Untracked after local commit\n");
  run(makeRepositoryRefreshPlan({ ...input, checkoutRoot: legacy, companyOnly: true }).command);
  assert.equal(readFileSync(path.join(legacy, binding.path, "analysis/overview.md"), "utf8"), "Unpublished analyst draft\n");
  const verifiedCompany = git(["-C", legacy, "rev-parse", "HEAD"]);
  git(["-C", legacy, "add", "."]); git(["-C", legacy, "commit", "-m", "Local commit on isolated checkout"]);
  run(makeVerifiedRepositoryRefreshPlan({ ...input, checkoutRoot: legacy, companyOnly: true, verifiedCommit: verifiedCompany }).command);
  assert.equal(readFileSync(path.join(legacy, binding.path, "analysis/overview.md"), "utf8"), "Unpublished analyst draft\n");
  assert.equal(git(["-C", legacy, "rev-parse", "HEAD"]), verifiedCompany);
  console.log("PASS: missing sibling cannot block isolated checkout; legacy draft/untracked preservation; subsequent refresh");
} finally { rmSync(root, { recursive: true, force: true }); }
