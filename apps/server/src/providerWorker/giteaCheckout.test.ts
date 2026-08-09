import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ProjectRepositoryBinding } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  makeGiteaCheckoutPlan,
  makeGiteaCheckoutRefreshPlan,
  parseGiteaCheckoutCommit,
  parseGiteaCheckoutRefreshResult,
  parseGiteaCheckoutResult,
} from "./giteaCheckout";

const binding: ProjectRepositoryBinding = {
  kind: "gitea-subdirectory",
  origin: "https://glasswing-gitea-dev.up.railway.app",
  owner: "glasswing-admin",
  repository: "glasswing-company-data",
  ref: "main",
  path: "companies/cue-cloud",
};

const repository = {
  origin: binding.origin,
  owner: binding.owner,
  repository: binding.repository,
  ref: binding.ref,
  companiesRoot: "companies",
  readToken: "super-secret-token",
} as const;

describe("makeGiteaCheckoutPlan", () => {
  it("builds a credential-free sparse checkout plan for the selected company", () => {
    const plan = makeGiteaCheckoutPlan({
      binding,
      repository,
    });

    expect(plan.cwd).toBe("/workspace/repository/companies/cue-cloud");
    expect(plan.command).toContain("https://glasswing-gitea-dev.up.railway.app/glasswing-admin/glasswing-company-data.git");
    expect(plan.command).toContain("sparse-checkout init --cone");
    expect(plan.command).toContain("sparse-checkout set 'companies/cue-cloud'");
    expect(plan.command).toContain("$SYNARA_GITEA_CHECKOUT_TOKEN");
    expect(plan.command).not.toContain("super-secret-token");
    expect(plan.command).not.toContain("remote add");
    expect(plan.command).not.toContain("core.sparseCheckout=true");
    expect(plan.command).toContain("checkout --detach FETCH_HEAD");
    expect(plan.command).toContain("fetch --depth=1 --no-tags --filter=blob:none");
    expect(plan.command).toContain("fetch --depth=1 --no-tags");
    expect(plan.command).toContain("__SYNARA_CHECKOUT_MODE__=partial");
    expect(plan.command).toContain("__SYNARA_CHECKOUT_MODE__=shallow");
  });

  it("hydrates nested company materials, updates them, then takes the unchanged fast path", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "synara-gitea-refresh-"));
    const sourceRoot = path.join(fixtureRoot, "source");
    const remoteRoot = path.join(fixtureRoot, "remote");
    const bareRepository = path.join(
      remoteRoot,
      binding.owner,
      `${binding.repository}.git`,
    );
    const checkoutRoot = path.join(fixtureRoot, "checkout");
    const companyRoot = path.join(sourceRoot, binding.path);

    mkdirSync(path.join(companyRoot, "materials", "diligence"), { recursive: true });
    mkdirSync(path.join(sourceRoot, "companies", "another-company"), { recursive: true });
    mkdirSync(path.dirname(bareRepository), { recursive: true });
    writeFileSync(path.join(companyRoot, "company.json"), '{"name":"Cue Cloud"}\n');
    writeFileSync(
      path.join(companyRoot, "materials", "diligence", "nested.md"),
      "first version\n",
    );
    writeFileSync(
      path.join(sourceRoot, "companies", "another-company", "company.json"),
      '{"name":"Another Company"}\n',
    );

    runGit(["init", "--initial-branch=main", sourceRoot]);
    runGit(["-C", sourceRoot, "config", "user.email", "synara@example.test"]);
    runGit(["-C", sourceRoot, "config", "user.name", "Synara Test"]);
    runGit(["-C", sourceRoot, "add", "."]);
    runGit(["-C", sourceRoot, "commit", "-m", "initial company materials"]);
    runGit(["init", "--bare", bareRepository]);
    runGit(["-C", sourceRoot, "remote", "add", "origin", bareRepository]);
    runGit(["-C", sourceRoot, "push", "origin", "main"]);

    const fixtureBinding: ProjectRepositoryBinding = {
      ...binding,
      origin: pathToFileURL(remoteRoot).href.replace(/\/$/u, ""),
    };
    const fixtureRepository = {
      ...repository,
      origin: fixtureBinding.origin,
      readToken: "fixture-token",
    };
    const checkoutPlan = makeGiteaCheckoutPlan({
      binding: fixtureBinding,
      repository: fixtureRepository,
      checkoutRoot,
    });
    const checkoutOutput = runPlan(checkoutPlan.command, checkoutPlan.environment);

    expect(parseGiteaCheckoutResult(checkoutOutput).commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(
      readFileSync(
        path.join(checkoutRoot, binding.path, "materials", "diligence", "nested.md"),
        "utf8",
      ),
    ).toBe("first version\n");
    expect(
      readFileSync(path.join(checkoutRoot, binding.path, "company.json"), "utf8"),
    ).toContain("Cue Cloud");
    expect(() =>
      readFileSync(
        path.join(checkoutRoot, "companies", "another-company", "company.json"),
        "utf8",
      ),
    ).toThrow();

    writeFileSync(
      path.join(companyRoot, "materials", "diligence", "nested.md"),
      "second version\n",
    );
    mkdirSync(path.join(companyRoot, "materials", "financials", "quarterly"), {
      recursive: true,
    });
    writeFileSync(
      path.join(companyRoot, "materials", "financials", "quarterly", "q2.txt"),
      "nested update\n",
    );
    runGit(["-C", sourceRoot, "add", "."]);
    runGit(["-C", sourceRoot, "commit", "-m", "update nested company materials"]);
    runGit(["-C", sourceRoot, "push", "origin", "main"]);

    const refreshPlan = makeGiteaCheckoutRefreshPlan({
      binding: fixtureBinding,
      repository: fixtureRepository,
      checkoutRoot,
    });
    const updatedOutput = runPlan(refreshPlan.command, refreshPlan.environment);
    const updated = parseGiteaCheckoutRefreshResult(updatedOutput);

    expect(updated.outcome).toBe("updated");
    expect(updated.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(
      readFileSync(
        path.join(checkoutRoot, binding.path, "materials", "financials", "quarterly", "q2.txt"),
        "utf8",
      ),
    ).toBe("nested update\n");
    expect(
      readFileSync(
        path.join(checkoutRoot, binding.path, "materials", "diligence", "nested.md"),
        "utf8",
      ),
    ).toBe("second version\n");

    const unchangedOutput = runPlan(refreshPlan.command, refreshPlan.environment);
    expect(parseGiteaCheckoutRefreshResult(unchangedOutput)).toMatchObject({
      outcome: "unchanged",
      commit: updated.commit,
    });
    expect(unchangedOutput).not.toContain("__SYNARA_CHECKOUT_MODE__=");
  });

  it("rejects a binding outside the configured repository", () => {
    expect(() =>
      makeGiteaCheckoutPlan({
        binding: { ...binding, repository: "another-repository" },
        repository,
      }),
    ).toThrow(/does not match/);
  });
});

function runGit(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function runPlan(command: string, environment: Readonly<Record<string, string>>): string {
  return execFileSync("sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

describe("parseGiteaCheckoutCommit", () => {
  it("extracts the immutable checked-out commit marker", () => {
    expect(
      parseGiteaCheckoutCommit(
        "some output\n__SYNARA_CHECKOUT_COMMIT__=0123456789abcdef0123456789abcdef01234567\n",
      ),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("fails when checkout output has no commit marker", () => {
    expect(() => parseGiteaCheckoutCommit("checkout finished")).toThrow(/commit marker/);
  });
});

describe("parseGiteaCheckoutResult", () => {
  it("reports whether the server accepted the blobless partial clone", () => {
    expect(
      parseGiteaCheckoutResult(
        "__SYNARA_CHECKOUT_MODE__=partial\n__SYNARA_CHECKOUT_COMMIT__=0123456789abcdef0123456789abcdef01234567\n",
      ),
    ).toEqual({
      commit: "0123456789abcdef0123456789abcdef01234567",
      checkoutMode: "partial",
    });
  });
});
