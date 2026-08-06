import type { ProjectRepositoryBinding } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeGiteaCompanyCatalog } from "./GiteaCompanyCatalog";
import type { GiteaCompanyCatalogConfig } from "../config";

const config: Extract<GiteaCompanyCatalogConfig, { enabled: true }> = {
  enabled: true,
  origin: "https://glasswing-gitea-dev.up.railway.app",
  owner: "glasswing-admin",
  repository: "glasswing-company-data",
  ref: "main",
  companiesRoot: "companies",
  readUser: "synara-read",
  readToken: "secret-token",
  projectRoot: "/data/gitea-company-projects",
};

function contentResponse(value: unknown): Response {
  return Response.json({
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  });
}

describe("GiteaCompanyCatalog", () => {
  it("reports an unavailable catalog when configuration is disabled", async () => {
    const catalog = makeGiteaCompanyCatalog({
      config: { enabled: false },
      fetch: async () => {
        throw new Error("disabled catalog must not access the network");
      },
      now: () => Date.parse("2026-08-06T12:00:00.000Z"),
    });

    await expect(Effect.runPromise(catalog.list())).resolves.toEqual({
      available: false,
      projects: [],
      diagnostics: ["Gitea company catalog is not configured."],
      refreshedAt: "2026-08-06T12:00:00.000Z",
    });
  });

  it("lists sorted company descriptors, falls back for malformed metadata, and reuses its cache", async () => {
    const requests: string[] = [];
    let active = 0;
    let maxActive = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(url);
      expect(new Headers(init?.headers).get("authorization")).toBe("token secret-token");
      if (url.includes("/contents/companies?")) {
        return Response.json([
          { type: "dir", name: "zeta", path: "companies/zeta" },
          { type: "file", name: "README.md", path: "companies/README.md" },
          { type: "dir", name: "alpha", path: "companies/alpha" },
          { type: "dir", name: "broken", path: "companies/broken" },
        ]);
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      if (url.includes("/alpha/company.json")) {
        return contentResponse({
          company_id: "company-alpha",
          company_name: "Alpha Inc",
          company_slug: "alpha",
        });
      }
      if (url.includes("/zeta/company.json")) {
        return contentResponse({
          company_id: "company-zeta",
          company_name: "Zeta Labs",
          company_slug: "zeta",
        });
      }
      return contentResponse({ company_name: "Missing identity" });
    };
    const catalog = makeGiteaCompanyCatalog({
      config,
      fetch: fetcher,
      now: () => Date.parse("2026-08-06T12:00:00.000Z"),
      cacheTtlMs: 60_000,
      concurrency: 2,
    });

    const first = await Effect.runPromise(catalog.list());
    const second = await Effect.runPromise(catalog.list());

    expect(first.projects.map((project) => project.companyName)).toEqual([
      "Alpha Inc",
      "Broken",
      "Zeta Labs",
    ]);
    expect(first.projects[0]).toMatchObject({
      workspaceRoot: "/data/gitea-company-projects/alpha",
      binding: { path: "companies/alpha", origin: config.origin },
    });
    expect(first.projects[1]).toMatchObject({
      companySlug: "broken",
      binding: { path: "companies/broken" },
    });
    expect(first.diagnostics).toEqual([
      "Using directory fallback for companies/broken: invalid company.json metadata.",
    ]);
    expect(second).toEqual(first);
    expect(requests).toHaveLength(4);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("fails the catalog refresh when a company metadata request has a systemic HTTP error", async () => {
    const catalog = makeGiteaCompanyCatalog({
      config,
      fetch: async (input) =>
        String(input).includes("/contents/companies?")
          ? Response.json([{ type: "dir", name: "cue-cloud", path: "companies/cue-cloud" }])
          : new Response("unavailable", { status: 503 }),
    });

    await expect(Effect.runPromise(catalog.list())).rejects.toMatchObject({
      _tag: "GiteaCompanyCatalogError",
      operation: "fetch",
    });
  });

  it("canonicalizes an allowed binding and rejects repository tampering", async () => {
    const catalog = makeGiteaCompanyCatalog({
      config,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/contents/companies?")) {
          return Response.json([{ type: "dir", name: "cue-cloud", path: "companies/cue-cloud" }]);
        }
        return contentResponse({
          company_id: "company-cue-cloud",
          company_name: "Cue Cloud",
          company_slug: "cue-cloud",
        });
      },
      now: () => Date.parse("2026-08-06T12:00:00.000Z"),
    });
    const requested: ProjectRepositoryBinding = {
      kind: "gitea-subdirectory",
      origin: config.origin,
      owner: config.owner,
      repository: config.repository,
      ref: config.ref,
      path: "companies/cue-cloud",
    };

    await expect(Effect.runPromise(catalog.validateBinding(requested))).resolves.toEqual(requested);
    await expect(Effect.runPromise(catalog.resolveBinding(requested))).resolves.toMatchObject({
      companyName: "Cue Cloud",
      workspaceRoot: "/data/gitea-company-projects/cue-cloud",
    });
    await expect(
      Effect.runPromise(catalog.validateBinding({ ...requested, repository: "other-data" })),
    ).rejects.toMatchObject({ _tag: "GiteaCompanyCatalogError" });
  });
});
