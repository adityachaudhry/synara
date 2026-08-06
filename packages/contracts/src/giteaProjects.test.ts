import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  GiteaCompanyCatalogSnapshot,
  GiteaSubdirectoryProjectBinding,
} from "./giteaProjects";
import { WebSocketRequest } from "./ws";

const decodeBinding = Schema.decodeUnknownSync(GiteaSubdirectoryProjectBinding);
const decodeCatalog = Schema.decodeUnknownSync(GiteaCompanyCatalogSnapshot);

const validBinding = {
  kind: "gitea-subdirectory",
  origin: "https://glasswing-gitea-dev.up.railway.app",
  owner: "glasswing-admin",
  repository: "glasswing-company-data",
  ref: "main",
  path: "companies/cue-cloud",
} as const;

describe("GiteaSubdirectoryProjectBinding", () => {
  it("decodes a non-secret company subdirectory binding", () => {
    expect(decodeBinding(validBinding)).toEqual(validBinding);
  });

  it.each([
    { ...validBinding, origin: "https://token@example.com" },
    { ...validBinding, origin: "http://example.com" },
    { ...validBinding, owner: "../admin" },
    { ...validBinding, repository: "company/data" },
    { ...validBinding, ref: "-dangerous" },
    { ...validBinding, path: "/companies/cue-cloud" },
    { ...validBinding, path: "companies/../secrets" },
    { ...validBinding, path: "other/cue-cloud" },
  ])("rejects an unsafe binding %#", (binding) => {
    expect(() => decodeBinding(binding)).toThrow();
  });
});

describe("GiteaCompanyCatalogSnapshot", () => {
  it("decodes a safe browser catalog without credentials", () => {
    expect(
      decodeCatalog({
        available: true,
        projects: [
          {
            companyId: "company-cue-cloud",
            companyName: "Cue Cloud",
            companySlug: "cue-cloud",
            workspaceRoot: "/data/gitea-company-projects/cue-cloud",
            binding: validBinding,
          },
        ],
        diagnostics: [],
        refreshedAt: "2026-08-06T12:00:00.000Z",
      }),
    ).toMatchObject({ available: true, projects: [{ companyName: "Cue Cloud" }] });
  });

  it("decodes a disabled catalog without inventing projects", () => {
    expect(
      decodeCatalog({
        available: false,
        projects: [],
        diagnostics: ["Gitea company catalog is not configured."],
        refreshedAt: "2026-08-06T12:00:00.000Z",
      }),
    ).toMatchObject({ available: false, projects: [] });
  });
});

it("accepts the company catalog WebSocket request", () => {
  const request = Schema.decodeUnknownSync(WebSocketRequest)({
    type: "request",
    id: "request-company-catalog",
    body: { _tag: "projects.listGiteaCompanies" },
  });

  expect(request.body._tag).toBe("projects.listGiteaCompanies");
});
