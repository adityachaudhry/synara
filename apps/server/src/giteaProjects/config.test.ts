import { describe, expect, it } from "vitest";

import { resolveGiteaCompanyCatalogConfig } from "./config";

const completeEnvironment = {
  SYNARA_GITEA_ORIGIN: "https://glasswing-gitea-dev.up.railway.app",
  SYNARA_GITEA_OWNER: "glasswing-admin",
  SYNARA_GITEA_REPOSITORY: "glasswing-company-data",
  SYNARA_GITEA_REF: "main",
  SYNARA_GITEA_COMPANIES_ROOT: "companies",
  SYNARA_GITEA_READ_USER: "synara-read",
  SYNARA_GITEA_READ_TOKEN: "secret-token",
  SYNARA_GITEA_PROJECT_ROOT: "/data/gitea-company-projects",
} as const;

describe("resolveGiteaCompanyCatalogConfig", () => {
  it("is disabled when no Gitea catalog variables are present", () => {
    expect(resolveGiteaCompanyCatalogConfig({ environment: {} })).toEqual({ enabled: false });
  });

  it("parses a complete catalog configuration", () => {
    expect(
      resolveGiteaCompanyCatalogConfig({ environment: completeEnvironment }),
    ).toEqual({
      enabled: true,
      origin: "https://glasswing-gitea-dev.up.railway.app",
      owner: "glasswing-admin",
      repository: "glasswing-company-data",
      ref: "main",
      companiesRoot: "companies",
      readUser: "synara-read",
      readToken: "secret-token",
      projectRoot: "/data/gitea-company-projects",
    });
  });

  it.each([
    ["SYNARA_GITEA_ORIGIN", "http://example.com"],
    ["SYNARA_GITEA_ORIGIN", "https://token@example.com"],
    ["SYNARA_GITEA_OWNER", "../admin"],
    ["SYNARA_GITEA_REPOSITORY", "owner/repo"],
    ["SYNARA_GITEA_REF", "-dangerous"],
    ["SYNARA_GITEA_COMPANIES_ROOT", "../companies"],
    ["SYNARA_GITEA_PROJECT_ROOT", "relative/projects"],
  ])("rejects unsafe %s", (key, value) => {
    expect(() =>
      resolveGiteaCompanyCatalogConfig({
        environment: { ...completeEnvironment, [key]: value },
      }),
    ).toThrow();
  });

  it("fails startup when any configured catalog variable is missing", () => {
    const { SYNARA_GITEA_READ_TOKEN: _, ...incomplete } = completeEnvironment;
    expect(() => resolveGiteaCompanyCatalogConfig({ environment: incomplete })).toThrow(
      "SYNARA_GITEA_READ_TOKEN",
    );
  });

  it("rejects a companies root that cannot be represented by repository bindings", () => {
    expect(() =>
      resolveGiteaCompanyCatalogConfig({
        environment: { ...completeEnvironment, SYNARA_GITEA_COMPANIES_ROOT: "portfolio" },
      }),
    ).toThrow("must be exactly 'companies'");
  });
});
