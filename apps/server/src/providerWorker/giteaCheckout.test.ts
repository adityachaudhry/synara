import type { ProjectRepositoryBinding } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { makeGiteaCheckoutPlan, parseGiteaCheckoutCommit } from "./giteaCheckout";

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
    expect(plan.command).toContain("/companies/cue-cloud/");
    expect(plan.command).toContain("$SYNARA_GITEA_CHECKOUT_TOKEN");
    expect(plan.command).not.toContain("super-secret-token");
    expect(plan.command).not.toContain("remote add");
    expect(plan.command).not.toContain("config core.sparseCheckout");
    expect(plan.command).toContain("-c core.sparseCheckout=true checkout --detach FETCH_HEAD");
    expect(plan.command).toContain(
      "fetch --depth=1 'https://glasswing-gitea-dev.up.railway.app/glasswing-admin/glasswing-company-data.git' 'main'",
    );
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
