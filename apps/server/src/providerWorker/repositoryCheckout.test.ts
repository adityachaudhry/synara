import { describe, expect, it } from "vitest";

import {
  makeRepositoryCredentialConfig,
  makeRepositoryCheckoutPlan,
  parseRepositoryCheckoutResult,
  REPOSITORY_CREDENTIAL_CONFIG_PATH,
} from "./repositoryCheckout";

const binding = {
  kind: "git-subdirectory" as const,
  origin: "https://git.example.com",
  owner: "acme",
  repository: "portfolio",
  ref: "main",
  path: "companies/acme",
};

describe("makeRepositoryCheckoutPlan", () => {
  it("builds a sparse checkout from the admitted generic binding without embedding credentials", () => {
    const plan = makeRepositoryCheckoutPlan({
      binding,
      credentialConfigPath: REPOSITORY_CREDENTIAL_CONFIG_PATH,
    });

    expect(plan.cwd).toBe("/workspace/repository/companies/acme");
    expect(plan.command).toContain("https://git.example.com/acme/portfolio.git");
    expect(plan.command).not.toContain("repository-secret");
    expect(plan.command).not.toContain("SYNARA_PROVIDER_WORKER_REPOSITORY_AUTHORIZATION");
    expect(plan.command).toContain("checkout --detach FETCH_HEAD");
    expect(plan.environment).toEqual({});
    const credential = makeRepositoryCredentialConfig(binding, "token repository-secret");
    expect(credential).toContain("repository-secret");
    expect(credential).toContain('https://git.example.com/');
  });

  it("does not add an authorization header when no server-owned credential is configured", () => {
    const plan = makeRepositoryCheckoutPlan({ binding });

    expect(plan.command).not.toContain("SYNARA_PROVIDER_WORKER_REPOSITORY_AUTHORIZATION");
    expect(plan.environment).toEqual({});
  });
});

describe("parseRepositoryCheckoutResult", () => {
  it("returns the immutable commit and partial-clone mode", () => {
    expect(
      parseRepositoryCheckoutResult(
        "__SYNARA_CHECKOUT_MODE__=partial\n__SYNARA_CHECKOUT_COMMIT__=0123456789abcdef0123456789abcdef01234567\n",
      ),
    ).toEqual({
      commit: "0123456789abcdef0123456789abcdef01234567",
      checkoutMode: "partial",
    });
  });
});
