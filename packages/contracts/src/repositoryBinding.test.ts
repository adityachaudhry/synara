import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ExternalProjectKey, ProjectRepositoryBinding } from "./repositoryBinding";

const decodeBinding = Schema.decodeUnknownSync(ProjectRepositoryBinding);

const validBinding = {
  kind: "git-subdirectory",
  origin: "https://git.example.com",
  owner: "acme-platform",
  repository: "company-data",
  ref: "refs/heads/main",
  path: "companies/cue-cloud",
} as const;

describe("ProjectRepositoryBinding", () => {
  it("decodes a canonical provider-neutral git subdirectory binding", () => {
    expect(decodeBinding(validBinding)).toEqual(validBinding);
  });

  it.each([
    ["credentials in origin", { ...validBinding, origin: "https://token@git.example.com" }],
    ["HTTP origin", { ...validBinding, origin: "http://git.example.com" }],
    ["origin query", { ...validBinding, origin: "https://git.example.com?token=secret" }],
    ["origin fragment", { ...validBinding, origin: "https://git.example.com#fragment" }],
    ["origin path", { ...validBinding, origin: "https://git.example.com/api" }],
    ["non-canonical origin", { ...validBinding, origin: "https://GIT.example.com" }],
    ["traversing owner", { ...validBinding, owner: "../admin" }],
    ["repository path", { ...validBinding, repository: "team/company-data" }],
    ["leading-dash ref", { ...validBinding, ref: "-dangerous" }],
    ["double-dot ref", { ...validBinding, ref: "main..other" }],
    ["double-slash ref", { ...validBinding, ref: "refs//heads/main" }],
    ["reflog ref", { ...validBinding, ref: "main@{1}" }],
    ["absolute path", { ...validBinding, path: "/companies/cue-cloud" }],
    ["dot segment", { ...validBinding, path: "companies/./cue-cloud" }],
    ["parent segment", { ...validBinding, path: "companies/../secrets" }],
    ["empty segment", { ...validBinding, path: "companies//cue-cloud" }],
    ["trailing slash", { ...validBinding, path: "companies/cue-cloud/" }],
    ["backslash", { ...validBinding, path: "companies\\cue-cloud" }],
    ["encoded traversal", { ...validBinding, path: "companies/%2e%2e/secrets" }],
    ["git metadata path", { ...validBinding, path: "companies/cue-cloud.git" }],
    ["empty path", { ...validBinding, path: "" }],
    ["silently trimmed path", { ...validBinding, path: " companies/cue-cloud " }],
  ])("rejects %s", (_label, binding) => {
    expect(() => decodeBinding(binding)).toThrow();
  });
});

describe("ExternalProjectKey", () => {
  const decodeExternalKey = Schema.decodeUnknownSync(ExternalProjectKey);

  it("keeps an exact service-owned stable key", () => {
    expect(decodeExternalKey("host-company:company-123")).toBe("host-company:company-123");
  });

  it.each(["", "   ", " host-company:company-123", "host-company:company-123 "])(
    "rejects a non-canonical key %j",
    (key) => expect(() => decodeExternalKey(key)).toThrow(),
  );
});
